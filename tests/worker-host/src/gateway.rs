//! Owned local TLS gateway, fixed read-only RPC methods, no signer or mutations.
use crate::LocalSandbox;
use anyhow::{Result, ensure};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper_util::rt::TokioIo;
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::{
    net::TcpListener,
    task::{JoinHandle, JoinSet},
};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{
        ServerConfig,
        pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer},
    },
};
pub struct Gateway {
    config: LocalSandbox,
    task: JoinHandle<()>,
}
fn upstream(url: &str) -> Result<http::Uri> {
    let uri: http::Uri = url.parse()?;
    ensure!(
        uri.scheme_str() == Some("http") && uri.path_and_query().is_none_or(|p| p.as_str() == "/"),
        "RPC URL must be plain HTTP loopback root"
    );
    let authority = uri
        .authority()
        .ok_or_else(|| anyhow::anyhow!("RPC authority missing"))?;
    ensure!(
        !authority.as_str().contains('@'),
        "RPC credentials forbidden"
    );
    let ip: IpAddr = uri
        .host()
        .ok_or_else(|| anyhow::anyhow!("RPC host missing"))?
        .trim_matches(['[', ']'])
        .parse()?;
    ensure!(
        ip.is_loopback() && uri.port_u16().is_some(),
        "RPC must use numeric loopback and explicit port"
    );
    Ok(uri)
}
impl Gateway {
    pub async fn start(rpc_url: &str, owned_near_unix_seconds: u64) -> Result<Self> {
        let rpc = upstream(rpc_url)?;
        let rcgen::CertifiedKey { cert, signing_key } = rcgen::generate_simple_self_signed(vec![
            "ethereum-sepolia-rpc.publicnode.com".into(),
            "eth-sepolia.g.alchemy.com".into(),
        ])?;
        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.der().clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(signing_key.serialize_der())),
            )?;
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let config = LocalSandbox {
            tls_address: listener.local_addr()?,
            ca_der: cert.der().to_vec(),
            owned_near_unix_seconds,
        };
        let task = tokio::spawn(async move {
            let mut clients = JoinSet::new();
            loop {
                let accepted = tokio::select! {
                    accepted=listener.accept()=> match accepted {Ok((socket,_))=>Some(socket),Err(_)=>break},
                    _=clients.join_next(),if !clients.is_empty()=>None,
                };
                if let Some(socket) = accepted {
                    if clients.len() >= 16 {
                        drop(socket);
                        continue;
                    }
                    let acceptor = acceptor.clone();
                    let rpc = rpc.clone();
                    clients.spawn(async move {
                        let Ok(stream) = acceptor.accept(socket).await else {
                            return;
                        };
                        let service = hyper::service::service_fn(move |request| {
                            forward(request, rpc.clone())
                        });
                        let _ = tokio::time::timeout(
                            Duration::from_secs(15),
                            hyper::server::conn::http1::Builder::new()
                                .serve_connection(TokioIo::new(stream), service),
                        )
                        .await;
                    });
                }
            }
        });
        Ok(Self { config, task })
    }
    pub fn adapter(&self) -> LocalSandbox {
        self.config.clone()
    }
    pub async fn shutdown(mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}
impl Drop for Gateway {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn forward(
    request: http::Request<hyper::body::Incoming>,
    rpc: http::Uri,
) -> Result<http::Response<Full<Bytes>>, std::convert::Infallible> {
    let response = forward_checked(request, rpc).await.unwrap_or_else(|_| {
        http::Response::builder()
            .status(403)
            .body(Full::new(Bytes::from_static(b"denied")))
            .unwrap()
    });
    Ok(response)
}
async fn forward_checked(
    request: http::Request<hyper::body::Incoming>,
    rpc: http::Uri,
) -> Result<http::Response<Full<Bytes>>> {
    let host = request.headers().get("host").and_then(|v| v.to_str().ok());
    ensure!(
        request.method() == http::Method::POST
            && request
                .headers()
                .get("content-type")
                .is_some_and(|v| v == "application/json")
            && matches!(
                (host, request.uri().path_and_query().map(|p| p.as_str())),
                (Some("ethereum-sepolia-rpc.publicnode.com"), Some("/"))
                    | (
                        Some("eth-sepolia.g.alchemy.com"),
                        Some("/v2/proofcredit-local-test-key")
                    )
            ),
        "gateway destination denied"
    );
    let bytes = Limited::new(request.into_body(), 32768)
        .collect()
        .await
        .map_err(anyhow::Error::from_boxed)?
        .to_bytes();
    let q: serde_json::Value = serde_json::from_slice(&bytes)?;
    ensure!(
        q.is_object()
            && q["jsonrpc"] == "2.0"
            && q["params"].is_array()
            && matches!(
                q["method"].as_str(),
                Some(
                    "eth_chainId"
                        | "eth_getBlockByNumber"
                        | "eth_getTransactionByHash"
                        | "eth_getTransactionReceipt"
                )
            ),
        "gateway read-only method denied"
    );
    let address = SocketAddr::new(
        rpc.host().unwrap().trim_matches(['[', ']']).parse()?,
        rpc.port_u16().unwrap(),
    );
    let socket = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::net::TcpStream::connect(address),
    )
    .await??;
    let (mut sender, connection) =
        hyper::client::conn::http1::handshake(TokioIo::new(socket)).await?;
    let request = http::Request::builder()
        .method("POST")
        .uri("/")
        .header("host", rpc.authority().unwrap().as_str())
        .header("content-type", "application/json")
        .body(Full::new(bytes))?;
    let send = async move {
        let response = sender.send_request(request).await?;
        ensure!(response.status() == 200, "upstream status rejected");
        let bytes = Limited::new(response.into_body(), 262145)
            .collect()
            .await
            .map_err(anyhow::Error::from_boxed)?
            .to_bytes();
        Ok::<_, anyhow::Error>(http::Response::new(Full::new(bytes)))
    };
    tokio::pin!(send);
    tokio::pin!(connection);
    tokio::time::timeout(Duration::from_secs(10), async {
        tokio::select! {r=&mut send=>r,r=&mut connection=>{r?;send.await}}
    })
    .await?
}

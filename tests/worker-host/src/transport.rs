//! The loopback adapter follows Wasmtime 50.0.1 default_send_request framing.
use anyhow::{Result, ensure};
use http_body_util::BodyExt;
use hyper_util::rt::TokioIo;
use std::{
    future::poll_fn,
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    task::Poll,
    time::Duration,
};
use wasmtime_wasi_http::{Error, RequestOptions, WasiBody, WasiHttpHooks};
#[derive(Clone)]
pub enum Adapter {
    Production,
    LocalSandbox(LocalSandbox),
}
#[derive(Clone)]
pub struct LocalSandbox {
    pub tls_address: SocketAddr,
    pub ca_der: Vec<u8>,
    pub owned_near_unix_seconds: u64,
}
pub type IoFuture = Box<dyn Future<Output = Result<(), Error>> + Send>;
pub type SendFuture =
    Box<dyn Future<Output = Result<(http::Response<WasiBody>, IoFuture), Error>> + Send>;
#[derive(Clone, Default)]
pub struct Trace {
    pub destinations: Arc<Mutex<Vec<String>>>,
    pub active_connections: Arc<AtomicUsize>,
    pub gated_requests: Arc<AtomicUsize>,
    pub clean_completions_before_response: Arc<AtomicUsize>,
}
pub struct Hooks {
    adapter: Adapter,
    pub trace: Trace,
    gate: Duration,
    tiny: bool,
}
impl Hooks {
    pub fn new(adapter: Adapter) -> Result<Self> {
        if let Adapter::LocalSandbox(c) = &adapter {
            ensure!(
                c.tls_address.ip().is_loopback(),
                "local TLS address must be loopback"
            );
            ensure!(!c.ca_der.is_empty(), "local CA missing");
        }
        Ok(Self {
            adapter,
            trace: Trace::default(),
            gate: Duration::ZERO,
            tiny: false,
        })
    }
    /// Explicit test-only write-pressure seam; never selectable in Production CLI.
    #[cfg(feature = "test-hooks")]
    pub fn with_write_gate(mut self, duration: Duration) -> Self {
        self.gate = duration;
        self.tiny = true;
        self
    }
}
pub fn allowed(request: &http::Request<WasiBody>) -> bool {
    request.method() == http::Method::POST
        && request.uri().scheme_str() == Some("https")
        && matches!(
            (
                request.uri().authority().map(|a| a.as_str()),
                request.uri().path_and_query().map(|p| p.as_str())
            ),
            (Some("ethereum-sepolia-rpc.publicnode.com"), Some("/"))
                | (Some("public.1rpc.io"), Some("/sepolia"))
        )
        && request
            .headers()
            .get("content-type")
            .is_some_and(|v| v == "application/json")
}
impl WasiHttpHooks for Hooks {
    fn p2_outgoing_body_buffer_chunks(&mut self) -> usize {
        1
    }
    fn p2_outgoing_body_chunk_size(&mut self) -> usize {
        if self.tiny { 1 } else { 1024 * 1024 }
    }
    fn send_request(
        &mut self,
        request: http::Request<WasiBody>,
        options: Option<RequestOptions>,
        _: IoFuture,
    ) -> SendFuture {
        if !allowed(&request) {
            return Box::new(async { Err(Error::HttpRequestDenied) });
        }
        self.trace
            .destinations
            .lock()
            .unwrap()
            .push(request.uri().to_string());
        let adapter = self.adapter.clone();
        let trace = self.trace.clone();
        let gate = self.gate;
        Box::new(async move {
            if matches!(adapter, Adapter::Production) {
                let (res, io) = wasmtime_wasi_http::default_send_request(request, options).await?;
                return Ok((res.map(BodyExt::boxed_unsync), Box::new(io) as IoFuture));
            }
            let Adapter::LocalSandbox(config) = adapter else {
                unreachable!()
            };
            let timeout = options
                .and_then(|o| o.connect_timeout)
                .unwrap_or(Duration::from_secs(10));
            let host = request
                .uri()
                .host()
                .ok_or(Error::HttpRequestUriInvalid)?
                .to_owned();
            let mut roots = rustls::RootCertStore::empty();
            roots
                .add(rustls::pki_types::CertificateDer::from(config.ca_der))
                .map_err(|_| Error::HttpRequestDenied)?;
            let tls = rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth();
            let connector = tokio_rustls::TlsConnector::from(Arc::new(tls));
            let socket =
                tokio::time::timeout(timeout, tokio::net::TcpStream::connect(config.tls_address))
                    .await
                    .map_err(|_| Error::ConnectionTimeout)?
                    .map_err(Error::Connect)?;
            let stream = connector
                .connect(
                    rustls::pki_types::ServerName::try_from(host)
                        .map_err(|_| Error::HttpRequestUriInvalid)?,
                    socket,
                )
                .await
                .map_err(Error::Tls)?;
            trace.active_connections.fetch_add(1, Ordering::SeqCst);
            struct Guard(Arc<AtomicUsize>);
            impl Drop for Guard {
                fn drop(&mut self) {
                    self.0.fetch_sub(1, Ordering::SeqCst);
                }
            }
            let guard = Guard(trace.active_connections.clone());
            let (mut sender, connection) =
                hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
            let mut request = request;
            *request.uri_mut() = http::Uri::builder()
                .path_and_query(request.uri().path_and_query().unwrap().as_str())
                .build()
                .map_err(|_| Error::HttpRequestUriInvalid)?;
            let send = async {
                if !gate.is_zero() {
                    trace.gated_requests.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(gate).await;
                }
                sender.send_request(request).await.map_err(Error::from)
            };
            tokio::pin!(send);
            let mut connection = Some(Box::pin(connection));
            // Polling Hyper can both dispatch the response and complete the
            // connection. Follow the pinned stock driver: mark it completed,
            // then repoll the response instead of discarding queued bytes.
            let response = poll_fn(|cx| match send.as_mut().poll(cx) {
                Poll::Ready(result) => Poll::Ready(result),
                Poll::Pending => {
                    let Some(conn) = connection.as_mut() else {
                        return Poll::Pending;
                    };
                    let result = match conn.as_mut().poll(cx) {
                        Poll::Pending => return Poll::Pending,
                        Poll::Ready(result) => result,
                    };
                    connection = None;
                    match result {
                        Ok(()) => {
                            trace
                                .clean_completions_before_response
                                .fetch_add(1, Ordering::SeqCst);
                            send.as_mut().poll(cx)
                        }
                        Err(error) => Poll::Ready(Err(Error::from(error))),
                    }
                }
            })
            .await?;
            let response = response.map(|b| b.map_err(Error::from).boxed_unsync());
            Ok((
                response,
                Box::new(async move {
                    let _guard = guard;
                    match connection {
                        Some(connection) => connection.await.map_err(Error::from),
                        None => Ok(()),
                    }
                }) as IoFuture,
            ))
        })
    }
}

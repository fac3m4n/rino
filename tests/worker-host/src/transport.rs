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
    alchemy_path: String,
    adapter: Adapter,
    pub trace: Trace,
    gate: Duration,
    tiny: bool,
}
pub const LOCAL_ALCHEMY_KEY: &str = "rino-local-test-key";
pub const CREDENTIAL_ERROR: &str = "Alchemy credential missing or invalid";
/// Separate host validation: no ambient environment is consulted by library APIs.
pub fn alchemy_path(key: &str) -> Result<String> {
    ensure!(
        (8..=128).contains(&key.len())
            && key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        CREDENTIAL_ERROR
    );
    Ok(format!("/v2/{key}"))
}
impl Hooks {
    pub fn new(adapter: Adapter) -> Result<Self> {
        ensure!(!matches!(adapter, Adapter::Production), CREDENTIAL_ERROR);
        Self::with_credential(adapter, LOCAL_ALCHEMY_KEY)
    }
    /// Production accepts only this explicit key; never inherit the host environment.
    pub fn production(key: &str) -> Result<Self> {
        Self::with_credential(Adapter::Production, key)
    }
    fn with_credential(adapter: Adapter, key: &str) -> Result<Self> {
        let alchemy_path = alchemy_path(key)?;
        if let Adapter::LocalSandbox(c) = &adapter {
            ensure!(
                c.tls_address.ip().is_loopback(),
                "local TLS address must be loopback"
            );
            ensure!(!c.ca_der.is_empty(), "local CA missing");
        }
        Ok(Self {
            alchemy_path,
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
impl Hooks {
    fn allowed(&self, request: &http::Request<WasiBody>) -> bool {
        request.method() == http::Method::POST
            && request.uri().scheme_str() == Some("https")
            && match (
                request.uri().authority().map(|a| a.as_str()),
                request.uri().path_and_query().map(|p| p.as_str()),
            ) {
                (Some("ethereum-sepolia-rpc.publicnode.com"), Some("/")) => true,
                (Some("eth-sepolia.g.alchemy.com"), Some(path)) => path == self.alchemy_path,
                _ => false,
            }
            && request
                .headers()
                .get("content-type")
                .is_some_and(|v| v == "application/json")
    }
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
        if !self.allowed(&request) {
            return Box::new(async { Err(Error::HttpRequestDenied) });
        }
        self.trace.destinations.lock().unwrap().push(
            if request.uri().host() == Some("eth-sepolia.g.alchemy.com") {
                "https://eth-sepolia.g.alchemy.com/v2/[REDACTED]".to_owned()
            } else {
                "https://ethereum-sepolia-rpc.publicnode.com/".to_owned()
            },
        );
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

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use http_body_util::Full;
    fn request(uri: &str) -> http::Request<WasiBody> {
        http::Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .body(
                Full::new(Bytes::new())
                    .map_err(|e| match e {})
                    .boxed_unsync(),
            )
            .unwrap()
    }
    #[test]
    fn explicit_secret_selects_only_exact_https_authority_and_path_and_redacts_trace() {
        let mut hooks = Hooks::production("secret_TEST-123").unwrap();
        for uri in [
            "https://eth-sepolia.g.alchemy.com/v2/secret_TEST-123",
            "https://ethereum-sepolia-rpc.publicnode.com/",
        ] {
            assert!(hooks.allowed(&request(uri)));
            let future = hooks.send_request(request(uri), None, Box::new(async { Ok(()) }));
            // Dropping without polling proves tracing without initiating public network I/O.
            drop(future);
        }
        assert_eq!(
            *hooks.trace.destinations.lock().unwrap(),
            [
                "https://eth-sepolia.g.alchemy.com/v2/[REDACTED]",
                "https://ethereum-sepolia-rpc.publicnode.com/"
            ]
        );
        for uri in [
            "http://eth-sepolia.g.alchemy.com/v2/secret_TEST-123",
            "https://eth-sepolia.g.alchemy.com:443/v2/secret_TEST-123",
            "https://eth-sepolia.g.alchemy.com:444/v2/secret_TEST-123",
            "https://eth-sepolia.g.alchemy.com.attacker.invalid/v2/secret_TEST-123",
            "https://user@eth-sepolia.g.alchemy.com/v2/secret_TEST-123",
            "https://eth-sepolia.g.alchemy.com/v2/other_key",
            "https://eth-sepolia.g.alchemy.com/v2/secret_TEST-123/",
            "https://eth-sepolia.g.alchemy.com/v2/secret_TEST-123?query",
            "https://eth-sepolia.g.alchemy.com/v2/%73ecret_TEST-123",
            "https://public.1rpc.io/sepolia",
            "https://ethereum-sepolia-rpc.publicnode.com/?query",
        ] {
            assert!(!hooks.allowed(&request(uri)), "unexpected allowed URI");
        }
        let mut wrong_method = request("https://eth-sepolia.g.alchemy.com/v2/secret_TEST-123");
        *wrong_method.method_mut() = http::Method::GET;
        assert!(!hooks.allowed(&wrong_method));
        let mut wrong_type = request("https://eth-sepolia.g.alchemy.com/v2/secret_TEST-123");
        wrong_type.headers_mut().remove("content-type");
        assert!(!hooks.allowed(&wrong_type));
        let denied = hooks.send_request(wrong_method, None, Box::new(async { Ok(()) }));
        drop(denied);
        assert_eq!(hooks.trace.destinations.lock().unwrap().len(), 2);
    }
    #[test]
    fn production_secret_validation_has_fixed_diagnostics() {
        for key in ["", "short", "with/slash", "unicodeé", &"a".repeat(129)] {
            let error = Hooks::production(key).err().expect("invalid key accepted");
            assert_eq!(error.to_string(), "Alchemy credential missing or invalid");
        }
        assert!(Hooks::production(&"a".repeat(8)).is_ok());
        assert!(Hooks::production(&"Z".repeat(128)).is_ok());
    }
}

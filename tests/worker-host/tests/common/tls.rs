use serde_json::{Value, json};
use std::{
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::{JoinHandle, JoinSet},
};
use tokio_rustls::{
    TlsAcceptor,
    rustls::{
        ServerConfig,
        pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer},
    },
};
#[derive(Clone, Copy, Debug)]
pub enum Scenario {
    Happy,
    FixedLengthClose,
    HandshakeStall,
    HeaderStall,
    Cumulative,
    TinyChunks,
    Oversize,
    Redirect,
    Reset,
    TrailerStall,
    InvalidTrailer,
}
type Events = Arc<Mutex<Vec<(String, u128)>>>;
pub struct Fixture {
    pub addr: SocketAddr,
    pub ca: Vec<u8>,
    pub requests: Arc<Mutex<Vec<String>>>,
    pub active: Arc<AtomicUsize>,
    pub events: Events,
    task: JoinHandle<()>,
}
#[derive(Clone)]
struct Wire {
    scenario: Scenario,
    fixture: Value,
    requests: Arc<Mutex<Vec<String>>>,
    active: Arc<AtomicUsize>,
    events: Events,
    origin: Instant,
}
impl Wire {
    fn event(&self, name: &str) {
        self.events
            .lock()
            .unwrap()
            .push((name.into(), self.origin.elapsed().as_millis()));
    }
}
struct Active(Arc<AtomicUsize>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
impl Fixture {
    pub async fn new(scenario: Scenario, wrong_san: bool) -> Self {
        Self::with_fixture(scenario, wrong_san, crate::common::fixture()).await
    }
    pub async fn with_fixture(scenario: Scenario, wrong_san: bool, fixture: Value) -> Self {
        let names = if wrong_san {
            vec!["wrong.invalid".into()]
        } else {
            vec![
                "ethereum-sepolia-rpc.publicnode.com".into(),
                "public.1rpc.io".into(),
            ]
        };
        let rcgen::CertifiedKey { cert, signing_key } =
            rcgen::generate_simple_self_signed(names).unwrap();
        let ca = cert.der().to_vec();
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(signing_key.serialize_der()));
        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert.der().clone()], key)
            .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let active = Arc::new(AtomicUsize::new(0));
        let events = Arc::new(Mutex::new(Vec::new()));
        let wire = Wire {
            scenario,
            fixture,
            requests: requests.clone(),
            active: active.clone(),
            events: events.clone(),
            origin: Instant::now(),
        };
        let task = tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            loop {
                let accepted = tokio::select! {accepted=listener.accept()=>Some(accepted.unwrap().0),_=tasks.join_next(),if !tasks.is_empty()=>None};
                if let Some(socket) = accepted {
                    tasks.spawn(serve(socket, acceptor.clone(), wire.clone()));
                }
            }
        });
        Self {
            addr,
            ca,
            requests,
            active,
            events,
            task,
        }
    }
    pub async fn shutdown(self) {
        self.task.abort();
        let _ = self.task.await;
        for _ in 0..20 {
            if self.active.load(Ordering::SeqCst) == 0 {
                return;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(
            self.active.load(Ordering::SeqCst),
            0,
            "fixture socket tasks not cancelled"
        );
    }
}
async fn line(s: &mut (impl AsyncRead + Unpin)) -> Option<Vec<u8>> {
    let mut line = Vec::new();
    let mut b = [0; 1];
    while !line.ends_with(b"\r\n") {
        s.read_exact(&mut b).await.ok()?;
        line.push(b[0]);
        if line.len() > 8192 {
            return None;
        }
    }
    Some(line)
}
async fn read_request(s: &mut (impl AsyncRead + Unpin)) -> Option<(String, Vec<u8>)> {
    let mut bytes = Vec::new();
    loop {
        let l = line(s).await?;
        let done = l == b"\r\n";
        bytes.extend(l);
        if bytes.len() > 8192 {
            return None;
        }
        if done {
            break;
        }
    }
    let header = String::from_utf8(bytes).ok()?;
    let length = header.lines().find_map(|l| {
        l.to_ascii_lowercase()
            .strip_prefix("content-length:")
            .and_then(|v| v.trim().parse::<usize>().ok())
    });
    let mut body = Vec::new();
    if let Some(length) = length {
        if length > 32768 {
            return None;
        }
        body.resize(length, 0);
        s.read_exact(&mut body).await.ok()?;
    } else {
        loop {
            let l = line(s).await?;
            let n = usize::from_str_radix(std::str::from_utf8(&l[..l.len() - 2]).ok()?, 16).ok()?;
            if n == 0 {
                line(s).await?;
                break;
            }
            let start = body.len();
            if start + n > 32768 {
                return None;
            }
            body.resize(start + n, 0);
            s.read_exact(&mut body[start..]).await.ok()?;
            line(s).await?;
        }
    }
    Some((header, body))
}
async fn serve(mut socket: TcpStream, tls: TlsAcceptor, wire: Wire) {
    wire.event("tcp-accepted");
    wire.active.fetch_add(1, Ordering::SeqCst);
    let _guard = Active(wire.active.clone());
    if matches!(wire.scenario, Scenario::HandshakeStall) {
        let mut buf = [0; 4096];
        while socket.read(&mut buf).await.unwrap_or(0) > 0 {}
        return;
    }
    let Ok(mut s) = tls.accept(socket).await else {
        return;
    };
    wire.event("tls-established");
    let Some((header, body)) = read_request(&mut s).await else {
        return;
    };
    wire.requests.lock().unwrap().push(header);
    wire.event("request-body-consumed");
    let q: Value = serde_json::from_slice(&body).unwrap();
    let f = &wire.fixture;
    let result = if q["method"] == "eth_chainId" {
        json!("0xaa36a7")
    } else {
        json!({"number":"0x7b","hash":f["bundle"]["block_hash"],"stateRoot":f["bundle"]["state_root"],"timestamp":"0x26ac","baseFeePerGas":"0x1","transactions":[]})
    };
    let payload =
        serde_json::to_vec(&json!({"jsonrpc":"2.0","id":q["id"],"result":result})).unwrap();
    if matches!(wire.scenario, Scenario::FixedLengthClose) {
        // Queue the entire fixed-length response in one TLS write, then cleanly
        // close immediately. Hyper may dispatch this response and finish at once.
        let mut bytes = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            payload.len()
        )
        .into_bytes();
        bytes.extend(&payload);
        wire.event("fixed-length-response-written");
        s.write_all(&bytes).await.unwrap();
        s.shutdown().await.unwrap();
        wire.event("immediate-clean-close");
        return;
    }
    if matches!(wire.scenario, Scenario::HeaderStall) {
        let _ = s.read(&mut [0; 1]).await;
        return;
    }
    if matches!(wire.scenario, Scenario::Redirect) {
        let _=s.write_all(b"HTTP/1.1 302 Found\r\nLocation: https://attacker.invalid/\r\nTransfer-Encoding: chunked\r\n\r\n").await;
        let _ = s.read(&mut [0; 1]).await;
        return;
    }
    if matches!(wire.scenario, Scenario::Cumulative) {
        tokio::time::sleep(Duration::from_secs(6)).await;
    }
    wire.event("sending-response-headers");
    if s.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n")
        .await
        .is_err()
    {
        return;
    }
    if matches!(wire.scenario, Scenario::Oversize) {
        let chunk = vec![b' '; 262145];
        let _ = s
            .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
            .await;
        let _ = s.write_all(&chunk).await;
        let _ = s.write_all(b"\r\n100000\r\n").await;
        let _ = s.read(&mut [0; 1]).await;
        return;
    }
    if matches!(wire.scenario, Scenario::TinyChunks) {
        for b in payload {
            wire.event("tiny-body-chunk");
            if s.write_all(format!("1\r\n{}\r\n", b as char).as_bytes())
                .await
                .is_err()
            {
                return;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        return;
    }
    let _ = s
        .write_all(format!("{:x}\r\n", payload.len()).as_bytes())
        .await;
    if matches!(wire.scenario, Scenario::Cumulative) {
        let _ = s.write_all(&payload[..1]).await;
        wire.event("body-prefix-written");
        tokio::time::sleep(Duration::from_secs(5)).await;
        let _ = s.write_all(&payload[1..]).await;
    } else {
        let _ = s.write_all(&payload).await;
    }
    if matches!(wire.scenario, Scenario::Reset) {
        return;
    }
    wire.event("data-ended-entering-trailers");
    let _ = s.write_all(b"\r\n0\r\n").await;
    if matches!(wire.scenario, Scenario::TrailerStall) {
        let _ = s.read(&mut [0; 1]).await;
        return;
    }
    let trailer = if matches!(wire.scenario, Scenario::InvalidTrailer) {
        &b"malformed trailer\r\n\r\n"[..]
    } else {
        &b"x-proofcredit: ok\r\n\r\n"[..]
    };
    let _ = s.write_all(trailer).await;
    let _ = s.shutdown().await;
}

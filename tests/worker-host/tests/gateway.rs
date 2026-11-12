use proofcredit_worker_host::gateway::Gateway;
#[tokio::test]
async fn gateway_accepts_explicit_loopback_and_rejects_remote_upstream() {
    assert!(
        Gateway::start("http://127.0.0.1:18545", 10000)
            .await
            .is_ok(),
        "explicit local gateway must be available"
    );
    for url in [
        "https://example.com/",
        "http://example.com:18545/",
        "http://0.0.0.0:18545/",
        "http://127.0.0.1:18545/secret",
        "http://user@127.0.0.1:18545/",
    ] {
        assert!(Gateway::start(url, 10000).await.is_err(), "{url}");
    }
}
async fn request(g: &Gateway, method: &str, host: &str) -> (u16, Vec<u8>) {
    use http_body_util::BodyExt;
    let config = g.adapter();
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(rustls::pki_types::CertificateDer::from(config.ca_der))
        .unwrap();
    let connector = tokio_rustls::TlsConnector::from(std::sync::Arc::new(
        rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    ));
    let socket = tokio::net::TcpStream::connect(config.tls_address)
        .await
        .unwrap();
    let tls = connector
        .connect(
            rustls::pki_types::ServerName::try_from("ethereum-sepolia-rpc.publicnode.com").unwrap(),
            socket,
        )
        .await
        .unwrap();
    let (mut sender, connection) =
        hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tls))
            .await
            .unwrap();
    let task = tokio::spawn(connection);
    let body = serde_json::to_vec(
        &serde_json::json!({"jsonrpc":"2.0","id":1,"method":method,"params":[]}),
    )
    .unwrap();
    let response = sender
        .send_request(
            http::Request::builder()
                .method("POST")
                .uri("/")
                .header("host", host)
                .header("content-type", "application/json")
                .body(http_body_util::Full::new(bytes::Bytes::from(body)))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    task.abort();
    let _ = task.await;
    (status, bytes)
}
#[tokio::test]
async fn gateway_forwards_read_only_rpc_and_never_forwards_mutations_or_other_hosts() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = calls.clone();
    let upstream = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let mut buf = vec![0; 8192];
            let _ = stream.read(&mut buf).await;
            let bytes = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0xaa36a7\"}";
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            );
            stream.write_all(header.as_bytes()).await.unwrap();
            stream.write_all(bytes).await.unwrap();
        }
    });
    let g = Gateway::start(&format!("http://{addr}"), 10000)
        .await
        .unwrap();
    let (status, bytes) = request(&g, "eth_chainId", "ethereum-sepolia-rpc.publicnode.com").await;
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["result"],
        "0xaa36a7"
    );
    assert_eq!(
        request(&g, "evm_mine", "ethereum-sepolia-rpc.publicnode.com")
            .await
            .0,
        403
    );
    assert_eq!(
        request(
            &g,
            "eth_sendRawTransaction",
            "ethereum-sepolia-rpc.publicnode.com"
        )
        .await
        .0,
        403
    );
    assert_eq!(request(&g, "eth_chainId", "attacker.invalid").await.0, 403);
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    let config = g.adapter();
    g.shutdown().await;
    assert!(
        tokio::net::TcpStream::connect(config.tls_address)
            .await
            .is_err()
    );
    upstream.abort();
    let _ = upstream.await;
}
#[test]
fn production_cli_forbids_local_clock_and_rpc_configuration() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_proofcredit-worker-host"))
        .args([
            "--module",
            "unused",
            "--input",
            "unused",
            "--mode",
            "production",
            "--near-time",
            "1",
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("Production forbids")
    );
}

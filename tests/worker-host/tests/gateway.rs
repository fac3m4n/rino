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
    request_path(g, method, host, "/").await
}
async fn request_path(g: &Gateway, method: &str, host: &str, path: &str) -> (u16, Vec<u8>) {
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
                .uri(path)
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
    assert_eq!(
        request_path(
            &g,
            "eth_chainId",
            "eth-sepolia.g.alchemy.com",
            "/v2/proofcredit-local-test-key"
        )
        .await
        .0,
        200
    );
    for (host, path) in [
        ("eth-sepolia.g.alchemy.com", "/v2/ambient_secret"),
        (
            "eth-sepolia.g.alchemy.com",
            "/v2/proofcredit-local-test-key?x",
        ),
        (
            "eth-sepolia.g.alchemy.com:443",
            "/v2/proofcredit-local-test-key",
        ),
        (
            "eth-sepolia.g.alchemy.com.attacker.invalid",
            "/v2/proofcredit-local-test-key",
        ),
    ] {
        assert_eq!(request_path(&g, "eth_chainId", host, path).await.0, 403);
    }
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
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

#[test]
fn production_cli_rejects_missing_or_invalid_credentials_before_loading_guest() {
    for key in [
        None,
        Some(""),
        Some("bad/key?injection"),
        Some("short"),
        Some("leak-me-".repeat(20)).as_deref(),
    ] {
        let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_proofcredit-worker-host"));
        command.env_clear().args([
            "--module",
            "unused",
            "--input",
            "unused",
            "--mode",
            "production",
        ]);
        if let Some(key) = key {
            command.env("ALCHEMY_API_KEY", key);
        }
        let output = command.output().unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert_eq!(
            String::from_utf8(output.stderr).unwrap(),
            "worker host: Alchemy credential missing or invalid\n"
        );
    }
}

#[test]
fn production_hooks_require_explicit_credential() {
    assert!(
        proofcredit_worker_host::transport::Hooks::new(
            proofcredit_worker_host::Adapter::Production
        )
        .is_err()
    );
}

mod common;
#[tokio::test]
async fn local_cli_ignores_ambient_real_credential_and_uses_synthetic_only() {
    use http_body_util::BodyExt;
    use std::io::Write;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let upstream = tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let service = hyper::service::service_fn(
                    |request: http::Request<hyper::body::Incoming>| async move {
                        let bytes = request.into_body().collect().await.unwrap().to_bytes();
                        let q: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                        let f = common::fixture();
                        let result = if q["method"] == "eth_chainId" {
                            serde_json::json!("0xaa36a7")
                        } else {
                            serde_json::json!({"number":"0x7b","hash":f["bundle"]["block_hash"],"stateRoot":f["bundle"]["state_root"],"timestamp":"0x26ac"})
                        };
                        Ok::<_, std::convert::Infallible>(http::Response::new(http_body_util::Full::new(bytes::Bytes::from(
                        serde_json::to_vec(&serde_json::json!({"jsonrpc":"2.0","id":q["id"],"result":result})).unwrap()
                    ))))
                    },
                );
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    let output = tokio::task::spawn_blocking(move || {
        let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_proofcredit-worker-host"))
            .env_clear()
            .env("ALCHEMY_API_KEY", "AMBIENT-private-key-do-not-forward")
            .args([
                "--module",
                "../../target/wasm32-wasip2/release/proofcredit-proof-worker.wasm",
                "--input",
                "-",
                "--mode",
                "local-sandbox",
                "--near-time",
                "10000",
                "--rpc-url",
                &format!("http://{address}"),
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&common::fixture()).unwrap())
            .unwrap();
        child.wait_with_output().unwrap()
    })
    .await
    .unwrap();
    upstream.abort();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()["status"],
        "verified"
    );
    assert!(output.stderr.is_empty());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("AMBIENT-private-key"));
}

#[tokio::test]
async fn production_library_rejects_implicit_or_invalid_credentials_and_redacts_guest_diagnostics()
{
    use proofcredit_worker_host::{Adapter, Runner};
    let runner =
        Runner::new("../../target/wasm32-wasip2/release/proofcredit-proof-worker.wasm").unwrap();
    assert!(runner.run(b"invalid", Adapter::Production).await.is_err());
    for key in ["", "bad/path", "short", &"x".repeat(129)] {
        let error = runner.run_production(b"invalid", key).await.unwrap_err();
        assert_eq!(error.to_string(), "Alchemy credential missing or invalid");
    }
    let out = runner
        .run_production(b"invalid", "explicit-private_TEST-credential")
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap()["status"],
        "rejected"
    );
    assert!(!String::from_utf8_lossy(&out.stdout).contains("explicit-private"));
    assert!(!String::from_utf8_lossy(&out.stderr).contains("explicit-private"));
}

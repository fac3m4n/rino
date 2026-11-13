#![cfg(feature = "test-hooks")]
mod common;
#[path = "common/tls.rs"]
mod tls;
use rino_worker_host::{Adapter, LocalSandbox, Runner, transport::Hooks};
use serde_json::Value;
use std::{sync::atomic::Ordering, time::Duration};
fn runner() -> Runner {
    Runner::new("../../target/wasm32-wasip2/release/rino-proof-worker.wasm").unwrap()
}
fn adapter(f: &tls::Fixture) -> Adapter {
    Adapter::LocalSandbox(LocalSandbox {
        tls_address: f.addr,
        ca_der: f.ca.clone(),
        owned_near_unix_seconds: 10000,
    })
}
fn assert_streams_only(out: &rino_worker_host::RunOutput) {
    assert_eq!(out.http_resources_after, 0);
    assert!(
        out.resource_kinds_after
            .iter()
            .all(|s| s == "wasmtime_wasi_io::streams::DynInputStream"
                || s == "wasmtime_wasi_io::streams::DynOutputStream"),
        "unexpected residual resource: {:?}",
        out.resource_kinds_after
    );
}
fn input() -> Vec<u8> {
    serde_json::to_vec(&common::fixture()).unwrap()
}
#[tokio::test]
async fn canonical_guest_accepts_valid_quorum_over_verified_tls() {
    let runner = runner();
    let fixture = tls::Fixture::new(tls::Scenario::Happy, false).await;
    let hooks = Hooks::new(adapter(&fixture)).unwrap();
    let trace = hooks.trace.clone();
    let out = runner
        .run_with_hooks(&input(), Some(10000), "LocalSandbox", Box::new(hooks))
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&out.stdout).unwrap()["status"],
        "verified"
    );
    assert!(out.stderr.is_empty());
    assert!(!String::from_utf8_lossy(&out.stdout).contains("rino-local-test-key"));
    assert!(
        fixture
            .requests
            .lock()
            .unwrap()
            .iter()
            .skip(3)
            .all(
                |header| header.starts_with("POST /v2/rino-local-test-key HTTP/1.1\r\n")
                    && header
                        .to_ascii_lowercase()
                        .contains("host: eth-sepolia.g.alchemy.com\r\n")
            )
    );
    assert!(out.exit_success);
    assert_eq!(out.stdout.iter().filter(|b| **b == b'\n').count(), 1);
    assert_eq!(fixture.requests.lock().unwrap().len(), 6);
    assert_eq!(
        *trace.destinations.lock().unwrap(),
        [
            "https://ethereum-sepolia-rpc.publicnode.com/",
            "https://eth-sepolia.g.alchemy.com/v2/[REDACTED]"
        ]
        .into_iter()
        .flat_map(|s| vec![s.to_string(); 3])
        .collect::<Vec<_>>()
    );
    tokio::task::yield_now().await;
    assert_eq!(trace.active_connections.load(Ordering::SeqCst), 0);
    assert_streams_only(&out);
    fixture.shutdown().await;
    eprintln!(
        "happy elapsed={:?} before={} after={} kinds={:?}",
        out.elapsed, out.resources_before, out.resources_after, out.resource_kinds_after
    );
    assert_eq!(
        out.http_resources_after, 0,
        "HTTP resources remain: {:?}",
        out.resource_kinds_after
    );
    assert_eq!(
        out.resources_after, 2,
        "only stdin and stdout streams remain"
    );
}
#[tokio::test]
async fn canonical_guest_enforces_absolute_deadlines_and_cleans_all_http_resources() {
    let runner = runner();
    use tls::Scenario::*;
    for scenario in [
        HandshakeStall,
        HeaderStall,
        Cumulative,
        TinyChunks,
        Oversize,
        Redirect,
        Reset,
        TrailerStall,
        InvalidTrailer,
    ] {
        let fixture = tls::Fixture::new(scenario, false).await;
        let hooks = Hooks::new(adapter(&fixture)).unwrap();
        let trace = hooks.trace.clone();
        let out = tokio::time::timeout(
            Duration::from_secs(13),
            runner.run_with_hooks(&input(), Some(10000), "LocalSandbox", Box::new(hooks)),
        )
        .await
        .expect("external watchdog is not guest timeout evidence")
        .unwrap();
        let value: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!(value["status"], "rejected", "{scenario:?}");
        let timed = matches!(
            scenario,
            HandshakeStall | HeaderStall | Cumulative | TinyChunks | TrailerStall
        );
        if timed {
            assert_eq!(value["code"], "rpc_timeout", "{scenario:?}");
            assert!(
                out.elapsed >= Duration::from_millis(9900)
                    && out.elapsed < Duration::from_millis(11500),
                "{scenario:?}: {:?}",
                out.elapsed
            );
        }
        if matches!(scenario, Oversize) {
            assert_eq!(value["code"], "rpc_too_large");
            assert_eq!(
                out.http_stream_bytes_read, 262145,
                "guest stops at exact overflow sentinel"
            );
        }
        if matches!(scenario, Redirect) {
            assert_eq!(value["code"], "http_rejected");
            assert!(out.elapsed < Duration::from_secs(1));
        }
        tokio::task::yield_now().await;
        assert_eq!(
            trace.destinations.lock().unwrap().len(),
            1,
            "no redirects/fallback"
        );
        assert_eq!(
            trace.active_connections.load(Ordering::SeqCst),
            0,
            "{scenario:?} pending TLS task"
        );
        assert_eq!(
            out.trailer_wait_subscriptions, 0,
            "wire trailers do not reach the pending future-trailers branch"
        );
        eprintln!(
            "guest-binding counters {scenario:?}: http_bytes={} blocked_writes={} trailer_waits={}",
            out.http_stream_bytes_read, out.blocked_http_writes, out.trailer_wait_subscriptions
        );
        let events = fixture.events.lock().unwrap().clone();
        assert_streams_only(&out);
        fixture.shutdown().await;
        eprintln!("wire-events {scenario:?}: {events:?}");
        eprintln!(
            "{scenario:?} code={} elapsed={:?} before={} after={} kinds={:?}",
            value["code"],
            out.elapsed,
            out.resources_before,
            out.resources_after,
            out.resource_kinds_after
        );
        assert_eq!(
            out.http_resources_after, 0,
            "{scenario:?}: {:?}",
            out.resource_kinds_after
        );
        assert!(out.resources_after <= 3, "stdio only");
    }
}
#[tokio::test]
async fn tiny_host_buffer_forces_real_guest_write_backpressure() {
    let runner = runner();
    let fixture = tls::Fixture::new(tls::Scenario::Happy, false).await;
    let hooks = Hooks::new(adapter(&fixture))
        .unwrap()
        .with_write_gate(Duration::from_secs(11));
    let trace = hooks.trace.clone();
    let out = tokio::time::timeout(
        Duration::from_secs(13),
        runner.run_with_hooks(&input(), Some(10000), "LocalSandbox", Box::new(hooks)),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&out.stdout).unwrap()["code"],
        "rpc_timeout"
    );
    assert_eq!(trace.gated_requests.load(Ordering::SeqCst), 1);
    assert!(
        out.blocked_http_writes > 0,
        "actual WASI output-stream.check-write returned zero"
    );
    assert_eq!(
        fixture.requests.lock().unwrap().len(),
        0,
        "request body gate precedes Hyper send"
    );
    assert!(
        out.elapsed >= Duration::from_millis(9900) && out.elapsed < Duration::from_millis(11500)
    );
    tokio::task::yield_now().await;
    assert_eq!(trace.active_connections.load(Ordering::SeqCst), 0);
    assert_streams_only(&out);
    fixture.shutdown().await;
    assert_eq!(out.http_resources_after, 0);
    eprintln!(
        "write-backpressure deadline={:?} resources={:?}",
        out.elapsed, out.resource_kinds_after
    );
}
#[tokio::test]
async fn wrong_san_and_untrusted_ca_reject_before_any_http_request() {
    let runner = runner();
    for wrong_san in [true, false] {
        let fixture = tls::Fixture::new(tls::Scenario::Happy, wrong_san).await;
        let mut a = adapter(&fixture);
        if !wrong_san {
            let other = tls::Fixture::new(tls::Scenario::Happy, false).await;
            if let Adapter::LocalSandbox(c) = &mut a {
                c.ca_der = other.ca.clone();
            }
            other.shutdown().await;
        }
        let out = runner.run(&input(), a).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&out.stdout).unwrap()["status"],
            "rejected"
        );
        assert!(fixture.requests.lock().unwrap().is_empty());
        assert_streams_only(&out);
        fixture.shutdown().await;
        assert_eq!(out.http_resources_after, 0);
    }
}
#[tokio::test]
async fn canonical_settlement_guest_proves_nonzero_nonce_preparation_over_real_tls() {
    let runner =
        Runner::new("../../target/wasm32-wasip2/release/rino-settlement-worker.wasm").unwrap();
    let mut r = common::fixture_nonce(7);
    r["policy_id"] = serde_json::json!("rpc-finalized-2of2-settlement-v1");
    r["generation"] = serde_json::json!("3");
    r["beneficiary"] = serde_json::json!("0x2222222222222222222222222222222222222222");
    r["expected_nonce"] = serde_json::json!("7");
    r["purpose"] = serde_json::json!({"kind":"prepare"});
    let proof = r["bundle"]["account_proof"].clone();
    r["bundle"].as_object_mut().unwrap().remove("account_proof");
    r["bundle"]["vault_account_proof"] = proof.clone();
    r["bundle"]["beneficiary_account_proof"] = proof;
    let f = tls::Fixture::with_fixture(tls::Scenario::Happy, false, r.clone()).await;
    let out = runner
        .run(&serde_json::to_vec(&r).unwrap(), adapter(&f))
        .await
        .unwrap();
    let value: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(value["status"], "verified", "{value}");
    assert_eq!(value["nonce"], "7");
    assert_eq!(value["base_fee_per_gas"], "1");
    assert_eq!(
        value["beneficiary_code_hash"],
        "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    );
    assert_eq!(f.requests.lock().unwrap().len(), 6);
    assert_streams_only(&out);
    f.shutdown().await;
    assert_eq!(out.http_resources_after, 0);
    assert_eq!(out.resources_after, 2);
    eprintln!(
        "settlement-prepare nonce7 elapsed={:?} resources={:?}",
        out.elapsed, out.resource_kinds_after
    );
}

#[tokio::test]
async fn fixed_length_immediate_clean_close_preserves_response_and_guest_evidence() {
    let runner = runner();
    let fixture = tls::Fixture::new(tls::Scenario::FixedLengthClose, false).await;
    let hooks = Hooks::new(adapter(&fixture)).unwrap();
    let trace = hooks.trace.clone();
    let out = runner
        .run_with_hooks(&input(), Some(10000), "LocalSandbox", Box::new(hooks))
        .await
        .unwrap();
    let response: Value = serde_json::from_slice(&out.stdout).unwrap();
    let completed = trace
        .clean_completions_before_response
        .load(Ordering::SeqCst);
    eprintln!(
        "fixed-length-immediate-close clean-before-response={completed} stdout={} resources={:?} events={:?}",
        String::from_utf8_lossy(&out.stdout),
        out.resource_kinds_after,
        fixture.events.lock().unwrap()
    );
    assert!(
        completed > 0,
        "regression must observe the actual clean connection completion branch"
    );
    assert_eq!(
        response["status"], "verified",
        "clean completion must repoll the response future"
    );
    assert_eq!(response["balance_wei"], "1000000000000000000");
    let control = tls::Fixture::new(tls::Scenario::Happy, false).await;
    let baseline = runner.run(&input(), adapter(&control)).await.unwrap();
    assert_eq!(
        out.stdout, baseline.stdout,
        "fixed-length clean-close preserves byte-exact canonical stdout"
    );
    assert_eq!(out.stderr, baseline.stderr);
    assert_eq!(out.exit_success, baseline.exit_success);
    assert_streams_only(&baseline);
    control.shutdown().await;
    assert!(out.stderr.is_empty());
    assert!(out.exit_success);
    assert_eq!(out.stdout.iter().filter(|b| **b == b'\n').count(), 1);
    assert_eq!(fixture.requests.lock().unwrap().len(), 6);
    assert_eq!(trace.destinations.lock().unwrap().len(), 6);
    assert_streams_only(&out);
    assert_eq!(out.resources_after, 2);
    tokio::task::yield_now().await;
    assert_eq!(trace.active_connections.load(Ordering::SeqCst), 0);
    fixture.shutdown().await;
}

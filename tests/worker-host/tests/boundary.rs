#![cfg(feature = "test-hooks")]
mod common;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use proofcredit_worker_host::{
    Runner,
    transport::{IoFuture, SendFuture},
};
use serde_json::{Value, json};
use std::{
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};
use wasmtime_wasi_http::{Error, RequestOptions, WasiBody, WasiHttpHooks};
#[derive(Clone, Copy, Debug)]
enum Phase {
    Header,
    Body,
    Write,
}
struct Script {
    phase: Phase,
    at: Duration,
    calls: usize,
    eligible: Arc<AtomicUsize>,
}
struct DelayedBody {
    data: Option<Bytes>,
    sleep: Pin<Box<tokio::time::Sleep>>,
    eligible: Arc<AtomicUsize>,
}
impl hyper::body::Body for DelayedBody {
    type Data = Bytes;
    type Error = Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<hyper::body::Frame<Bytes>, Error>>> {
        if self.data.is_none() {
            return Poll::Ready(None);
        }
        if self.sleep.as_mut().poll(cx).is_pending() {
            return Poll::Pending;
        }
        self.eligible.fetch_add(1, Ordering::SeqCst);
        Poll::Ready(Some(Ok(hyper::body::Frame::data(
            self.data.take().unwrap(),
        ))))
    }
}
impl WasiHttpHooks for Script {
    fn p2_outgoing_body_chunk_size(&mut self) -> usize {
        if matches!(self.phase, Phase::Write) {
            1
        } else {
            1024 * 1024
        }
    }
    fn p2_outgoing_body_buffer_chunks(&mut self) -> usize {
        1
    }
    fn send_request(
        &mut self,
        request: http::Request<WasiBody>,
        _: Option<RequestOptions>,
        _: IoFuture,
    ) -> SendFuture {
        let delay = if self.calls == 0 {
            self.at
        } else {
            Duration::ZERO
        };
        self.calls += 1;
        let phase = self.phase;
        let eligible = self.eligible.clone();
        Box::new(async move {
            if matches!(phase, Phase::Write) {
                tokio::time::sleep(delay).await;
                eligible.fetch_add(1, Ordering::SeqCst);
            }
            let b = request.into_body().collect().await?.to_bytes();
            let q: Value = serde_json::from_slice(&b).unwrap();
            let f = common::fixture();
            let result = if q["method"] == "eth_chainId" {
                json!("0xaa36a7")
            } else {
                json!({"number":"0x7b","hash":f["bundle"]["block_hash"],"stateRoot":f["bundle"]["state_root"],"timestamp":"0x26ac"})
            };
            let bytes = Bytes::from(
                serde_json::to_vec(&json!({"jsonrpc":"2.0","id":q["id"],"result":result})).unwrap(),
            );
            if matches!(phase, Phase::Header) {
                tokio::time::sleep(delay).await;
                eligible.fetch_add(1, Ordering::SeqCst);
            }
            let body = if matches!(phase, Phase::Body) {
                DelayedBody {
                    data: Some(bytes),
                    sleep: Box::pin(tokio::time::sleep(delay)),
                    eligible,
                }
                .boxed_unsync()
            } else {
                Full::new(bytes)
                    .map_err(|never| match never {})
                    .boxed_unsync()
            };
            Ok((
                http::Response::new(body),
                Box::new(async { Ok(()) }) as IoFuture,
            ))
        })
    }
}
#[tokio::test(start_paused = true)]
async fn actual_guest_deadline_wins_when_each_readiness_source_is_simultaneously_eligible() {
    let runner =
        Runner::new("../../target/wasm32-wasip2/release/proofcredit-proof-worker.wasm").unwrap();
    for phase in [Phase::Header, Phase::Body, Phase::Write] {
        for ns in [9_998_000_000, 10_000_000_000, 10_002_000_000] {
            let eligible = Arc::new(AtomicUsize::new(0));
            let start = tokio::time::Instant::now();
            let out = runner
                .run_with_hooks(
                    &serde_json::to_vec(&common::fixture()).unwrap(),
                    Some(10000),
                    "ScriptedBoundary",
                    Box::new(Script {
                        phase,
                        at: Duration::from_nanos(ns),
                        calls: 0,
                        eligible: eligible.clone(),
                    }),
                )
                .await
                .unwrap();
            let value: Value = serde_json::from_slice(&out.stdout).unwrap();
            if ns < 10_000_000_000 {
                assert_eq!(value["status"], "verified", "{phase:?}/{ns}");
                assert!(eligible.load(Ordering::SeqCst) > 0);
            } else {
                assert_eq!(value["code"], "rpc_timeout", "{phase:?}/{ns}");
            }
            if ns == 10_000_000_000 {
                assert!(
                    start.elapsed() >= Duration::from_secs(10)
                        && start.elapsed() < Duration::from_millis(10002)
                );
                assert!(start.elapsed() >= Duration::from_nanos(ns));
                assert!(
                    out.simultaneous_ready_lists.iter().any(|p| p == &[0, 1]),
                    "both actual pollables must be ready at exactly the same fixed virtual instant: {phase:?} {:?}",
                    out.simultaneous_ready_lists
                );
            }
            assert_eq!(out.http_resources_after, 0);
            assert!(out.resources_after <= 3);
            eprintln!(
                "script phase={phase:?} ready_at_ns={ns} elapsed_ns={} readiness_polled={} poll_lists={:?} simultaneous={:?} status={}",
                start.elapsed().as_nanos(),
                eligible.load(Ordering::SeqCst),
                out.poll_ready_lists,
                out.simultaneous_ready_lists,
                value["status"]
            );
        }
    }
}

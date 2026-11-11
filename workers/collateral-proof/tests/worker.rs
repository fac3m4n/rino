use proofcredit_proof_protocol::{request_digest, ProofEvidence, MAX_INPUT_BYTES, MAX_RPC_BYTES};
use proofcredit_proof_worker::{
    run_entry, run_worker, Provider, RpcResponse, RpcTransport, WorkerError,
};
use rlp::RlpStream;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    io::{self, Cursor, Read, Write},
    process::{Command, Stdio},
};
use tiny_keccak::{Hasher, Keccak};

fn hex(b: &[u8]) -> String {
    format!(
        "0x{}",
        b.iter().map(|v| format!("{v:02x}")).collect::<String>()
    )
}
fn keccak(b: &[u8]) -> [u8; 32] {
    let mut h = Keccak::v256();
    h.update(b);
    let mut out = [0; 32];
    h.finalize(&mut out);
    out
}
// Synthetic funded EOA and synthetic two-provider headers, never a live vault/finality claim.
fn fixture() -> Value {
    let mut account = RlpStream::new_list(4);
    account.append(&0u64);
    account.append(&1_000_000_000_000_000_000u64);
    let storage = hex_bytes("56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421");
    let code = hex_bytes("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    account.append(&storage);
    account.append(&code);
    let mut path = vec![0x20];
    path.extend(keccak(&[0x11; 20]));
    let mut leaf = RlpStream::new_list(2);
    leaf.append(&path);
    leaf.append(&account.out().to_vec());
    let leaf = leaf.out();
    json!({"schema_version":1,"policy_id":"rpc-finalized-2of2-v1","controller_id":"controller.testnet","request_id":"42","chain_id":"11155111","vault":hex(&[0x11;20]),"requested_at":"10000","expires_at":"10600","bundle":{"block_number":"123","block_hash":hex(&[0x22;32]),"state_root":hex(&keccak(&leaf)),"block_timestamp":"9900","account_proof":[hex(&leaf)]}})
}
fn hex_bytes(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
#[derive(Default)]
struct Fake {
    calls: RefCell<Vec<(Provider, Value)>>,
    mode: &'static str,
}
impl RpcTransport for Fake {
    fn post(&self, p: Provider, b: &[u8]) -> Result<RpcResponse, WorkerError> {
        let q: Value = serde_json::from_slice(b).unwrap();
        self.calls.borrow_mut().push((p, q.clone()));
        if self.mode == "timeout" {
            return Err(WorkerError::Timeout);
        }
        let r = fixture();
        let mut result = match q["method"].as_str().unwrap() {
            "eth_chainId" => json!(if self.mode == "chain" {
                "0x1"
            } else {
                "0xaa36a7"
            }),
            "eth_getBlockByNumber" => {
                json!({"number":"0x7b","hash":r["bundle"]["block_hash"],"stateRoot":r["bundle"]["state_root"],"timestamp":"0x26ac","transactions":[]})
            }
            m => panic!("unexpected method {m}"),
        };
        if self.mode == "disagree" && p.id == "automata" && q["params"][0] == "0x7b" {
            result["stateRoot"] = json!(hex(&[0x33; 32]));
        }
        if self.mode == "quantity" && q["method"] == "eth_chainId" {
            result = json!("0x0aa36a7");
        }
        let response = if self.mode == "rpc_error" {
            json!({"jsonrpc":"2.0","id":q["id"],"error":{"code":-32000,"message":"remote-secret"}})
        } else if self.mode == "null" {
            json!({"jsonrpc":"2.0","id":q["id"],"result":null})
        } else {
            json!({"jsonrpc":"2.0","id":if self.mode=="id" {json!(999)}else{q["id"].clone()},"result":result})
        };
        let mut bytes = serde_json::to_vec(&response).unwrap();
        if self.mode == "large" {
            bytes.resize(MAX_RPC_BYTES + 1, b' ');
        }
        if self.mode == "exact" {
            bytes.resize(MAX_RPC_BYTES, b' ');
        }
        Ok(RpcResponse {
            status: if self.mode == "redirect" { 302 } else { 200 },
            body: Box::new(Cursor::new(bytes)),
        })
    }
}
fn input() -> Vec<u8> {
    serde_json::to_vec(&fixture()).unwrap()
}
#[test]
fn exact_original_bytes_yield_proven_evidence_and_only_fixed_rpc_calls() {
    let f = Fake::default();
    let mut i = input();
    i.extend(b" \n");
    let e: ProofEvidence = serde_json::from_slice(&run_worker(&i, &f, 10000).unwrap()).unwrap();
    assert_eq!(e.balance_wei, "1000000000000000000");
    assert_eq!(e.request_hash, hex(&request_digest(&i)));
    let calls = f.calls.borrow();
    assert_eq!(calls.len(), 6);
    for (n, chunk) in calls.chunks(3).enumerate() {
        assert_eq!(chunk[0].0.id, ["publicnode", "automata"][n]);
        assert_eq!(
            chunk[0].0.url,
            [
                "https://ethereum-sepolia-rpc.publicnode.com",
                "https://public.1rpc.io/sepolia"
            ][n]
        );
        for c in chunk {
            assert_eq!(c.0, chunk[0].0);
        }
        assert_eq!(
            chunk[0].1,
            json!({"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]})
        );
        assert_eq!(
            chunk[1].1,
            json!({"jsonrpc":"2.0","id":2,"method":"eth_getBlockByNumber","params":["finalized",false]})
        );
        assert_eq!(
            chunk[2].1,
            json!({"jsonrpc":"2.0","id":3,"method":"eth_getBlockByNumber","params":["0x7b",false]})
        );
    }
}
#[test]
fn boundaries_and_endpoint_injection_reject_before_rpc() {
    let f = Fake::default();
    let mut bytes = input();
    bytes.resize(MAX_INPUT_BYTES, b' ');
    assert!(run_worker(&bytes, &f, 10000).is_ok());
    f.calls.borrow_mut().clear();
    bytes.push(b' ');
    assert_eq!(
        run_worker(&bytes, &f, 10000),
        Err(WorkerError::InputTooLarge)
    );
    assert!(f.calls.borrow().is_empty());
    for field in ["url", "provider_id", "endpoint", "executor"] {
        let mut r = fixture();
        r[field] = json!("https://attacker.invalid");
        assert!(run_worker(&serde_json::to_vec(&r).unwrap(), &f, 10000).is_err());
    }
    assert!(f.calls.borrow().is_empty());
}
#[test]
fn rpc_faults_fail_closed_and_exact_response_limit_passes() {
    for mode in [
        "chain",
        "rpc_error",
        "timeout",
        "disagree",
        "large",
        "redirect",
        "null",
        "id",
        "quantity",
    ] {
        assert!(
            run_worker(
                &input(),
                &Fake {
                    mode,
                    ..Default::default()
                },
                10000
            )
            .is_err(),
            "{mode}"
        );
    }
    assert!(run_worker(
        &input(),
        &Fake {
            mode: "exact",
            ..Default::default()
        },
        10000
    )
    .is_ok());
}
struct Counting {
    read: usize,
}
impl Read for Counting {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        self.read += b.len();
        b.fill(b' ');
        Ok(b.len())
    }
}
#[test]
fn entry_bounds_stdin_and_separates_diagnostics() {
    let mut src = Counting { read: 0 };
    let mut out = Vec::new();
    let mut err = Vec::new();
    run_entry(&mut src, &mut out, &mut err, &Fake::default(), 10000).unwrap();
    assert_eq!(src.read, 32769);
    assert_eq!(
        serde_json::from_slice::<Value>(&out).unwrap(),
        json!({"status":"rejected","code":"input_too_large"})
    );
    assert!(!err.is_empty());
    assert!(!String::from_utf8(out).unwrap().contains("remote-secret"));
    let mut out = Vec::new();
    let mut err = Vec::new();
    run_entry(
        Cursor::new(input()),
        &mut out,
        &mut err,
        &Fake {
            mode: "rpc_error",
            ..Default::default()
        },
        10000,
    )
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&out).unwrap()["status"],
        "rejected"
    );
    assert!(!String::from_utf8(out).unwrap().contains("remote-secret"));
    assert!(!String::from_utf8(err).unwrap().contains("remote-secret"));
}
#[test]
fn binary_emits_one_json_and_diagnostics_only_on_stderr() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_proofcredit-proof-worker"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"not-json").unwrap();
    let o = child.wait_with_output().unwrap();
    assert!(o.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&o.stdout).unwrap()["status"],
        "rejected"
    );
    assert!(!o.stderr.is_empty());
    assert_eq!(o.stdout.iter().filter(|b| **b == b'\n').count(), 1);
}

// Catches adapters that read unbounded remote bytes before checking the JSON size.
#[test]
fn rpc_reader_stops_at_overflow_sentinel_and_propagates_late_errors() {
    use proofcredit_proof_worker::read_bounded;
    let mut source = Counting { read: 0 };
    assert_eq!(
        read_bounded(&mut source, 262144, WorkerError::RpcTooLarge),
        Err(WorkerError::RpcTooLarge)
    );
    assert_eq!(source.read, 262145);
    struct Failing(bool);
    impl Read for Failing {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if !self.0 {
                self.0 = true;
                buf[0] = b'{';
                return Ok(1);
            }
            Err(io::Error::new(io::ErrorKind::TimedOut, "remote-secret"))
        }
    }
    assert_eq!(
        read_bounded(Failing(false), 262144, WorkerError::RpcTooLarge),
        Err(WorkerError::Timeout)
    );
    let mut out = Vec::new();
    let mut diagnostics = Vec::new();
    run_entry(
        Cursor::new(input()),
        &mut out,
        &mut diagnostics,
        &Fake::default(),
        10000,
    )
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&out).unwrap()["status"],
        "verified"
    );
    assert!(diagnostics.is_empty());
}

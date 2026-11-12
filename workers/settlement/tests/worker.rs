use proofcredit_settlement_protocol::*;
use proofcredit_settlement_worker::*;
use serde_json::{json, Value};
use std::{cell::RefCell, io::Cursor};
#[allow(dead_code)]
#[path = "../../../crates/settlement-protocol/tests/common/mod.rs"]
mod common;
use common::*;
struct Transport {
    r: SettlementRequest,
    calls: RefCell<Vec<(String, String, Value)>>,
    fault: Option<(&'static str, Value)>,
    status: u16,
}
impl RpcTransport for Transport {
    fn post(&self, p: Provider, request: &[u8]) -> Result<RpcResponse, WorkerError> {
        assert!(PROVIDERS.contains(&p));
        let q: Value = serde_json::from_slice(request).unwrap();
        let method = q["method"].as_str().unwrap();
        self.calls
            .borrow_mut()
            .push((p.id.into(), method.into(), q["params"].clone()));
        let result = if let Some((m, ref value)) = self.fault {
            if m == method {
                value.clone()
            } else {
                self.answer(method, &q["params"])
            }
        } else {
            self.answer(method, &q["params"])
        };
        Ok(RpcResponse {
            status: self.status,
            body: Box::new(Cursor::new(
                serde_json::to_vec(&json!({"jsonrpc":"2.0","id":q["id"],"result":result})).unwrap(),
            )),
        })
    }
}
impl Transport {
    fn answer(&self, m: &str, params: &Value) -> Value {
        match m {
            "eth_chainId" => json!("0xaa36a7"),
            "eth_getBlockByNumber" => {
                if params[0] == "finalized" {
                    json!({"number":"0x7b"})
                } else {
                    json!({"number":"0x7b","hash":self.r.bundle.block_hash,"stateRoot":self.r.bundle.state_root,"timestamp":"0x26ac","baseFeePerGas":"0x2540be400","normalExtra":"accepted"})
                }
            }
            "eth_getTransactionByHash" => {
                let (_, o) = confirm_fixture("1", 3_000_000_000_000_000);
                let t = o[0].transaction.as_ref().unwrap();
                json!({"hash":t.hash,"chainId":"0xaa36a7","nonce":"0x6f","from":t.from,"to":t.to,"value":"0x7048860ddf79","gas":"0x5208","maxFeePerGas":"0x174876e800","maxPriorityFeePerGas":"0x174876e800","type":"0x2","input":"0x","accessList":[],"r":format!("0x{}",t.r[2..].trim_start_matches('0')),"s":format!("0x{}",t.s[2..].trim_start_matches('0')),"yParity":"0x1","v":"0x1","blockHash":t.block_hash,"blockNumber":"0x7b","transactionIndex":"0x0"})
            }
            "eth_getTransactionReceipt" => {
                let (_, o) = confirm_fixture("1", 3_000_000_000_000_000);
                let t = o[0].receipt.as_ref().unwrap();
                json!({"transactionHash":t.transaction_hash,"transactionIndex":"0x0","blockHash":t.block_hash,"blockNumber":"0x7b","from":t.from,"to":t.to,"type":"0x2","status":"0x1","gasUsed":"0x5208","effectiveGasPrice":"0x174876e800","contractAddress":null})
            }
            _ => panic!("unexpected {m}"),
        }
    }
}
fn t(r: SettlementRequest) -> Transport {
    Transport {
        r,
        calls: RefCell::new(vec![]),
        fault: None,
        status: 200,
    }
}
#[test]
fn prepare_queries_only_fixed_chain_finality_and_exact_header() {
    let r = fixture(2, 0, EMPTY_CODE_HASH, None);
    let t = t(r.clone());
    let output = run_settlement(&enc(&r), &t, NOW).unwrap();
    let e: SettlementEvidence = serde_json::from_slice(&output).unwrap();
    assert_eq!(e.nonce, "2");
    assert_eq!(e.balance_wei, "0");
    assert_eq!(t.calls.borrow().len(), 6);
    for (p, m, params) in t.calls.borrow().iter() {
        assert!(PROVIDERS.iter().any(|v| v.id == p));
        if m == "eth_getBlockByNumber" {
            assert!(params == &json!(["finalized", false]) || params == &json!(["0x7b", false]));
        }
    }
}
#[test]
fn confirm_fetches_exact_hash_and_normalizes_padded_signature() {
    let (r, _) = confirm_fixture("1", 3_000_000_000_000_000);
    let t = t(r.clone());
    let output = run_settlement(&enc(&r), &t, NOW).unwrap();
    let e: SettlementEvidence = serde_json::from_slice(&output).unwrap();
    assert_eq!(e.receipt.unwrap().status, "1");
    assert_eq!(t.calls.borrow().len(), 10);
    for (_, m, params) in t.calls.borrow().iter() {
        if matches!(
            m.as_str(),
            "eth_getTransactionByHash" | "eth_getTransactionReceipt"
        ) {
            let SettlementPurpose::Confirm { candidate, .. } = &r.purpose else {
                panic!()
            };
            assert_eq!(params, &json!([candidate.hash]));
        }
    }
}
#[test]
fn authentic_included_failure_is_confirmed_by_both_fixed_providers() {
    let (r, _) = confirm_fixture("0", 3_000_000_000_000_000);
    let mut transport = t(r.clone());
    let mut receipt = transport.answer("eth_getTransactionReceipt", &json!([]));
    receipt["status"] = json!("0x0");
    transport.fault = Some(("eth_getTransactionReceipt", receipt));
    let output = run_settlement(&enc(&r), &transport, NOW).unwrap();
    let evidence: SettlementEvidence = serde_json::from_slice(&output).unwrap();
    assert_eq!(evidence.receipt.unwrap().status, "0");
    assert_eq!(transport.calls.borrow().len(), 10);
}
#[test]
fn null_receipt_noncanonical_rpc_and_http_redirect_reject() {
    let (r, _) = confirm_fixture("1", 3_000_000_000_000_000);
    assert!(run_settlement(&enc(&r), &t(r.clone()), NOW).is_ok());
    for (method, value) in [
        ("eth_getTransactionReceipt", Value::Null),
        ("eth_chainId", json!("0x0aa36a7")),
        ("eth_getTransactionByHash", json!({})),
    ] {
        let mut t = t(r.clone());
        t.fault = Some((method, value));
        assert!(run_settlement(&enc(&r), &t, NOW).is_err());
    }
    let mut t = t(r.clone());
    t.status = 302;
    assert_eq!(run_settlement(&enc(&r), &t, NOW), Err(WorkerError::Http));
}
#[test]
fn validates_input_before_io_and_limits_rpc_body() {
    let r = fixture(0, 0, EMPTY_CODE_HASH, None);
    let t = t(r.clone());
    assert!(run_settlement(&enc(&r), &t, NOW).is_ok());
    t.calls.borrow_mut().clear();
    assert!(run_settlement(&vec![b' '; 32769], &t, NOW).is_err());
    assert!(t.calls.borrow().is_empty());
    let mut t = t;
    t.fault = Some(("eth_chainId", json!("x".repeat(MAX_RPC_BYTES))));
    assert_eq!(
        run_settlement(&enc(&r), &t, NOW),
        Err(WorkerError::RpcTooLarge)
    );
}

#[test]
fn requested_header_requires_canonical_base_fee_and_binds_output() {
    let r = fixture(0, 1, EMPTY_CODE_HASH, None);
    let mut transport = t(r.clone());
    assert!(run_settlement(&enc(&r), &transport, NOW).is_ok());
    for fee in [None, Some(json!("0x01")), Some(json!("-1")), Some(json!(1))] {
        let mut header = json!({"number":"0x7b","hash":r.bundle.block_hash,"stateRoot":r.bundle.state_root,"timestamp":"0x26ac"});
        if let Some(fee) = fee {
            header["baseFeePerGas"] = fee;
        }
        transport.fault = Some(("eth_getBlockByNumber", header));
        assert!(run_settlement(&enc(&r), &transport, NOW).is_err());
    }
    let output = run_settlement(&enc(&r), &t(r), NOW).unwrap();
    let evidence: SettlementEvidence = serde_json::from_slice(&output).unwrap();
    assert_eq!(evidence.base_fee_per_gas, "10000000000");
}

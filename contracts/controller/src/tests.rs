use super::*;
use near_sdk::{
    CurveType, Gas, NearToken, PromiseResult, PublicKey,
    mock::MockAction,
    test_utils::{VMContextBuilder, get_created_receipts},
    testing_env,
};
use proofcredit_proof_protocol::{EMPTY_CODE_HASH, ProofRequest, request_digest};
use serde_json::{Value, json};
use std::panic::{AssertUnwindSafe, catch_unwind};
const ADDRESS: &str = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const DEPOSIT: u128 = 50_000_000_000_000_000_000_000;
fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn context(who: &str, now: u64, results: Vec<PromiseResult>) {
    let ctx = VMContextBuilder::new()
        .current_account_id(id("controller.testnet"))
        .predecessor_account_id(id(who))
        .signer_account_id(id("borrower.testnet"))
        .block_timestamp(now * 1_000_000_000)
        .prepaid_gas(Gas::from_tgas(300))
        .account_balance(NearToken::from_near(10))
        .build();
    testing_env!(
        ctx,
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}
fn config() -> Config {
    Config {
        borrower: id("borrower.testnet"),
        executor: id("executor.testnet"),
        mpc: id("mpc.testnet"),
        wasm_url: "https://example.com/worker.wasm".into(),
        wasm_sha256: "2b4e8582fe62cdedee47718a5cbe186406bcba96c1c0a51290fb57cc2e2d2efa".into(),
        operation_deposit: U128(DEPOSIT),
        network: NetworkMode::Sandbox {
            mpc: id("mpc.testnet"),
        },
    }
}
fn controller(status: Status) -> Controller {
    Controller {
        config: config(),
        status,
        vault: Some(ADDRESS.into()),
        generation: 0,
        pending: None,
        evidence: None,
    }
}
fn bundle() -> ProofBundle {
    ProofBundle {
        block_number: "42".into(),
        block_hash: format!("0x{}", "11".repeat(32)),
        state_root: format!("0x{}", "22".repeat(32)),
        block_timestamp: "1000".into(),
        account_proof: vec!["0xc0".into()],
    }
}
fn pending_proof() -> Controller {
    let mut c = controller(Status::ProofPending);
    c.generation = 1;
    let r = ProofRequest {
        schema_version: 1,
        policy_id: "rpc-finalized-2of2-v1".into(),
        controller_id: "controller.testnet".into(),
        request_id: "1".into(),
        chain_id: "11155111".into(),
        vault: ADDRESS.into(),
        requested_at: "1000".into(),
        expires_at: "1600".into(),
        bundle: bundle(),
    };
    let input = serde_json::to_vec(&r).unwrap();
    c.pending = Some(Pending {
        kind: OperationKind::Proof,
        generation: 1,
        expires_at: 1600,
        input_hash: request_digest(&input),
        input,
    });
    c
}
fn evidence(c: &Controller) -> Vec<u8> {
    let p = c.pending.as_ref().unwrap();
    let r: ProofRequest = serde_json::from_slice(&p.input).unwrap();
    serde_json::to_vec(&json!({"schema_version":1,"policy_id":"rpc-finalized-2of2-v1","status":"verified","controller_id":"controller.testnet","request_id":"1","request_hash":hex(&p.input_hash),"chain_id":"11155111","vault":ADDRESS,"block_number":"42","block_hash":r.bundle.block_hash,"state_root":r.bundle.state_root,"block_timestamp":"1000","nonce":"0","balance_wei":"1000000000000000000","code_hash":EMPTY_CODE_HASH,"finality_basis":"rpc-finalized-2of2"})).unwrap()
}
fn hex(b: &[u8]) -> String {
    format!(
        "0x{}",
        b.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}
fn generator_key() -> Vec<u8> {
    let xy = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
    let bytes = (0..xy.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&xy[i..i + 2], 16).unwrap())
        .collect();
    serde_json::to_vec(&PublicKey::from_parts(CurveType::SECP256K1, bytes).unwrap()).unwrap()
}
fn panics(f: impl FnOnce()) {
    assert!(catch_unwind(AssertUnwindSafe(f)).is_err());
}
fn calls() -> Vec<(String, Value, u128, u64)> {
    get_created_receipts()
        .iter()
        .flat_map(|r| r.actions.iter())
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                prepaid_gas,
                ..
            } => Some((
                String::from_utf8(method_name.clone()).unwrap(),
                serde_json::from_slice(args).unwrap(),
                attached_deposit.as_yoctonear(),
                prepaid_gas.as_gas(),
            )),
            _ => None,
        })
        .collect()
}

// Catches hashing the NEAR curve tag, SHA3 instead of Keccak, wrong slice/curve.
#[test]
fn secp_generator_derives_independent_ethereum_address() {
    context("controller.testnet", 1000, vec![]);
    assert_eq!(
        vault::derive_address(&generator_key()),
        Some(ADDRESS.into())
    );
}
#[test]
fn malformed_and_other_curve_keys_reject() {
    context("controller.testnet", 1000, vec![]);
    for raw in [
        b"null".as_slice(),
        b"\"secp256k1:111\"",
        b"{}",
        b"\"ed25519:11111111111111111111111111111111\"",
        b"\"secp256k1:invalid!\"",
    ] {
        assert_eq!(vault::derive_address(raw), None);
    }
}
#[test]
fn malformed_secp_point_rejects_even_when_encoding_length_is_valid() {
    context("controller.testnet", 1000, vec![]);
    let raw =
        serde_json::to_vec(&PublicKey::from_parts(CurveType::SECP256K1, vec![0; 64]).unwrap())
            .unwrap();
    assert_eq!(vault::derive_address(&raw), None);
}
#[test]
fn constructor_pins_testnet_accounts_and_validates_source_and_cap() {
    context("borrower.testnet", 1000, vec![]);
    let make = |exec: &str, url: &str, hash: &str, d: u128| {
        Controller::new(
            id("borrower.testnet"),
            id(exec),
            url.into(),
            hash.into(),
            U128(d),
            NetworkMode::NearTestnet,
        )
    };
    let c = make(
        "outlayer.testnet",
        "https://example.com/a.wasm",
        &"ab".repeat(32),
        DEPOSIT,
    );
    assert_eq!(c.config.mpc, id("v1.signer-prod.testnet"));
    assert_eq!(c.status, Status::Uninitialized);
    for (exec, url, hash, d) in [
        (
            "evil.testnet",
            "https://example.com/a.wasm",
            "ab".repeat(32),
            DEPOSIT,
        ),
        (
            "outlayer.testnet",
            "http://example.com/a.wasm",
            "ab".repeat(32),
            DEPOSIT,
        ),
        ("outlayer.testnet", "https://", "ab".repeat(32), DEPOSIT),
        (
            "outlayer.testnet",
            "https://example.com:444/a",
            "ab".repeat(32),
            DEPOSIT,
        ),
        (
            "outlayer.testnet",
            "https://example.com/a",
            "AB".repeat(32),
            DEPOSIT,
        ),
        (
            "outlayer.testnet",
            "https://example.com/a",
            "ab".repeat(32),
            DEPOSIT + 1,
        ),
    ] {
        panics(|| {
            make(exec, url, &hash, d);
        });
    }
}
#[test]
fn derivation_reserves_before_call_and_binds_controller_identity() {
    context("borrower.testnet", 1000, vec![]);
    let mut c = controller(Status::Uninitialized);
    c.vault = None;
    drop(c.initialize_vault());
    assert_eq!(c.status, Status::Deriving);
    let p = c.pending.as_ref().unwrap();
    assert_eq!((p.generation, p.expires_at), (1, 1600));
    assert_eq!(p.kind, OperationKind::Derivation);
    let receipts = get_created_receipts();
    assert_eq!(receipts[0].receiver_id, id("mpc.testnet"));
    assert_eq!(receipts[1].receiver_id, id("controller.testnet"));
    assert_eq!(receipts[1].receipt_indices.len(), 1);
    let calls = calls();
    assert_eq!(calls[0].0, "derived_public_key");
    assert_eq!(
        calls[0].1,
        json!({"path":"proofcredit:sepolia:v1:0","predecessor":"controller.testnet","domain_id":0})
    );
    assert_eq!(calls[0].2, 0);
    assert_eq!(calls[1].0, "on_vault_derived");
    assert_eq!(calls[1].1, json!({"request_id":"1"}));
    assert!(calls.iter().map(|c| c.3).sum::<u64>() < 300_000_000_000_000);
    panics(|| {
        drop(c.initialize_vault());
    });
}
#[test]
fn derivation_callback_stores_address_and_failed_derivation_can_retry() {
    let mut c = controller(Status::Deriving);
    c.vault = None;
    c.generation = 1;
    c.pending = Some(Pending {
        kind: OperationKind::Derivation,
        generation: 1,
        expires_at: 1600,
        input: vec![],
        input_hash: [0; 32],
    });
    context(
        "controller.testnet",
        1600,
        vec![PromiseResult::Successful(generator_key())],
    );
    assert!(c.on_vault_derived(U64(1)));
    assert_eq!(c.vault.as_deref(), Some(ADDRESS));
    assert_eq!(c.status, Status::Funding);
    assert!(c.pending.is_none());
    assert!(!c.on_vault_derived(U64(1)));
    for result in [
        PromiseResult::Failed,
        PromiseResult::Successful(b"null".to_vec()),
        PromiseResult::Successful(vec![b'a'; 257]),
    ] {
        let mut c = controller(Status::Deriving);
        c.vault = None;
        c.pending = Some(Pending {
            kind: OperationKind::Derivation,
            generation: 1,
            expires_at: 1600,
            input: vec![],
            input_hash: [0; 32],
        });
        context("controller.testnet", 1000, vec![result]);
        assert!(!c.on_vault_derived(U64(1)));
        assert_eq!(c.status, Status::Uninitialized);
        assert!(c.pending.is_none());
    }
}
#[test]
fn proof_call_pins_policy_source_resources_deposit_and_exact_input() {
    context("borrower.testnet", 1000, vec![]);
    let mut c = controller(Status::Funding);
    drop(c.request_proof(bundle()));
    assert_eq!(c.status, Status::ProofPending);
    let p = c.pending.as_ref().unwrap();
    let r: Value = serde_json::from_slice(&p.input).unwrap();
    assert_eq!(r["vault"], ADDRESS);
    assert_eq!(r["request_id"], "1");
    assert_eq!(r["controller_id"], "controller.testnet");
    assert_eq!(r["requested_at"], "1000");
    assert_eq!(r["expires_at"], "1600");
    assert_eq!(r["policy_id"], "rpc-finalized-2of2-v1");
    assert_eq!(r["chain_id"], "11155111");
    assert_eq!(p.input_hash, request_digest(&p.input));
    let receipts = get_created_receipts();
    assert_eq!(receipts[0].receiver_id, id("executor.testnet"));
    let args = &calls()[0].1;
    assert_eq!(
        args["source"],
        json!({"WasmUrl":{"url":"https://example.com/worker.wasm","hash":"2b4e8582fe62cdedee47718a5cbe186406bcba96c1c0a51290fb57cc2e2d2efa","build_target":"wasm32-wasip2"}})
    );
    assert_eq!(
        args["resource_limits"],
        json!({"max_instructions":1000000000,"max_memory_mb":128,"max_execution_seconds":60})
    );
    assert_eq!(args["response_format"], "Json");
    assert_eq!(args["payer_account_id"], "controller.testnet");
    assert_eq!(args["input_data"].as_str().unwrap().as_bytes(), p.input);
    assert!(args["secrets_ref"].is_null());
    assert!(args["params"].is_null());
    assert_eq!(calls()[0].2, DEPOSIT);
    assert_eq!(calls()[1].1, json!({"request_id":"1"}));
    panics(|| {
        drop(c.request_proof(bundle()));
    });
}
#[test]
fn oversized_serialized_input_rejects_without_reserving_or_spending() {
    context("borrower.testnet", 1000, vec![]);
    let mut c = controller(Status::Funding);
    let mut b = bundle();
    b.account_proof = vec![format!("0x{}", "ab".repeat(1024)); 16];
    panics(|| {
        drop(c.request_proof(b));
    });
    assert!(get_created_receipts().is_empty());
    assert!(c.pending.is_none());
    assert_eq!(c.generation, 0);
}
#[test]
fn borrower_predecessor_not_original_signer_controls_all_spending_and_recovery() {
    context("attacker.testnet", 1700, vec![]);
    for action in 0..4 {
        let mut c = controller(Status::Uninitialized);
        panics(|| match action {
            0 => {
                drop(c.initialize_vault());
            }
            1 => {
                c.status = Status::Funding;
                drop(c.request_proof(bundle()));
            }
            2 => c.cancel(),
            _ => {
                c = pending_proof();
                c.expire_pending();
            }
        });
        assert!(get_created_receipts().is_empty());
    }
}
#[test]
fn direct_callbacks_reject_even_with_borrower_original_signer_and_valid_output() {
    let mut c = pending_proof();
    context(
        "attacker.testnet",
        1000,
        vec![PromiseResult::Successful(evidence(&c))],
    );
    panics(|| {
        c.on_proof_result(U64(1));
    });
    panics(|| {
        c.on_vault_derived(U64(1));
    });
    assert_eq!(c.status, Status::ProofPending);
    assert!(c.evidence.is_none());
}
#[test]
fn valid_evidence_is_consumed_once_and_terminal() {
    let mut c = pending_proof();
    let raw = evidence(&c);
    context(
        "controller.testnet",
        1600,
        vec![PromiseResult::Successful(raw)],
    );
    assert!(c.on_proof_result(U64(1)));
    assert_eq!(c.status, Status::ProofReady);
    assert!(c.pending.is_none());
    assert_eq!(c.get_evidence().unwrap().balance_wei, "1000000000000000000");
    assert!(!c.on_proof_result(U64(1)));
    context("borrower.testnet", 1600, vec![]);
    panics(|| {
        drop(c.request_proof(bundle()));
    });
    panics(|| c.cancel());
}
#[test]
fn invalid_executor_results_clear_only_current_pending_without_evidence() {
    for result in [
        PromiseResult::Failed,
        PromiseResult::Successful(b"null".to_vec()),
        PromiseResult::Successful(b"\"json string\"".to_vec()),
        PromiseResult::Successful(b"{\"status\":\"rejected\"}".to_vec()),
        PromiseResult::Successful(b"{".to_vec()),
        PromiseResult::Successful(vec![b' '; 8193]),
    ] {
        let mut c = pending_proof();
        context("controller.testnet", 1000, vec![result]);
        assert!(!c.on_proof_result(U64(1)));
        assert_eq!(c.status, Status::Funding);
        assert!(c.pending.is_none());
        assert!(c.evidence.is_none());
    }
}
#[test]
fn every_evidence_binding_and_account_rule_is_checked() {
    for (field, value) in [
        ("schema_version", json!(2)),
        ("policy_id", json!("evil")),
        ("status", json!("rejected")),
        ("controller_id", json!("other.testnet")),
        ("request_id", json!("2")),
        ("request_hash", json!(format!("0x{}", "00".repeat(32)))),
        ("chain_id", json!("1")),
        ("vault", json!(format!("0x{}", "00".repeat(20)))),
        ("block_number", json!("43")),
        ("block_hash", json!(format!("0x{}", "33".repeat(32)))),
        ("state_root", json!(format!("0x{}", "44".repeat(32)))),
        ("block_timestamp", json!("999")),
        ("nonce", json!("1")),
        ("balance_wei", json!("0")),
        ("code_hash", json!(format!("0x{}", "00".repeat(32)))),
        ("finality_basis", json!("consensus")),
        ("extra", json!(true)),
    ] {
        let mut c = pending_proof();
        let mut output: Value = serde_json::from_slice(&evidence(&c)).unwrap();
        output[field] = value;
        context(
            "controller.testnet",
            1000,
            vec![PromiseResult::Successful(
                serde_json::to_vec(&output).unwrap(),
            )],
        );
        assert!(!c.on_proof_result(U64(1)), "{field}");
        assert_eq!(c.status, Status::Funding, "{field}");
        assert!(c.evidence.is_none());
    }
}
#[test]
fn callbacks_require_one_dependency_and_recheck_near_clock() {
    for results in [vec![], vec![PromiseResult::Failed, PromiseResult::Failed]] {
        let mut c = pending_proof();
        context("controller.testnet", 1000, results);
        assert!(!c.on_proof_result(U64(1)));
        assert_eq!(c.status, Status::Funding);
    }
    for now in [999, 1601] {
        let mut c = pending_proof();
        context(
            "controller.testnet",
            now,
            vec![PromiseResult::Successful(evidence(&c))],
        );
        assert!(!c.on_proof_result(U64(1)));
        assert_eq!(c.status, Status::Funding);
    }
    let mut c = pending_proof();
    let p = c.pending.as_mut().unwrap();
    let mut r: ProofRequest = serde_json::from_slice(&p.input).unwrap();
    r.bundle.block_timestamp = "0".into();
    r.requested_at = "3500".into();
    r.expires_at = "4100".into();
    p.expires_at = 4100;
    p.input = serde_json::to_vec(&r).unwrap();
    p.input_hash = request_digest(&p.input);
    let mut raw: Value = serde_json::from_slice(&evidence(&c)).unwrap();
    raw["block_timestamp"] = json!("0");
    context(
        "controller.testnet",
        3601,
        vec![PromiseResult::Successful(serde_json::to_vec(&raw).unwrap())],
    );
    assert!(!c.on_proof_result(U64(1)));
    assert_eq!(c.status, Status::Funding);
}
#[test]
fn expiry_is_strict_and_stale_callbacks_cannot_reset_replacement_generation() {
    let mut c = pending_proof();
    context("borrower.testnet", 1600, vec![]);
    panics(|| c.expire_pending());
    context("borrower.testnet", 1601, vec![]);
    c.expire_pending();
    assert_eq!(c.status, Status::Funding);
    assert!(c.pending.is_none());
    assert_eq!(c.generation, 2);
    let mut b = bundle();
    b.block_timestamp = "1601".into();
    drop(c.request_proof(b));
    assert_eq!(c.generation, 3);
    context("controller.testnet", 1601, vec![PromiseResult::Failed]);
    assert!(!c.on_proof_result(U64(1)));
    assert_eq!(c.status, Status::ProofPending);
    assert_eq!(c.pending.as_ref().unwrap().generation, 3);
    assert!(!c.on_vault_derived(U64(3)));
    assert_eq!(c.status, Status::ProofPending);
}
#[test]
fn cancelled_is_terminal_and_late_callback_cannot_restore_state() {
    let mut c = pending_proof();
    let raw = evidence(&c);
    context("borrower.testnet", 1000, vec![]);
    c.cancel();
    assert_eq!(c.status, Status::Cancelled);
    assert_eq!(c.generation, 2);
    assert!(c.pending.is_none());
    context(
        "controller.testnet",
        1000,
        vec![PromiseResult::Successful(raw)],
    );
    assert!(!c.on_proof_result(U64(1)));
    assert_eq!(c.status, Status::Cancelled);
    context("borrower.testnet", 1000, vec![]);
    panics(|| {
        drop(c.initialize_vault());
    });
    panics(|| {
        drop(c.request_proof(bundle()));
    });
    panics(|| c.cancel());
}
#[test]
fn derivation_expiry_restores_uninitialized_and_overflow_does_not_reserve() {
    context("borrower.testnet", 1601, vec![]);
    let mut c = controller(Status::Deriving);
    c.vault = None;
    c.generation = 7;
    c.pending = Some(Pending {
        kind: OperationKind::Derivation,
        generation: 7,
        expires_at: 1600,
        input: vec![],
        input_hash: [0; 32],
    });
    c.expire_pending();
    assert_eq!(c.status, Status::Uninitialized);
    assert_eq!(c.generation, 8);
    drop(c.initialize_vault());
    assert_eq!(c.generation, 9);
    let mut c = controller(Status::Funding);
    c.generation = u64::MAX;
    panics(|| {
        drop(c.request_proof(bundle()));
    });
    assert!(c.pending.is_none());
    assert!(c.evidence.is_none());
}

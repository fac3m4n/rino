use super::*;
use crate::financial_tests::{ctx, funded, market, panic};
use crate::tests::{context, id};
use near_contract_standards::fungible_token::FungibleTokenCore;
use near_sdk::{PromiseResult, mock::MockAction, test_utils::get_created_receipts};
use rino_loan_core::{default_cap_wei, signed_transaction_hash, signing_digest};
use rino_settlement_protocol::{
    EMPTY_CODE_HASH, InclusionHeader, PROVIDER_IDS, ReceiptObservation, SettlementBundle,
    SettlementObservation, SettlementPurpose, SettlementRequest, TransactionObservation,
    verify_confirmation, verify_prepare,
};
use rlp::RlpStream;
const VAULT: &str = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
fn hx(bytes: &[u8]) -> String {
    format!(
        "0x{}",
        bytes.iter().map(|v| format!("{v:02x}")).collect::<String>()
    )
}
fn leaf(nonce: u64, balance: u128) -> Vec<u8> {
    let address = rino_settlement_protocol::fixed_hex::<20>(VAULT).unwrap();
    let key = signed_transaction_hash(&address);
    let mut path = vec![0x20];
    path.extend(key);
    let mut account = RlpStream::new_list(4);
    account.append(&nonce);
    account.append(&balance);
    account.append(&signed_transaction_hash(&[0x80]).as_slice());
    account.append(
        &rino_settlement_protocol::fixed_hex::<32>(EMPTY_CODE_HASH)
            .unwrap()
            .as_slice(),
    );
    let mut trie = RlpStream::new_list(2);
    trie.append(&path);
    trie.append(&account.out().to_vec());
    trie.out().to_vec()
}
fn bundle(nonce: u64, balance: u128) -> SettlementBundle {
    let l = leaf(nonce, balance);
    SettlementBundle {
        block_number: "123".into(),
        block_hash: hx(&[0x44; 32]),
        state_root: hx(&signed_transaction_hash(&l)),
        block_timestamp: "1000".into(),
        vault_account_proof: vec![hx(&l)],
        beneficiary_account_proof: vec![hx(&l)],
    }
}
fn cancelled() -> Controller {
    let mut c = market();
    c.vault = Some(VAULT.into());
    ctx("borrower.testnet", 1000);
    c.cancel();
    c
}
fn observations(r: &SettlementRequest) -> [SettlementObservation; 2] {
    PROVIDER_IDS.map(|p| SettlementObservation {
        inclusion_header: None,
        base_fee_per_gas: "1".into(),
        checkpoint: rino_proof_protocol::CheckpointObservation {
            provider_id: p.into(),
            chain_id: r.chain_id.clone(),
            finalized_number: r.bundle.block_number.clone(),
            block_number: r.bundle.block_number.clone(),
            block_hash: r.bundle.block_hash.clone(),
            state_root: r.bundle.state_root.clone(),
            block_timestamp: r.bundle.block_timestamp.clone(),
        },
        transaction: None,
        receipt: None,
    })
}
fn prepare(c: &mut Controller, balance: u128, price: u128) {
    ctx("borrower.testnet", 1000);
    drop(c.prepare_settlement(
        bundle(c.loan.as_ref().unwrap().settlement.nonce, balance),
        U128(price),
    ));
    let p = c.pending.as_ref().unwrap();
    let id = p.generation;
    let r: SettlementRequest = serde_json::from_slice(&p.input).unwrap();
    let e = verify_prepare(&p.input, &observations(&r), 1000).unwrap();
    context(
        "controller.testnet",
        1000,
        vec![PromiseResult::Successful(serde_json::to_vec(&e).unwrap())],
    );
    assert!(c.on_settlement_result(U64(id)));
}
fn signature(c: &Controller) -> String {
    let f = c.loan.as_ref().unwrap().settlement.intent.as_ref().unwrap();
    let key = k256::ecdsa::SigningKey::from_bytes((&[0x11; 32]).into()).unwrap();
    let (s, rec) = key
        .sign_prehash_recoverable(&signing_digest(&f.transfer).unwrap())
        .unwrap();
    let bytes = s.to_bytes();
    let mut r = vec![2 + rec.to_byte()];
    r.extend_from_slice(&bytes[..32]);
    serde_json::json!({"scheme":"Secp256k1","big_r":{"affine_point":hx(&r)[2..]},"s":{"scalar":hx(&bytes[32..])[2..]},"recovery_id":rec.to_byte()}).to_string()
}
fn confirm(c: &mut Controller, status: &str, post: u128) {
    confirm_candidate(c, 0, status, post);
}
fn confirm_candidate(c: &mut Controller, index: usize, status: &str, post: u128) {
    let s = &c.loan.as_ref().unwrap().settlement;
    let n = s.nonce;
    let hash = hx(&s.candidates[index].hash);
    ctx("borrower.testnet", 1000);
    drop(c.confirm_settlement(
        hash,
        ConfirmationBundle {
            checkpoint: bundle(n + 1, post),
            transaction_index: "0".into(),
        },
        None,
    ));
    let (id, raw) = confirmation_output(c, status, 1000, None, "1");
    context(
        "controller.testnet",
        1000,
        vec![PromiseResult::Successful(raw)],
    );
    assert!(c.on_settlement_result(U64(id)));
    assert!(!c.on_settlement_result(U64(id)));
}
fn confirmation_output(
    c: &Controller,
    status: &str,
    now: u64,
    inclusion: Option<InclusionHeader>,
    state_base_fee: &str,
) -> (u64, Vec<u8>) {
    let p = c.pending.as_ref().unwrap();
    let id = p.generation;
    let r: SettlementRequest = serde_json::from_slice(&p.input).unwrap();
    let SettlementPurpose::Confirm {
        intent, candidate, ..
    } = &r.purpose
    else {
        panic!("wrong purpose")
    };
    let inclusion = inclusion.unwrap_or_else(|| InclusionHeader {
        block_number: r.bundle.block_number.clone(),
        block_hash: r.bundle.block_hash.clone(),
        state_root: r.bundle.state_root.clone(),
        block_timestamp: r.bundle.block_timestamp.clone(),
        base_fee_per_gas: state_base_fee.into(),
    });
    let tx = TransactionObservation {
        hash: candidate.hash.clone(),
        chain_id: r.chain_id.clone(),
        nonce: intent.nonce.clone(),
        from: r.vault.clone(),
        to: intent.to.clone(),
        value: intent.value.clone(),
        gas: "21000".into(),
        max_fee_per_gas: intent.gas_price.clone(),
        max_priority_fee_per_gas: intent.gas_price.clone(),
        transaction_type: "2".into(),
        input: "0x".into(),
        empty_access_list: true,
        r: candidate.r.clone(),
        s: candidate.s.clone(),
        y_parity: candidate.y_parity.clone(),
        block_hash: inclusion.block_hash.clone(),
        block_number: inclusion.block_number.clone(),
        transaction_index: "0".into(),
    };
    let receipt = ReceiptObservation {
        transaction_hash: candidate.hash.clone(),
        transaction_index: "0".into(),
        block_hash: inclusion.block_hash.clone(),
        block_number: inclusion.block_number.clone(),
        from: r.vault.clone(),
        to: intent.to.clone(),
        transaction_type: "2".into(),
        status: status.into(),
        gas_used: "21000".into(),
        effective_gas_price: intent.gas_price.clone(),
        contract_address: None,
    };
    let mut o = observations(&r);
    for e in &mut o {
        e.base_fee_per_gas = state_base_fee.into();
        e.inclusion_header = Some(inclusion.clone());
        e.transaction = Some(tx.clone());
        e.receipt = Some(receipt.clone());
    }
    let evidence = verify_confirmation(&p.input, &o, now).unwrap();
    (id, serde_json::to_vec(&evidence).unwrap())
}

// Public MPC receipt plus independently recovered viem raw bytes/hash. The
// original R parity is 03 while its normalized signature recovery bit is 0.
fn live_mpc_fixture() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../tests/fixtures/mpc-live-normalized-parity.json"
    ))
    .unwrap()
}
fn live_mpc_controller(fixture: &serde_json::Value) -> Controller {
    let mut c = cancelled();
    c.vault = Some(fixture["expectedVault"].as_str().unwrap().into());
    let transfer: rino_settlement_protocol::TransferIntentDto =
        serde_json::from_value(fixture["transfer"].clone()).unwrap();
    let transfer = transfer.to_native().unwrap();
    let s = &mut c.loan.as_mut().unwrap().settlement;
    s.intent = Some(settlement::FrozenIntent {
        transfer,
        preimage: rino_loan_core::signing_preimage(&transfer).unwrap(),
        digest: rino_settlement_protocol::fixed_hex::<32>(
            fixture["signingDigest"].as_str().unwrap(),
        )
        .unwrap(),
        before_balance: 120_000_000_000_000_000,
        minimum_block: 123,
    });
    s.stage = settlement::SettlementStage::ReadyToSign;
    c
}
fn mpc_callback(c: &mut Controller, packet: Vec<u8>) -> bool {
    ctx("borrower.testnet", 1000);
    drop(c.request_signature());
    let request = c.pending.as_ref().unwrap().generation;
    context(
        "controller.testnet",
        1000,
        vec![PromiseResult::Successful(packet)],
    );
    c.on_signature_result(U64(request))
}
#[test]
fn private_callback_accepts_actual_mpc_normalized_parity_and_exact_independent_transaction() {
    let fixture = live_mpc_fixture();
    let mut c = live_mpc_controller(&fixture);
    let frozen = c.loan.as_ref().unwrap().settlement.intent.as_ref().unwrap();
    assert_eq!(
        hx(&signing_digest(&frozen.transfer).unwrap()),
        fixture["signingDigest"]
    );
    let original = serde_json::to_vec(&fixture["signature"]).unwrap();
    // The financial verifier's canonical packet interface must stay strict.
    assert!(
        rino_loan_core::verify_mpc_signature(
            &frozen.transfer,
            rino_settlement_protocol::fixed_hex::<20>(fixture["expectedVault"].as_str().unwrap())
                .unwrap(),
            &original,
        )
        .is_err()
    );
    let digest = frozen.digest;
    let transfer = frozen.transfer;
    assert!(mpc_callback(&mut c, original));
    let s = &c.loan.as_ref().unwrap().settlement;
    assert_eq!(s.stage, settlement::SettlementStage::Signed);
    assert_eq!(s.candidates.len(), 1);
    let candidate = &s.candidates[0];
    assert_eq!(hx(&candidate.raw), fixture["recoveries"][0]["raw"]);
    assert_eq!(
        hx(&candidate.hash),
        fixture["recoveries"][0]["transactionHash"]
    );
    assert_eq!(candidate.signing_digest, digest);
    assert_eq!(
        hx(&candidate.r)[2..],
        *fixture["signature"]["big_r"]["affine_point"]
            .as_str()
            .unwrap()
            .get(2..)
            .unwrap()
    );
    assert_eq!(
        hx(&candidate.s)[2..],
        *fixture["signature"]["s"]["scalar"].as_str().unwrap()
    );
    assert_eq!(candidate.recovery_id, 0);
    assert_eq!(s.intent.as_ref().unwrap().transfer, transfer);
    assert_eq!(s.intent.as_ref().unwrap().digest, digest);
    assert!(c.pending.is_none());
    assert!(!c.on_signature_result(U64(c.generation)));
    assert_eq!(c.get_signed_transactions().len(), 1);
}

#[test]
fn service_point_parity_is_callback_only_and_explicit_adoption_remains_canonical() {
    let fixture = live_mpc_fixture();
    let mut c = live_mpc_controller(&fixture);
    let original = fixture["signature"].to_string();
    ctx("borrower.testnet", 1000);
    assert!(!c.adopt_signature(original));
    assert!(c.get_signed_transactions().is_empty());
    let mut canonical = fixture["signature"].clone();
    canonical["big_r"]["affine_point"] = serde_json::json!(format!(
        "02{}",
        &fixture["signature"]["big_r"]["affine_point"]
            .as_str()
            .unwrap()[2..]
    ));
    assert!(c.adopt_signature(canonical.to_string()));
    assert_eq!(
        c.get_signed_transactions()[0].hash,
        fixture["recoveries"][0]["transactionHash"]
    );
    // Both original compressed parities are valid service representations.
    // The original bounded envelope, including padding, must be checked first.
    for signature in [&fixture["signature"], &canonical] {
        let mut c = live_mpc_controller(&fixture);
        let mut raw = serde_json::to_vec(signature).unwrap();
        raw.resize(1024, b' ');
        assert!(mpc_callback(&mut c, raw));
        assert_eq!(
            c.get_signed_transactions()[0].hash,
            fixture["recoveries"][0]["transactionHash"]
        );
    }
}
#[test]
fn private_callback_rejects_malformed_service_envelopes_without_unlocking_intent() {
    use serde_json::json;
    let fixture = live_mpc_fixture();
    let valid = fixture["signature"].clone();
    let mut packets = vec![b"null".to_vec(), b"{".to_vec(), b"[]".to_vec()];
    for (key, value) in [
        ("unknown", json!(true)),
        ("scheme", json!("Ed25519")),
        ("scheme", json!(null)),
        ("recovery_id", json!(2)),
        ("recovery_id", json!(27)),
        ("recovery_id", json!(-1)),
        ("recovery_id", json!("0")),
    ] {
        let mut bad = valid.clone();
        bad[key] = value;
        packets.push(bad.to_string().into_bytes());
    }
    for nested in ["big_r", "s"] {
        let mut bad = valid.clone();
        bad[nested]["unknown"] = json!(true);
        packets.push(bad.to_string().into_bytes());
    }
    // The duplicate values intentionally match: a Value-based parser would
    // silently collapse them and admit the otherwise valid live signature.
    for (key, value) in [
        ("scheme", valid["scheme"].clone()),
        ("big_r", valid["big_r"].clone()),
        ("s", valid["s"].clone()),
        ("recovery_id", valid["recovery_id"].clone()),
        ("affine_point", valid["big_r"]["affine_point"].clone()),
        ("scalar", valid["s"]["scalar"].clone()),
    ] {
        packets.push(
            valid
                .to_string()
                .replacen(
                    &format!("\"{key}\":"),
                    &format!("\"{key}\":{value},\"{key}\":"),
                    1,
                )
                .into_bytes(),
        );
    }
    for point in [
        format!(
            "+2{}",
            &valid["big_r"]["affine_point"].as_str().unwrap()[2..]
        ),
        format!(
            "04{}",
            &valid["big_r"]["affine_point"].as_str().unwrap()[2..]
        ),
        format!(
            "00{}",
            &valid["big_r"]["affine_point"].as_str().unwrap()[2..]
        ),
        format!("02{}", "ff".repeat(32)),
        format!("03{}", "00".repeat(32)),
        format!("03{}", "gg".repeat(32)),
        "03".repeat(32),
        "03".repeat(34),
        format!("0x{}", valid["big_r"]["affine_point"].as_str().unwrap()),
    ] {
        let mut bad = valid.clone();
        bad["big_r"]["affine_point"] = json!(point);
        packets.push(bad.to_string().into_bytes());
    }
    for scalar in [
        "00".repeat(32),
        "ff".repeat(32),
        "gg".repeat(32),
        "01".repeat(31),
    ] {
        let mut bad = valid.clone();
        bad["s"]["scalar"] = json!(scalar);
        packets.push(bad.to_string().into_bytes());
    }
    let mut oversized = valid.to_string().into_bytes();
    oversized.resize(1025, b' ');
    packets.push(oversized);
    for packet in packets {
        let mut c = live_mpc_controller(&fixture);
        let frozen = c.loan.as_ref().unwrap().settlement.intent.as_ref().unwrap();
        let before = near_sdk::borsh::to_vec(frozen).unwrap();
        assert!(
            !mpc_callback(&mut c, packet.clone()),
            "accepted {}",
            String::from_utf8_lossy(&packet)
        );
        let s = &c.loan.as_ref().unwrap().settlement;
        assert_eq!(
            near_sdk::borsh::to_vec(s.intent.as_ref().unwrap()).unwrap(),
            before
        );
        assert!(s.candidates.is_empty());
        assert_eq!(s.stage, settlement::SettlementStage::ReadyToSign);
        assert!(c.pending.is_none());
    }
}
#[test]
fn service_adapter_preserves_strict_recovery_vault_digest_and_low_s_checks() {
    use serde_json::json;
    let fixture = live_mpc_fixture();
    let valid = fixture["signature"].clone();
    let mut wrong_recovery = valid.clone();
    wrong_recovery["recovery_id"] = json!(1);
    let mut high_s = valid.clone();
    // n - s for the actual live signature. Flip recovery as well so a
    // high-s normalizer would turn it back into the accepted signature.
    high_s["s"]["scalar"] =
        json!("8adeb2912840b74e1c6c106161c87e37601ae1129e64ff7804ae90facd7c5234");
    high_s["recovery_id"] = json!(1);
    for packet in [wrong_recovery, high_s] {
        let mut c = live_mpc_controller(&fixture);
        assert!(!mpc_callback(&mut c, packet.to_string().into_bytes()));
        assert!(c.get_signed_transactions().is_empty());
    }
    let mut c = live_mpc_controller(&fixture);
    c.vault = Some(VAULT.into());
    assert!(!mpc_callback(&mut c, valid.to_string().into_bytes()));
    assert!(c.get_signed_transactions().is_empty());
    for changed_field in ["nonce", "to", "value", "gas_price"] {
        let mut c = live_mpc_controller(&fixture);
        let transfer = &mut c
            .loan
            .as_mut()
            .unwrap()
            .settlement
            .intent
            .as_mut()
            .unwrap()
            .transfer;
        match changed_field {
            "nonce" => transfer.nonce += 1,
            "to" => transfer.to = [0x11; 20],
            "value" => transfer.value -= 1,
            "gas_price" => transfer.gas_price += 1,
            _ => unreachable!(),
        }
        assert!(
            !mpc_callback(&mut c, valid.to_string().into_bytes()),
            "accepted changed {changed_field}"
        );
        assert!(c.get_signed_transactions().is_empty());
    }
}

#[test]
fn cancellation_prepare_pins_economics_before_signing_and_recovers_exact_mpc_signature() {
    let mut c = cancelled();
    ctx("borrower.testnet", 1000);
    panic(|| {
        drop(c.request_signature());
    });
    prepare(&mut c, 1_000_000, 1);
    let s = &c.loan.as_ref().unwrap().settlement;
    let f = s.intent.as_ref().unwrap();
    assert_eq!(
        (f.transfer.nonce, f.transfer.value, f.transfer.gas_price),
        (0, 979_000, 1)
    );
    assert_eq!(f.transfer.to, [0x11; 20]);
    assert_eq!(s.stage, settlement::SettlementStage::ReadyToSign);
    let sig = signature(&c);
    ctx("borrower.testnet", 1000);
    drop(c.request_signature());
    let request = c.pending.as_ref().unwrap().generation;
    let args = get_created_receipts()
        .iter()
        .flat_map(|r| r.actions.iter())
        .find_map(|a| {
            if let MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                ..
            } = a
            {
                if method_name == b"sign" {
                    assert_eq!(attached_deposit.as_yoctonear(), 1);
                    Some(serde_json::from_slice::<serde_json::Value>(args).unwrap())
                } else {
                    None
                }
            } else {
                None
            }
        })
        .unwrap();
    assert_eq!(args["request"]["path"], "rino:sepolia:v1:0");
    assert_eq!(
        args["request"]["payload_v2"]["Ecdsa"],
        hx(&c
            .loan
            .as_ref()
            .unwrap()
            .settlement
            .intent
            .as_ref()
            .unwrap()
            .digest)[2..]
    );
    context(
        "controller.testnet",
        1000,
        vec![PromiseResult::Successful(sig.into_bytes())],
    );
    assert!(c.on_signature_result(U64(request)));
    assert_eq!(c.loan.as_ref().unwrap().settlement.candidates.len(), 1);
    confirm(&mut c, "1", 0);
    let l = c.loan.as_ref().unwrap();
    assert_eq!(l.phase, LoanPhase::Closed);
    assert_eq!(
        (
            l.settlement.nonce,
            l.settlement.borrower_surplus,
            l.settlement.fees_paid
        ),
        (1, 979_000, 21_000)
    );
}
#[test]
fn signature_uncertainty_expiry_retry_adoption_and_bad_callbacks_never_unlock_intent() {
    let mut c = cancelled();
    prepare(&mut c, 1_000_000, 1);
    let frozen = c
        .loan
        .as_ref()
        .unwrap()
        .settlement
        .intent
        .as_ref()
        .unwrap()
        .transfer;
    for output in [
        PromiseResult::Failed,
        PromiseResult::Successful(vec![0; 1025]),
        PromiseResult::Successful(b"null".to_vec()),
    ] {
        ctx("borrower.testnet", 1000);
        drop(c.retry_signature());
        let id = c.pending.as_ref().unwrap().generation;
        context("controller.testnet", 1000, vec![output]);
        assert!(!c.on_signature_result(U64(id)));
        assert_eq!(
            c.loan
                .as_ref()
                .unwrap()
                .settlement
                .intent
                .as_ref()
                .unwrap()
                .transfer,
            frozen
        );
    }
    ctx("borrower.testnet", 1000);
    drop(c.retry_signature());
    let old = c.pending.as_ref().unwrap().generation;
    ctx("borrower.testnet", 1601);
    c.expire_pending();
    assert!(c.loan.as_ref().unwrap().settlement.intent.is_some());
    panic(|| {
        drop(c.prepare_settlement(bundle(0, 2_000_000), U128(2)));
    });
    panic(|| c.cancel());
    let sig = signature(&c);
    assert!(c.adopt_signature(sig.clone()));
    assert!(c.adopt_signature(sig));
    assert_eq!(c.loan.as_ref().unwrap().settlement.candidates.len(), 1);
    context("controller.testnet", 1601, vec![PromiseResult::Failed]);
    assert!(!c.on_signature_result(U64(old)));
    assert_eq!(c.loan.as_ref().unwrap().settlement.candidates.len(), 1);
}
#[test]
fn active_loan_and_wrong_party_cannot_prepare_sign_confirm_or_topup() {
    let mut c = funded();
    ctx("borrower.testnet", 1000);
    c.borrow();
    panic(|| {
        drop(c.prepare_settlement(bundle(0, 1_000_000), U128(1)));
    });
    panic(|| {
        drop(c.request_signature());
    });
    let mut c = cancelled();
    prepare(&mut c, 1_000_000, 1);
    ctx("attacker.testnet", 1000);
    panic(|| {
        drop(c.request_signature());
    });
    panic(|| {
        c.adopt_signature(signature(&c));
    });
    panic(|| {
        drop(c.add_fee_budget(bundle(0, 2_000_000), U128(1)));
    });
    context("attacker.testnet", 1000, vec![PromiseResult::Failed]);
    panic(|| {
        c.on_signature_result(U64(1));
    });
    panic(|| {
        c.on_settlement_result(U64(1));
    });
}
#[test]
fn status_zero_consumes_only_fee_and_nonce_before_a_new_intent() {
    let mut c = cancelled();
    prepare(&mut c, 1_000_000, 1);
    ctx("borrower.testnet", 1000);
    assert!(c.adopt_signature(signature(&c)));
    confirm(&mut c, "0", 979_000);
    let s = &c.loan.as_ref().unwrap().settlement;
    assert_eq!((s.nonce, s.borrower_surplus, s.fees_paid), (1, 0, 21_000));
    assert!(s.intent.is_none());
    assert!(s.candidates.is_empty());
    assert_ne!(c.loan.as_ref().unwrap().phase, LoanPhase::Closed);
    prepare(&mut c, 979_000, 1);
    assert_eq!(
        c.loan
            .as_ref()
            .unwrap()
            .settlement
            .intent
            .as_ref()
            .unwrap()
            .transfer
            .nonce,
        1
    );
}
#[test]
fn default_caps_lender_and_keeps_next_leg_lender_after_incoming_partial_payment() {
    let mut c = funded();
    c.vault = Some(VAULT.into());
    ctx("borrower.testnet", 1000);
    c.borrow();
    ctx("lender.testnet", 1120);
    c.declare_default();
    prepare(&mut c, 1_000_000, 1);
    assert_eq!(
        c.loan
            .as_ref()
            .unwrap()
            .settlement
            .intent
            .as_ref()
            .unwrap()
            .transfer
            .to,
        [0x22; 20]
    );
    ctx("borrower.testnet", 1000);
    assert!(c.adopt_signature(signature(&c)));
    confirm(&mut c, "1", 1_000_000);
    prepare(&mut c, 1_000_000, 1);
    assert_eq!(
        c.loan
            .as_ref()
            .unwrap()
            .settlement
            .intent
            .as_ref()
            .unwrap()
            .transfer
            .to,
        [0x22; 20]
    );
    let s = &c.loan.as_ref().unwrap().settlement;
    assert!(s.lender_paid < default_cap_wei(&c.loan.as_ref().unwrap().terms).unwrap());
}
#[test]
fn dust_zero_and_fee_floor_do_not_forge_release_or_allow_arbitrary_repricing() {
    let mut c = cancelled();
    prepare(&mut c, 21_000, 1);
    assert_eq!(
        c.loan.as_ref().unwrap().settlement.stage,
        settlement::SettlementStage::NeedsTopup
    );
    assert!(c.loan.as_ref().unwrap().settlement.intent.is_none());
    let mut c = cancelled();
    prepare(&mut c, 0, 1);
    assert_eq!(c.loan.as_ref().unwrap().phase, LoanPhase::Closed);
    assert_eq!(c.loan.as_ref().unwrap().settlement.borrower_surplus, 0);
    let mut c = cancelled();
    ctx("borrower.testnet", 1000);
    panic(|| {
        drop(c.prepare_settlement(bundle(0, 1_000_000), U128(0)));
    });
}
#[test]
fn canonical_views_expose_exact_string_money_and_only_verified_current_candidates() {
    let mut c = cancelled();
    prepare(&mut c, 1_000_000, 1);
    let market = serde_json::to_value(c.get_market().unwrap()).unwrap();
    assert_eq!(market["terms"]["principal_units"], "100000000");
    assert_eq!(
        market["settlement_wasm_sha256"],
        "11a8f330d8f6698c9e644230d37e86ebb7c985d77a697b05934a0bf482404758"
    );
    assert_eq!(market["terms"]["term_seconds"], "120");
    assert_eq!(market["debt_units"], "0");
    let s = serde_json::to_value(c.get_settlement().unwrap()).unwrap();
    assert_eq!(s["expected_nonce"], "0");
    assert_eq!(s["current_intent"]["transfer"]["value"], "979000");
    assert!(!s["retired"].as_bool().unwrap());
    assert!(c.get_signed_transactions().is_empty());
    ctx("borrower.testnet", 1000);
    assert!(c.adopt_signature(signature(&c)));
    assert_eq!(c.get_signed_transactions().len(), 1);
    confirm(&mut c, "1", 0);
    assert!(c.get_signed_transactions().is_empty());
    assert!(c.get_settlement().unwrap().retired);
}
fn topup(c: &mut Controller, balance: u128, amount: u128) -> bool {
    ctx("borrower.testnet", 1000);
    drop(c.add_fee_budget(
        bundle(c.loan.as_ref().unwrap().settlement.nonce, balance),
        U128(amount),
    ));
    let p = c.pending.as_ref().unwrap();
    let id = p.generation;
    let r: SettlementRequest = serde_json::from_slice(&p.input).unwrap();
    let e = verify_prepare(&p.input, &observations(&r), 1000).unwrap();
    context(
        "controller.testnet",
        1000,
        vec![PromiseResult::Successful(serde_json::to_vec(&e).unwrap())],
    );
    c.on_settlement_result(U64(id))
}
#[test]
fn fee_topup_consumes_only_proven_new_incoming_even_after_passive_preparation() {
    let mut c = cancelled();
    prepare(&mut c, 20_000, 1);
    let budget = c.loan.as_ref().unwrap().settlement.fee_budget;
    prepare(&mut c, 21_000, 1);
    assert_eq!(
        c.loan.as_ref().unwrap().settlement.accounted_balance,
        20_000
    );
    assert!(topup(&mut c, 21_000, 1_000));
    assert_eq!(
        c.loan.as_ref().unwrap().settlement.fee_budget,
        budget + 1_000
    );
    assert!(!topup(&mut c, 21_000, 1_000));
    assert_eq!(
        c.loan.as_ref().unwrap().settlement.fee_budget,
        budget + 1_000
    );
    assert!(!topup(&mut c, 22_000, 1_001));
    assert_eq!(
        c.loan.as_ref().unwrap().settlement.accounted_balance,
        21_000
    );
    assert!(topup(&mut c, 22_000, 1_000));
    assert_eq!(
        c.loan.as_ref().unwrap().settlement.accounted_balance,
        22_000
    );
}
#[test]
fn successful_default_lender_cap_precedes_borrower_surplus_and_partial_zero_closes_shortfall() {
    let mut c = funded();
    c.vault = Some(VAULT.into());
    ctx("borrower.testnet", 1000);
    c.borrow();
    ctx("lender.testnet", 1120);
    c.declare_default();
    let cap = default_cap_wei(&c.loan.as_ref().unwrap().terms).unwrap();
    prepare(&mut c, cap + 1_000_000, 1);
    assert_eq!(
        c.loan
            .as_ref()
            .unwrap()
            .settlement
            .intent
            .as_ref()
            .unwrap()
            .transfer
            .value,
        cap
    );
    ctx("borrower.testnet", 1000);
    assert!(c.adopt_signature(signature(&c)));
    confirm(&mut c, "1", 979_000);
    prepare(&mut c, 979_000, 1);
    assert_eq!(
        c.loan
            .as_ref()
            .unwrap()
            .settlement
            .intent
            .as_ref()
            .unwrap()
            .transfer
            .to,
        [0x11; 20]
    );
    ctx("borrower.testnet", 1000);
    assert!(c.adopt_signature(signature(&c)));
    confirm(&mut c, "1", 0);
    let s = &c.loan.as_ref().unwrap().settlement;
    assert_eq!(
        (s.lender_paid, s.borrower_surplus, s.fees_paid, s.shortfall),
        (cap, 958_000, 42_000, 0)
    );
    let mut c = funded();
    c.vault = Some(VAULT.into());
    ctx("borrower.testnet", 1000);
    c.borrow();
    ctx("lender.testnet", 1120);
    c.declare_default();
    prepare(&mut c, 1_000_000, 1);
    ctx("borrower.testnet", 1000);
    assert!(c.adopt_signature(signature(&c)));
    confirm(&mut c, "1", 0);
    assert_eq!(c.loan.as_ref().unwrap().phase, LoanPhase::Closed);
    assert_eq!(c.loan.as_ref().unwrap().settlement.shortfall, 101_000_000);
}
#[test]
fn repay_release_never_consumes_or_mints_lender_credit_claim() {
    let mut c = funded();
    c.vault = Some(VAULT.into());
    ctx("lender.testnet", 1000);
    c.ft_transfer(id("borrower.testnet"), U128(1_000_000), None);
    ctx("borrower.testnet", 1000);
    c.borrow();
    c.repay();
    prepare(&mut c, 1_000_000, 1);
    ctx("borrower.testnet", 1000);
    assert!(c.adopt_signature(signature(&c)));
    confirm(&mut c, "1", 0);
    assert_eq!(c.loan.as_ref().unwrap().claim, 101_000_000);
    ctx("lender.testnet", 1000);
    c.claim_credit();
    assert_eq!(c.ft_total_supply().0, 1_000_000_000);
    assert_eq!(c.ft_balance_of(id("lender.testnet")).0, 1_000_000_000);
}
fn alternate_signature(
    c: &Controller,
    secret: u8,
    k: u64,
    change: impl FnOnce(&mut rino_loan_core::TransferIntent),
) -> String {
    use k256::ecdsa::hazmat::SignPrimitive;
    let mut intent = c
        .loan
        .as_ref()
        .unwrap()
        .settlement
        .intent
        .as_ref()
        .unwrap()
        .transfer;
    change(&mut intent);
    let key = k256::ecdsa::SigningKey::from_bytes((&[secret; 32]).into()).unwrap();
    // Fixed ephemeral scalars are exclusively synthetic test fixtures, never an operational signer.
    let (s, rec) = key
        .as_nonzero_scalar()
        .as_ref()
        .try_sign_prehashed(
            k256::Scalar::from(k),
            &signing_digest(&intent).unwrap().into(),
        )
        .unwrap();
    let rec = rec.unwrap();
    let bytes = s.to_bytes();
    let mut r = vec![2 + rec.to_byte()];
    r.extend_from_slice(&bytes[..32]);
    serde_json::json!({"scheme":"Secp256k1","big_r":{"affine_point":hx(&r)[2..]},"s":{"scalar":hx(&bytes[32..])[2..]},"recovery_id":rec.to_byte()}).to_string()
}
#[test]
fn four_equivalent_signature_aliases_are_bounded_and_nonce_consumption_invalidates_every_alias() {
    let mut c = cancelled();
    prepare(&mut c, 1_000_000, 1);
    ctx("borrower.testnet", 1000);
    let packets: Vec<_> = (1..=5)
        .map(|k| alternate_signature(&c, 0x11, k, |_| {}))
        .collect();
    for p in &packets[..4] {
        assert!(c.adopt_signature(p.clone()));
    }
    assert_eq!(c.get_signed_transactions().len(), 4);
    assert!(!c.adopt_signature(packets[4].clone()));
    assert!(c.adopt_signature(packets[1].clone()));
    let chosen = c.get_signed_transactions()[2].hash.clone();
    confirm_candidate(&mut c, 2, "1", 0);
    assert!(c.get_signed_transactions().is_empty());
    ctx("borrower.testnet", 1000);
    assert!(!c.adopt_signature(packets[0].clone()));
    panic(|| {
        drop(c.confirm_settlement(
            chosen,
            ConfirmationBundle {
                checkpoint: bundle(1, 0),
                transaction_index: "0".into(),
            },
            None,
        ));
    });
}
#[test]
fn wrong_payload_signature_vault_scheme_recovery_and_scalar_are_rejected_without_unlocking() {
    let mut c = cancelled();
    prepare(&mut c, 1_000_000, 1);
    ctx("borrower.testnet", 1000);
    let bad = [
        alternate_signature(&c, 0x11, 1, |i| i.nonce += 1),
        alternate_signature(&c, 0x11, 1, |i| i.value -= 1),
        alternate_signature(&c, 0x11, 1, |i| i.gas_price += 1),
        alternate_signature(&c, 0x11, 1, |i| i.to = [0x22; 20]),
        alternate_signature(&c, 0x12, 1, |_| {}),
    ];
    for packet in bad {
        assert!(!c.adopt_signature(packet));
        assert!(c.get_signed_transactions().is_empty());
    }
    for (field, value) in [
        ("scheme", serde_json::json!("Ed25519")),
        ("recovery_id", serde_json::json!(2)),
        ("extra", serde_json::json!(true)),
    ] {
        let mut p: serde_json::Value = serde_json::from_str(&signature(&c)).unwrap();
        p[field] = value;
        assert!(!c.adopt_signature(p.to_string()));
    }
    let mut p: serde_json::Value = serde_json::from_str(&signature(&c)).unwrap();
    p["s"]["scalar"] = serde_json::json!("00".repeat(32));
    assert!(!c.adopt_signature(p.to_string()));
    assert!(c.loan.as_ref().unwrap().settlement.intent.is_some());
}
#[test]
fn settlement_callback_bounds_clock_field_binding_and_fee_floor_preserve_branch_lock() {
    for mutation in [
        "request_hash",
        "beneficiary",
        "expected_nonce",
        "generation",
        "base_fee_per_gas",
    ] {
        let mut c = cancelled();
        ctx("borrower.testnet", 1000);
        drop(c.prepare_settlement(bundle(0, 1_000_000), U128(1)));
        let p = c.pending.as_ref().unwrap();
        let request = p.generation;
        let r: SettlementRequest = serde_json::from_slice(&p.input).unwrap();
        let e = verify_prepare(&p.input, &observations(&r), 1000).unwrap();
        let mut v = serde_json::to_value(e).unwrap();
        v[mutation] = serde_json::json!(if mutation == "request_hash" {
            hx(&[0; 32])
        } else if mutation == "beneficiary" {
            hx(&[0x33; 20])
        } else if mutation == "generation" {
            "3".into()
        } else {
            "2".into()
        });
        context(
            "controller.testnet",
            1000,
            vec![PromiseResult::Successful(serde_json::to_vec(&v).unwrap())],
        );
        assert!(!c.on_settlement_result(U64(request)), "{mutation}");
        assert!(c.loan.as_ref().unwrap().settlement.intent.is_none());
        assert_eq!(c.loan.as_ref().unwrap().phase, LoanPhase::CancelLocked);
    }
    for results in [
        vec![],
        vec![PromiseResult::Failed, PromiseResult::Failed],
        vec![PromiseResult::Successful(vec![b' '; 8193])],
    ] {
        let mut c = cancelled();
        ctx("borrower.testnet", 1000);
        drop(c.prepare_settlement(bundle(0, 1_000_000), U128(1)));
        let request = c.pending.as_ref().unwrap().generation;
        context("controller.testnet", 1000, results);
        assert!(!c.on_settlement_result(U64(request)));
        assert!(c.loan.as_ref().unwrap().settlement.intent.is_none());
    }
    let mut c = cancelled();
    ctx("borrower.testnet", 1000);
    drop(c.prepare_settlement(bundle(0, 1_000_000), U128(1)));
    let p = c.pending.as_ref().unwrap();
    let request = p.generation;
    let r: SettlementRequest = serde_json::from_slice(&p.input).unwrap();
    let e = verify_prepare(&p.input, &observations(&r), 1000).unwrap();
    context(
        "controller.testnet",
        1601,
        vec![PromiseResult::Successful(serde_json::to_vec(&e).unwrap())],
    );
    assert!(!c.on_settlement_result(U64(request)));
    assert_eq!(c.loan.as_ref().unwrap().phase, LoanPhase::CancelLocked);
}
#[test]
fn settlement_module_and_digest_are_pinned_and_confirmation_timeout_keeps_signed_candidates() {
    let mut c = cancelled();
    ctx("borrower.testnet", 1000);
    drop(c.prepare_settlement(bundle(0, 1_000_000), U128(1)));
    let calls = get_created_receipts();
    let args = calls
        .iter()
        .flat_map(|r| r.actions.iter())
        .find_map(|a| {
            if let MockAction::FunctionCallWeight {
                method_name, args, ..
            } = a
            {
                if method_name == b"request_execution" {
                    Some(serde_json::from_slice::<serde_json::Value>(args).unwrap())
                } else {
                    None
                }
            } else {
                None
            }
        })
        .unwrap();
    assert_eq!(
        args["source"]["WasmUrl"]["url"],
        "https://example.com/settlement.wasm"
    );
    assert_eq!(
        args["source"]["WasmUrl"]["hash"],
        "11a8f330d8f6698c9e644230d37e86ebb7c985d77a697b05934a0bf482404758"
    );
    assert!(args["secrets_ref"].is_null() && args["params"].is_null());
    assert_eq!(
        rino_settlement_protocol::settlement_request_digest(
            args["input_data"].as_str().unwrap().as_bytes()
        ),
        c.pending.as_ref().unwrap().input_hash
    );
    ctx("borrower.testnet", 1601);
    c.expire_pending();
    assert_eq!(
        c.loan.as_ref().unwrap().settlement.stage,
        settlement::SettlementStage::Idle
    );
    prepare(&mut c, 1_000_000, 1);
    ctx("borrower.testnet", 1000);
    assert!(c.adopt_signature(signature(&c)));
    let hash = c.get_signed_transactions()[0].hash.clone();
    drop(c.confirm_settlement(
        hash,
        ConfirmationBundle {
            checkpoint: bundle(1, 0),
            transaction_index: "0".into(),
        },
        None,
    ));
    let old = c.pending.as_ref().unwrap().generation;
    ctx("lender.testnet", 1601);
    c.expire_pending();
    assert_eq!(
        c.loan.as_ref().unwrap().settlement.stage,
        settlement::SettlementStage::Signed
    );
    assert!(c.loan.as_ref().unwrap().settlement.intent.is_some());
    assert_eq!(c.get_signed_transactions().len(), 1);
    context("controller.testnet", 1601, vec![PromiseResult::Failed]);
    assert!(!c.on_settlement_result(U64(old)));
    assert_eq!(c.get_signed_transactions().len(), 1);
}

#[test]
fn testnet_settlement_derives_fixed_secret_profile_from_current_controller() {
    for account in ["controller.testnet", "fresh-controller.testnet"] {
        let mut c = cancelled();
        c.config.network = NetworkMode::NearTestnet;
        c.config.executor = id("outlayer.testnet");
        let mut ctx = near_sdk::test_utils::VMContextBuilder::new();
        ctx.current_account_id(id(account))
            .predecessor_account_id(id("borrower.testnet"))
            .block_timestamp(1000 * 1_000_000_000)
            .prepaid_gas(near_sdk::Gas::from_tgas(300));
        near_sdk::testing_env!(ctx.build());
        drop(c.prepare_settlement(bundle(0, 1_000_000), U128(1)));
        let args = get_created_receipts()
            .iter()
            .flat_map(|r| &r.actions)
            .find_map(|a| match a {
                MockAction::FunctionCallWeight {
                    method_name, args, ..
                } if method_name == b"request_execution" => {
                    Some(serde_json::from_slice::<serde_json::Value>(args).unwrap())
                }
                _ => None,
            })
            .unwrap();
        assert_eq!(
            args["secrets_ref"],
            serde_json::json!({"profile":"rino-rpc-v1","account_id":account})
        );
        assert_eq!(args["payer_account_id"], account);
        assert!(args["params"].is_null());
        assert_eq!(args.as_object().unwrap().len(), 7);
    }
}
#[test]
fn closed_participants_can_unregister_and_reregister_after_their_obligations_clear() {
    use near_contract_standards::storage_management::StorageManagement;
    use near_sdk::{Gas, NearToken, test_utils::VMContextBuilder, testing_env};
    let mut c = funded();
    c.vault = Some(VAULT.into());
    ctx("lender.testnet", 1000);
    c.ft_transfer(id("borrower.testnet"), U128(1_000_000), None);
    ctx("borrower.testnet", 1000);
    c.borrow();
    c.repay();
    prepare(&mut c, 1_000_000, 1);
    ctx("borrower.testnet", 1000);
    assert!(c.adopt_signature(signature(&c)));
    confirm(&mut c, "1", 0);
    ctx("borrower.testnet", 1000);
    assert!(c.storage_unregister(None));
    assert!(c.storage_balance_of(id("borrower.testnet")).is_none());
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(id("controller.testnet"))
            .predecessor_account_id(id("borrower.testnet"))
            .block_timestamp(1_000_000_000_000)
            .attached_deposit(NearToken::from_near(1))
            .prepaid_gas(Gas::from_tgas(300))
            .account_balance(NearToken::from_near(100))
            .build()
    );
    c.storage_deposit(None, None);
    assert!(c.storage_balance_of(id("borrower.testnet")).is_some());
    ctx("lender.testnet", 1000);
    panic(|| {
        c.storage_unregister(Some(true));
    });
    c.claim_credit();
    c.ft_transfer(id("borrower.testnet"), U128(1_000_000_000), None);
    assert!(c.storage_unregister(None));
    ctx("controller.testnet", 1000);
    panic(|| {
        c.storage_unregister(Some(true));
    });
}
fn historical_header(balance: u128) -> InclusionHeader {
    let included = bundle(1, balance);
    InclusionHeader {
        block_number: included.block_number,
        block_hash: included.block_hash,
        state_root: included.state_root,
        block_timestamp: included.block_timestamp,
        base_fee_per_gas: "1".into(),
    }
}
fn fresh_checkpoint(balance: u128, now: u64) -> SettlementBundle {
    let mut fresh = bundle(1, balance);
    fresh.block_number = "124".into();
    fresh.block_hash = hx(&[0x55; 32]);
    fresh.block_timestamp = now.to_string();
    fresh
}
#[test]
fn superseded_fifth_signature_can_confirm_actual_inclusion_without_a_fifth_relay_alias() {
    let mut c = cancelled();
    prepare(&mut c, 1_000_000, 1);
    ctx("borrower.testnet", 1000);
    let packets: Vec<_> = (1..=5)
        .map(|k| alternate_signature(&c, 0x11, k, |_| {}))
        .collect();
    for packet in &packets[..3] {
        assert!(c.adopt_signature(packet.clone()));
    }
    drop(c.request_signature());
    ctx("borrower.testnet", 1601);
    c.expire_pending();
    drop(c.retry_signature());
    let superseded = c.pending.as_ref().unwrap().generation;
    assert!(c.adopt_signature(packets[3].clone()));
    assert_eq!(c.get_signed_transactions().len(), 4);
    context(
        "controller.testnet",
        1601,
        vec![PromiseResult::Successful(packets[4].as_bytes().to_vec())],
    );
    assert!(!c.on_signature_result(U64(superseded)));
    ctx("borrower.testnet", 1601);
    assert!(!c.adopt_signature(packets[4].clone()));
    let f = &c
        .loan
        .as_ref()
        .unwrap()
        .settlement
        .intent
        .as_ref()
        .unwrap()
        .transfer;
    let candidate = rino_loan_core::verify_mpc_signature(
        f,
        rino_settlement_protocol::fixed_hex::<20>(VAULT).unwrap(),
        packets[4].as_bytes(),
    )
    .unwrap();
    let hash = hx(&candidate.hash);
    drop(c.confirm_settlement(
        hash.clone(),
        ConfirmationBundle {
            checkpoint: fresh_checkpoint(0, 1601),
            transaction_index: "0".into(),
        },
        Some(packets[4].clone()),
    ));
    assert_eq!(c.get_signed_transactions().len(), 4);
    let p = c.pending.as_ref().unwrap();
    let r: SettlementRequest = serde_json::from_slice(&p.input).unwrap();
    let SettlementPurpose::Confirm {
        candidate: bound, ..
    } = &r.purpose
    else {
        panic!("wrong purpose")
    };
    assert_eq!(bound.hash, hash);
    let (id, raw) = confirmation_output(&c, "1", 1601, Some(historical_header(0)), "1");
    context(
        "controller.testnet",
        1601,
        vec![PromiseResult::Successful(raw)],
    );
    assert!(c.on_settlement_result(U64(id)));
    assert!(!c.on_settlement_result(U64(id)));
    let s = c.get_settlement().unwrap();
    assert_eq!(
        (
            s.expected_nonce.0,
            s.fees_paid_wei.0,
            s.borrower_surplus_wei.0
        ),
        (1, 21_000, 979_000)
    );
    assert_eq!(c.get_signed_transactions().len(), 0);
    ctx("borrower.testnet", 1601);
    panic(|| {
        drop(c.confirm_settlement(
            hash,
            ConfirmationBundle {
                checkpoint: fresh_checkpoint(0, 1601),
                transaction_index: "0".into(),
            },
            Some(packets[4].clone()),
        ));
    });
}
#[test]
fn direct_confirmation_rejects_unknown_missing_forged_mismatched_and_oversized_packets() {
    let mut c = cancelled();
    prepare(&mut c, 1_000_000, 1);
    ctx("borrower.testnet", 1000);
    let packets: Vec<_> = (1..=5)
        .map(|k| alternate_signature(&c, 0x11, k, |_| {}))
        .collect();
    for p in &packets[..4] {
        assert!(c.adopt_signature(p.clone()));
    }
    let f = &c
        .loan
        .as_ref()
        .unwrap()
        .settlement
        .intent
        .as_ref()
        .unwrap()
        .transfer;
    let candidate = rino_loan_core::verify_mpc_signature(
        f,
        rino_settlement_protocol::fixed_hex::<20>(VAULT).unwrap(),
        packets[4].as_bytes(),
    )
    .unwrap();
    let hash = hx(&candidate.hash);
    let stored = c.get_signed_transactions()[0].hash.clone();
    let bad = [
        None,
        Some("null".into()),
        Some(" ".repeat(1025)),
        Some(alternate_signature(&c, 0x12, 5, |_| {})),
        Some(alternate_signature(&c, 0x11, 5, |i| i.nonce += 1)),
        Some(alternate_signature(&c, 0x11, 5, |i| i.value -= 1)),
    ];
    for packet in bad {
        panic(|| {
            drop(c.confirm_settlement(
                hash.clone(),
                ConfirmationBundle {
                    checkpoint: bundle(1, 0),
                    transaction_index: "0".into(),
                },
                packet,
            ));
        });
        assert!(c.pending.is_none());
        assert_eq!(c.get_signed_transactions().len(), 4);
    }
    for claimed in [hx(&[0; 32]), stored.clone()] {
        panic(|| {
            drop(c.confirm_settlement(
                claimed,
                ConfirmationBundle {
                    checkpoint: bundle(1, 0),
                    transaction_index: "0".into(),
                },
                Some(packets[4].clone()),
            ));
        });
        assert!(c.pending.is_none());
    }
    // A provided packet is checked even when the hash already names a relay alias.
    drop(c.confirm_settlement(
        stored,
        ConfirmationBundle {
            checkpoint: bundle(1, 979_000),
            transaction_index: "0".into(),
        },
        Some(packets[0].clone()),
    ));
    let (id, raw) = confirmation_output(&c, "0", 1000, None, "1");
    context(
        "controller.testnet",
        1000,
        vec![PromiseResult::Successful(raw)],
    );
    assert!(c.on_settlement_result(U64(id)));
    assert_eq!(c.get_settlement().unwrap().borrower_surplus_wei.0, 0);
}
#[test]
fn historical_confirmation_records_inclusion_block_and_keeps_fresh_incoming_state_for_next_plan() {
    let mut c = cancelled();
    prepare(&mut c, 1_000_000, 1);
    ctx("borrower.testnet", 1000);
    assert!(c.adopt_signature(signature(&c)));
    let hash = c.get_signed_transactions()[0].hash.clone();
    ctx("borrower.testnet", 10_000);
    drop(c.confirm_settlement(
        hash,
        ConfirmationBundle {
            checkpoint: fresh_checkpoint(10_000_000, 9900),
            transaction_index: "0".into(),
        },
        None,
    ));
    let (id, raw) = confirmation_output(&c, "1", 10_000, Some(historical_header(0)), "100");
    context(
        "controller.testnet",
        10_000,
        vec![PromiseResult::Successful(raw)],
    );
    assert!(c.on_settlement_result(U64(id)));
    let s = c.get_settlement().unwrap();
    assert_eq!(s.checkpoint_block_number.unwrap().0, 124);
    assert_eq!(s.last_confirmation.unwrap().block_number.0, 123);
    assert_eq!(s.balance_wei.0, 10_000_000);
    assert!(!s.retired);
    // The next attempt must meet the fresh checkpoint fee, not the historical inclusion fee.
    for (price, accepted) in [(1, false), (100, true)] {
        ctx("borrower.testnet", 10_000);
        drop(c.prepare_settlement(fresh_checkpoint(10_000_000, 9900), U128(price)));
        let p = c.pending.as_ref().unwrap();
        let request = p.generation;
        let r: SettlementRequest = serde_json::from_slice(&p.input).unwrap();
        let mut o = observations(&r);
        for observation in &mut o {
            observation.base_fee_per_gas = "100".into();
        }
        let e = verify_prepare(&p.input, &o, 10_000).unwrap();
        context(
            "controller.testnet",
            10_000,
            vec![PromiseResult::Successful(serde_json::to_vec(&e).unwrap())],
        );
        assert_eq!(c.on_settlement_result(U64(request)), accepted);
    }
    let intent = c.get_settlement().unwrap().current_intent.unwrap().transfer;
    assert_eq!(
        (
            intent.nonce.as_str(),
            intent.value.as_str(),
            intent.gas_price.as_str()
        ),
        ("1", "7900000", "100")
    );
}
#[test]
fn settlement_gas_schedule_reserves_entry_headroom_and_requires_full_300_tgas() {
    use near_sdk::{Gas, NearToken, test_utils::VMContextBuilder, testing_env};
    let set_gas = |gas: u64| {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id(id("controller.testnet"))
                .predecessor_account_id(id("borrower.testnet"))
                .signer_account_id(id("borrower.testnet"))
                .block_timestamp(1_000_000_000_000)
                .prepaid_gas(Gas::from_gas(gas))
                .account_balance(NearToken::from_near(100))
                .build()
        );
    };
    // Both an ordinary underfunded call and the exact one-gas boundary reject
    // before a pending request or external promise can be created.
    for gas in [299_000_000_000_000, 299_999_999_999_999] {
        let mut c = cancelled();
        set_gas(gas);
        let generation = c.generation;
        panic(|| {
            drop(c.prepare_settlement(bundle(0, 1_000_000), U128(1)));
        });
        assert!(c.pending.is_none());
        assert_eq!(c.generation, generation);
        assert!(get_created_receipts().is_empty());
    }
    let assert_schedule = || {
        let calls: Vec<_> = get_created_receipts()
            .into_iter()
            .flat_map(|r| r.actions)
            .filter_map(|action| {
                if let MockAction::FunctionCallWeight {
                    method_name,
                    prepaid_gas,
                    ..
                } = action
                {
                    Some((
                        String::from_utf8(method_name).unwrap(),
                        prepaid_gas.as_gas(),
                    ))
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(
            calls,
            vec![
                ("request_execution".into(), 140_000_000_000_000),
                ("on_settlement_result".into(), 90_000_000_000_000)
            ]
        );
        assert_eq!(
            300_000_000_000_000 - calls.iter().map(|c| c.1).sum::<u64>(),
            70_000_000_000_000
        );
    };
    let mut c = cancelled();
    set_gas(300_000_000_000_000);
    drop(c.prepare_settlement(bundle(0, 1_000_000), U128(1)));
    assert!(c.pending.is_some());
    assert_schedule();
    // The actual direct-packet confirmation route uses the same schedule;
    // this native assertion provisions gas, not a substitute for receipt measurement.
    let mut c = cancelled();
    prepare(&mut c, 1_000_000, 1);
    let packet = signature(&c);
    let transfer = c
        .loan
        .as_ref()
        .unwrap()
        .settlement
        .intent
        .as_ref()
        .unwrap()
        .transfer;
    let candidate = rino_loan_core::verify_mpc_signature(
        &transfer,
        rino_settlement_protocol::fixed_hex::<20>(VAULT).unwrap(),
        packet.as_bytes(),
    )
    .unwrap();
    set_gas(300_000_000_000_000);
    drop(c.confirm_settlement(
        hx(&candidate.hash),
        ConfirmationBundle {
            checkpoint: bundle(1, 0),
            transaction_index: "0".into(),
        },
        Some(packet),
    ));
    assert_schedule();
    let mut c = cancelled();
    prepare(&mut c, 20_000, 1);
    set_gas(300_000_000_000_000);
    drop(c.add_fee_budget(bundle(0, 22_000), U128(2_000)));
    assert_schedule();
}

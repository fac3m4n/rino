use proofcredit_loan_core::*;
use serde_json::{json, Value};
fn vectors() -> Vec<Value> {
    serde_json::from_str(include_str!("fixtures/viem-2.57.19.json")).unwrap()
}
fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().unwrap().trim_start_matches("0x")).unwrap()
}
fn intent(v: &Value) -> TransferIntent {
    TransferIntent {
        chain_id: 11_155_111,
        nonce: v["nonce"].as_u64().unwrap(),
        to: bytes(&v["to"]).try_into().unwrap(),
        value: v["value"].as_str().unwrap().parse().unwrap(),
        gas_limit: 21000,
        gas_price: 100_000_000_000,
    }
}
fn vault(v: &Value) -> [u8; 20] {
    bytes(&v["vault"]).try_into().unwrap()
}
#[test]
fn independent_viem_preimages_hashes_raw_and_recovery_include_leading_zero_scalars() {
    for v in vectors() {
        let i = intent(&v);
        assert_eq!(signing_preimage(&i).unwrap(), bytes(&v["preimage"]));
        assert_eq!(signing_digest(&i).unwrap().as_slice(), bytes(&v["digest"]));
        let signed =
            verify_mpc_signature(&i, vault(&v), &serde_json::to_vec(&v["mpc"]).unwrap()).unwrap();
        assert_eq!(signed.raw, bytes(&v["raw"]));
        assert_eq!(signed.hash.as_slice(), bytes(&v["hash"]));
        assert_eq!(signed_transaction_hash(&signed.raw), signed.hash);
        assert_eq!(signed.signing_digest, signing_digest(&i).unwrap());
    }
}
#[test]
fn tampering_exact_intent_fields_cannot_recover_expected_vault() {
    let v = &vectors()[0];
    let base = intent(v);
    let mpc = serde_json::to_vec(&v["mpc"]).unwrap();
    let mut changed = base;
    changed.nonce += 1;
    let mut to = base;
    to.to = [3; 20];
    let mut amount = base;
    amount.value += 1;
    let mut fee = base;
    fee.gas_price -= 1;
    for i in [changed, to, amount, fee] {
        assert_eq!(
            verify_mpc_signature(&i, vault(v), &mpc),
            Err(Error::WrongVault)
        );
    }
    let mut wrong_chain = base;
    wrong_chain.chain_id = 1;
    assert_eq!(signing_preimage(&wrong_chain), Err(Error::InvalidIntent));
    let mut gas = base;
    gas.gas_limit = 21001;
    assert_eq!(signing_preimage(&gas), Err(Error::InvalidIntent));
    let mut zero = base;
    zero.value = 0;
    assert_eq!(signing_preimage(&zero), Err(Error::InvalidIntent));
    zero = base;
    zero.to = [0; 20];
    assert_eq!(signing_preimage(&zero), Err(Error::InvalidIntent));
}
#[test]
fn strict_mpc_schema_scalar_point_and_recovery_validation() {
    let v = &vectors()[0];
    let i = intent(v);
    let valid = v["mpc"].clone();
    let mut bads = vec![json!({}), json!({"scheme":"Ed25519"})];
    for (key, val) in [
        ("extra", json!(1)),
        ("scheme", json!("Ed25519")),
        ("recovery_id", json!(2)),
        ("recovery_id", json!(27)),
        ("recovery_id", json!("0")),
    ] {
        let mut b = valid.clone();
        b[key] = val;
        bads.push(b);
    }
    for s in [
        "00".repeat(32),
        "ff".repeat(32),
        "01".repeat(31),
        format!("0x{}", "01".repeat(32)),
    ] {
        let mut b = valid.clone();
        b["s"]["scalar"] = json!(s);
        bads.push(b);
    }
    for r in [
        "00".repeat(33),
        format!("02{}", "ff".repeat(32)),
        "04".repeat(33),
    ] {
        let mut b = valid.clone();
        b["big_r"]["affine_point"] = json!(r);
        bads.push(b);
    }
    let mut b = valid.clone();
    b["s"]["unknown"] = json!(0);
    bads.push(b);
    let mut b = valid.clone();
    b["big_r"]["unknown"] = json!(0);
    bads.push(b);
    for b in bads {
        assert!(
            verify_mpc_signature(&i, vault(v), &serde_json::to_vec(&b).unwrap()).is_err(),
            "accepted {b}"
        );
    }
    let mut recovery = valid.clone();
    recovery["recovery_id"] = json!(1 - valid["recovery_id"].as_u64().unwrap());
    assert!(verify_mpc_signature(&i, vault(v), &serde_json::to_vec(&recovery).unwrap()).is_err());
    assert_eq!(
        verify_mpc_signature(&i, [9; 20], &serde_json::to_vec(&valid).unwrap()),
        Err(Error::WrongVault)
    );
}
#[test]
fn high_s_is_rejected_and_signature_input_is_bounded_before_parse() {
    let v = &vectors()[0];
    let i = intent(v);
    let mut mpc = v["mpc"].clone();
    // n - s from the independent fixture, exact scalar arithmetic outside the kernel.
    let r: [u8; 32] = hex::decode(&mpc["big_r"]["affine_point"].as_str().unwrap()[2..])
        .unwrap()
        .try_into()
        .unwrap();
    let s: [u8; 32] = hex::decode(mpc["s"]["scalar"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let low = k256::ecdsa::Signature::from_scalars(r, s).unwrap();
    let high = -*low.s();
    mpc["s"]["scalar"] = json!(hex::encode(high.to_bytes()));
    assert_eq!(
        verify_mpc_signature(&i, vault(v), &serde_json::to_vec(&mpc).unwrap()),
        Err(Error::HighS)
    );
    let mut raw = serde_json::to_vec(&v["mpc"]).unwrap();
    raw.resize(1024, b' ');
    assert!(verify_mpc_signature(&i, vault(v), &raw).is_ok());
    raw.push(b' ');
    assert_eq!(
        verify_mpc_signature(&i, vault(v), &raw),
        Err(Error::SignatureTooLarge)
    );
    assert_eq!(
        verify_mpc_signature(&i, vault(v), b"{"),
        Err(Error::MalformedSignature)
    );
}

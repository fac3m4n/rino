use rino_proof_protocol::CheckpointObservation;
use rino_settlement_protocol::*;
use rlp::RlpStream;
use serde_json::Value;
use tiny_keccak::{Hasher, Keccak};
pub const NOW: u64 = 10000;
pub fn hx(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}
fn unhex(s: &str) -> Vec<u8> {
    hex::decode(&s[2..]).unwrap()
}
pub fn keccak(b: &[u8]) -> [u8; 32] {
    let mut h = Keccak::v256();
    h.update(b);
    let mut o = [0; 32];
    h.finalize(&mut o);
    o
}
fn leaf(address: &str, nonce: u64, balance: u64, code: &str, skip: usize) -> Vec<u8> {
    let key = keccak(&unhex(address));
    let n: Vec<u8> = key
        .iter()
        .flat_map(|b| [b >> 4, b & 15])
        .skip(skip)
        .collect();
    let mut p = if n.len() % 2 == 1 {
        vec![0x30 | n[0]]
    } else {
        vec![0x20]
    };
    for pair in n[usize::from(n.len() % 2 == 1)..].chunks(2) {
        p.push((pair[0] << 4) | pair[1]);
    }
    let mut a = RlpStream::new_list(4);
    a.append(&nonce);
    a.append(&balance);
    a.append(&keccak(&[0x80]).as_slice());
    a.append(&unhex(code));
    let mut l = RlpStream::new_list(2);
    l.append(&p);
    l.append(&a.out().to_vec());
    l.out().to_vec()
}
pub fn fixture(
    nonce: u64,
    balance: u64,
    code: &str,
    recipient_code: Option<&str>,
) -> SettlementRequest {
    let vault = "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a";
    let to = hx(&[0x22; 20]);
    let l = leaf(vault, nonce, balance, code, 0);
    let (root, vp, bp) = if let Some(rc) = recipient_code {
        let k1 = keccak(&unhex(vault))[0] >> 4;
        let k2 = keccak(&unhex(&to))[0] >> 4;
        assert_ne!(k1, k2);
        let a = leaf(vault, nonce, balance, code, 1);
        let b = leaf(&to, 0, 1, rc, 1);
        let mut branch = RlpStream::new_list(17);
        for i in 0..17 {
            if i == usize::from(k1) {
                branch.append(&keccak(&a).as_slice());
            } else if i == usize::from(k2) {
                branch.append(&keccak(&b).as_slice());
            } else {
                branch.append_empty_data();
            }
        }
        let raw = branch.out();
        (
            hx(&keccak(&raw)),
            vec![hx(&raw), hx(&a)],
            vec![hx(&raw), hx(&b)],
        )
    } else {
        (hx(&keccak(&l)), vec![hx(&l)], vec![hx(&l)])
    };
    SettlementRequest {
        schema_version: 1,
        policy_id: POLICY_ID.into(),
        controller_id: "controller.testnet".into(),
        request_id: "42".into(),
        generation: "1".into(),
        chain_id: CHAIN_ID.to_string(),
        vault: vault.into(),
        beneficiary: to,
        expected_nonce: nonce.to_string(),
        requested_at: NOW.to_string(),
        expires_at: (NOW + 600).to_string(),
        purpose: SettlementPurpose::Prepare,
        bundle: SettlementBundle {
            block_number: "123".into(),
            block_hash: hx(&[0x44; 32]),
            state_root: root,
            block_timestamp: "9900".into(),
            vault_account_proof: vp,
            beneficiary_account_proof: bp,
        },
    }
}
pub fn obs(r: &SettlementRequest) -> [SettlementObservation; 2] {
    PROVIDER_IDS.map(|id| SettlementObservation {
        inclusion_header: None,
        base_fee_per_gas: "10000000000".into(),
        checkpoint: CheckpointObservation {
            provider_id: id.into(),
            chain_id: r.chain_id.clone(),
            finalized_number: "123".into(),
            block_number: r.bundle.block_number.clone(),
            block_hash: r.bundle.block_hash.clone(),
            state_root: r.bundle.state_root.clone(),
            block_timestamp: r.bundle.block_timestamp.clone(),
        },
        transaction: None,
        receipt: None,
    })
}
pub fn enc<T: serde::Serialize>(v: &T) -> Vec<u8> {
    serde_json::to_vec(v).unwrap()
}
pub fn prepare(r: &SettlementRequest) -> Result<SettlementEvidence, ProtocolError> {
    verify_prepare(&enc(r), &obs(r), NOW)
}
pub fn confirm_fixture(
    status: &str,
    post_balance: u64,
) -> (SettlementRequest, [SettlementObservation; 2]) {
    let v: Value = serde_json::from_str(include_str!(
        "../../../loan-core/tests/fixtures/viem-2.57.19.json"
    ))
    .unwrap();
    let v = &v[1];
    let mut r = fixture(112, post_balance, EMPTY_CODE_HASH, None);
    r.expected_nonce = "111".into();
    let intent = TransferIntentDto {
        chain_id: r.chain_id.clone(),
        nonce: "111".into(),
        to: r.beneficiary.clone(),
        value: v["value"].as_str().unwrap().into(),
        gas_limit: "21000".into(),
        gas_price: v["gas_price"].as_str().unwrap().into(),
    };
    let candidate = SignedTransactionDto {
        raw: v["raw"].as_str().unwrap().into(),
        hash: v["hash"].as_str().unwrap().into(),
        signing_digest: v["digest"].as_str().unwrap().into(),
        r: format!(
            "0x{}",
            &v["mpc"]["big_r"]["affine_point"].as_str().unwrap()[2..]
        ),
        s: format!("0x{}", v["mpc"]["s"]["scalar"].as_str().unwrap()),
        y_parity: "1".into(),
    };
    r.purpose = SettlementPurpose::Confirm {
        intent: intent.clone(),
        candidate: candidate.clone(),
        before_balance_wei: "3000000000000000".into(),
        minimum_block_number: "122".into(),
        transaction_index: "0".into(),
    };
    let tx = TransactionObservation {
        hash: candidate.hash.clone(),
        chain_id: r.chain_id.clone(),
        nonce: "111".into(),
        from: r.vault.clone(),
        to: r.beneficiary.clone(),
        value: intent.value,
        gas: "21000".into(),
        max_fee_per_gas: intent.gas_price.clone(),
        max_priority_fee_per_gas: intent.gas_price,
        transaction_type: "2".into(),
        input: "0x".into(),
        empty_access_list: true,
        r: candidate.r,
        s: candidate.s,
        y_parity: "1".into(),
        block_hash: r.bundle.block_hash.clone(),
        block_number: "123".into(),
        transaction_index: "0".into(),
    };
    let receipt = ReceiptObservation {
        transaction_hash: candidate.hash,
        transaction_index: "0".into(),
        block_hash: r.bundle.block_hash.clone(),
        block_number: "123".into(),
        from: r.vault.clone(),
        to: r.beneficiary.clone(),
        transaction_type: "2".into(),
        status: status.into(),
        gas_used: "21000".into(),
        effective_gas_price: "100000000000".into(),
        contract_address: None,
    };
    let mut o = obs(&r);
    for e in &mut o {
        e.inclusion_header = Some(InclusionHeader {
            block_number: r.bundle.block_number.clone(),
            block_hash: r.bundle.block_hash.clone(),
            state_root: r.bundle.state_root.clone(),
            block_timestamp: r.bundle.block_timestamp.clone(),
            base_fee_per_gas: e.base_fee_per_gas.clone(),
        });
        e.transaction = Some(tx.clone());
        e.receipt = Some(receipt.clone());
    }
    (r, o)
}
pub fn confirm(
    r: &SettlementRequest,
    o: &[SettlementObservation; 2],
) -> Result<SettlementEvidence, ProtocolError> {
    verify_confirmation(&enc(r), o, NOW)
}

pub fn historical_confirm_fixture(
    status: &str,
    balance: u64,
) -> (SettlementRequest, [SettlementObservation; 2]) {
    let (mut r, mut observations) = confirm_fixture(status, balance);
    r.bundle.block_number = "124".into();
    r.bundle.block_hash = hx(&[0x55; 32]);
    for observation in &mut observations {
        let h = observation.inclusion_header.as_mut().unwrap();
        h.block_timestamp = "1000".into();
        h.state_root = hx(&[0x66; 32]);
        observation.checkpoint.block_number = r.bundle.block_number.clone();
        observation.checkpoint.block_hash = r.bundle.block_hash.clone();
        observation.checkpoint.finalized_number = r.bundle.block_number.clone();
        // A later base fee may have risen above the immutable old signed price.
        observation.base_fee_per_gas = "200000000000".into();
    }
    (r, observations)
}

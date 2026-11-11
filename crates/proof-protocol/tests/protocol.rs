use proofcredit_proof_protocol::{quantities::*, *};
use rlp::RlpStream;
use serde_json::json;
use tiny_keccak::{Hasher, Keccak};

mod capture {
    include!("fixtures/sepolia_account.rs");
}
const NOW: u64 = 10_000;
const MAX: &str = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
fn hex(bytes: &[u8]) -> String {
    format!(
        "0x{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}
fn bytes(text: &str) -> Vec<u8> {
    text.as_bytes()[2..]
        .chunks(2)
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect()
}
fn keccak(data: &[u8]) -> [u8; 32] {
    let mut out = [0; 32];
    let mut k = Keccak::v256();
    k.update(data);
    k.finalize(&mut out);
    out
}
// Explicitly synthetic funded account: address 0x11 repeated, nonce zero,
// balance exactly 1 ETH (10^18 wei), empty code and empty storage trie.
// Both observations below are synthetic; no chain/finality authority is claimed.
fn fixture_with(
    nonce: u64,
    balance: u64,
    code: &str,
) -> (ProofRequest, [CheckpointObservation; 2]) {
    let mut account = RlpStream::new_list(4);
    account.append(&nonce);
    account.append(&balance);
    account.append(&bytes(capture::STORAGE_ROOT));
    account.append(&bytes(code));
    let mut path = vec![0x20];
    path.extend_from_slice(&keccak(&[0x11; 20]));
    let mut leaf = RlpStream::new_list(2);
    leaf.append(&path);
    leaf.append(&account.out().to_vec());
    let raw = leaf.out();
    let request = ProofRequest {
        schema_version: 1,
        policy_id: POLICY_ID.into(),
        controller_id: "controller.testnet".into(),
        request_id: "42".into(),
        chain_id: "11155111".into(),
        vault: hex(&[0x11; 20]),
        requested_at: "10000".into(),
        expires_at: "10600".into(),
        bundle: ProofBundle {
            block_number: "123".into(),
            block_hash: hex(&[0x22; 32]),
            state_root: hex(&keccak(&raw)),
            block_timestamp: "9900".into(),
            account_proof: vec![hex(&raw)],
        },
    };
    let obs = observations(&request);
    (request, obs)
}
fn fixture() -> (ProofRequest, [CheckpointObservation; 2]) {
    fixture_with(0, 1_000_000_000_000_000_000, EMPTY_CODE_HASH)
}
fn observations(r: &ProofRequest) -> [CheckpointObservation; 2] {
    PROVIDER_IDS.map(|id| CheckpointObservation {
        provider_id: id.into(),
        chain_id: r.chain_id.clone(),
        finalized_number: "123".into(),
        block_number: r.bundle.block_number.clone(),
        block_hash: r.bundle.block_hash.clone(),
        state_root: r.bundle.state_root.clone(),
        block_timestamp: r.bundle.block_timestamp.clone(),
    })
}
fn encoded(r: &ProofRequest) -> Vec<u8> {
    serde_json::to_vec(r).unwrap()
}
fn verify(
    r: &ProofRequest,
    o: &[CheckpointObservation; 2],
    now: u64,
) -> Result<ProofEvidence, ProtocolError> {
    verify_request(&encoded(r), o, now)
}
fn evidence() -> (ProofRequest, Vec<u8>, ProofEvidence) {
    let (r, o) = fixture();
    let input = encoded(&r);
    let e = verify_request(&input, &o, NOW).unwrap();
    (r, input, e)
}

#[test]
fn valid_bound_account_yields_exact_proven_nonce_and_wei() {
    // Catches returning echoed/default balances or skipping actual account decoding.
    let (r, input, e) = evidence();
    assert_eq!(e.nonce, "0");
    assert_eq!(e.balance_wei, "1000000000000000000");
    assert_eq!(e.code_hash, EMPTY_CODE_HASH);
    assert_eq!(e.status, "verified");
    assert_eq!(e.finality_basis, "rpc-finalized-2of2");
    assert_eq!(
        validate_evidence(
            &serde_json::to_vec(&e).unwrap(),
            &r,
            &request_digest(&input),
            NOW
        ),
        Ok(e)
    );
}
#[test]
fn canonical_u256_boundaries() {
    assert_eq!(parse_u256("0"), Ok([0; 32]));
    assert_eq!(parse_u256(MAX), Ok([255; 32]));
    assert_eq!(format_u256(&[0; 32]), "0");
    assert_eq!(format_u256(&[255; 32]), MAX);
    for bad in [
        "",
        "01",
        "-1",
        "+1",
        "1.0",
        " 1",
        "1e1",
        "١",
        "115792089237316195423570985008687907853269984665640564039457584007913129639936",
    ] {
        assert!(parse_u256(bad).is_err(), "{bad}");
    }
}
#[test]
fn deterministic_integer_roundtrips_and_noncanonical_mutations() {
    let mut x = 0x123456789abcdef0_u64;
    for _ in 0..512 {
        let mut value = [0; 32];
        for chunk in value.chunks_mut(8) {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            chunk.copy_from_slice(&x.to_be_bytes());
        }
        let decimal = format_u256(&value);
        assert_eq!(parse_u256(&decimal), Ok(value));
        for mutation in [
            format!("0{decimal}"),
            format!("{decimal}.0"),
            format!("-{decimal}"),
        ] {
            assert!(parse_u256(&mutation).is_err());
        }
    }
    for value in [0_u64, 1, 255, 256, 65535, u64::MAX] {
        let mut n = [0; 32];
        n[24..].copy_from_slice(&value.to_be_bytes());
        assert_eq!(format_u256(&n), value.to_string());
        assert_eq!(parse_u256(&value.to_string()), Ok(n));
    }
}
#[test]
fn exact_bounds() {
    let (r, o) = fixture();
    let mut input = encoded(&r);
    input.resize(32768, b' ');
    assert!(verify_request(&input, &o, NOW).is_ok());
    input.push(b' ');
    assert_eq!(
        verify_request(&input, &o, NOW),
        Err(ProtocolError::InputTooLarge)
    );
    assert_eq!(
        verify_request(&vec![0xff; 32769], &o, NOW),
        Err(ProtocolError::InputTooLarge)
    );
    let (_, input, e) = evidence();
    let mut output = serde_json::to_vec(&e).unwrap();
    output.resize(8192, b' ');
    assert!(validate_evidence(&output, &r, &request_digest(&input), NOW).is_ok());
    output.push(b' ');
    assert_eq!(
        validate_evidence(&output, &r, &request_digest(&input), NOW),
        Err(ProtocolError::OutputTooLarge)
    );
}
#[test]
fn clock_boundaries() {
    let (r, o) = fixture();
    for now in [10000, 10600] {
        assert!(verify(&r, &o, now).is_ok());
    }
    for now in [9999, 10601] {
        assert!(verify(&r, &o, now).is_err());
    }
    for (start, end) in [(10000, 10601), (10001, 10000), (u64::MAX, u64::MAX - 1)] {
        let mut r = r.clone();
        r.requested_at = start.to_string();
        r.expires_at = end.to_string();
        assert!(verify(&r, &o, NOW).is_err());
    }
}
#[test]
fn checkpoint_boundaries() {
    let (mut r, _) = fixture();
    for (timestamp, pass) in [(6400, true), (6399, false), (10001, false)] {
        r.bundle.block_timestamp = timestamp.to_string();
        let o = observations(&r);
        assert_eq!(verify(&r, &o, NOW).is_ok(), pass);
    }
}
#[test]
fn wrong_chain_root_vault_provider_or_policy_rejects() {
    let (r, o) = fixture();
    for field in ["chain_id", "policy_id", "vault"] {
        let mut v = serde_json::to_value(&r).unwrap();
        v[field] = json!(if field == "vault" {
            hex(&[0x12; 20])
        } else {
            "wrong".into()
        });
        assert!(verify_request(&serde_json::to_vec(&v).unwrap(), &o, NOW).is_err());
    }
    let mut wrong = r.clone();
    wrong.bundle.state_root = hex(&[0x33; 32]);
    assert!(verify(&wrong, &observations(&wrong), NOW).is_err());
    for field in [
        "chain_id",
        "block_number",
        "block_hash",
        "state_root",
        "block_timestamp",
        "provider_id",
        "finalized_number",
    ] {
        for index in 0..2 {
            let mut v = serde_json::to_value(&o).unwrap();
            v[index][field] = json!(match field {
                "block_hash" | "state_root" => hex(&[0x44; 32]),
                "provider_id" => "unknown".into(),
                "block_timestamp" => "9899".into(),
                _ => "122".into(),
            });
            let wrong: [CheckpointObservation; 2] = serde_json::from_value(v).unwrap();
            assert!(verify(&r, &wrong, NOW).is_err(), "{field} #{index}");
        }
    }
    let mut duplicate = o.clone();
    duplicate[1].provider_id = duplicate[0].provider_id.clone();
    assert!(verify(&r, &duplicate, NOW).is_err());
    let swapped = [o[1].clone(), o[0].clone()];
    assert!(verify(&r, &swapped, NOW).is_ok());
}
#[test]
fn evidence_correlation() {
    let (r, input, e) = evidence();
    let digest = request_digest(&input);
    for field in [
        "request_hash",
        "request_id",
        "controller_id",
        "vault",
        "chain_id",
        "block_number",
        "block_hash",
        "state_root",
        "block_timestamp",
        "policy_id",
        "status",
        "finality_basis",
        "unexpected",
    ] {
        let mut value = serde_json::to_value(&e).unwrap();
        value[field] = json!(match field {
            "request_hash" | "block_hash" | "state_root" => hex(&[0x77; 32]),
            "vault" => hex(&[0x77; 20]),
            "request_id" | "chain_id" | "block_number" | "block_timestamp" => "43".into(),
            "controller_id" => "other.testnet".into(),
            _ => "wrong".into(),
        });
        assert!(
            validate_evidence(&serde_json::to_vec(&value).unwrap(), &r, &digest, NOW).is_err(),
            "{field}"
        );
    }
    assert!(validate_evidence(&serde_json::to_vec(&e).unwrap(), &r, &[0; 32], NOW).is_err());
    for now in [9999, 10601] {
        assert!(validate_evidence(&serde_json::to_vec(&e).unwrap(), &r, &digest, now).is_err());
    }
    let mut stale = r.clone();
    stale.bundle.block_timestamp = "6399".into();
    let mut e = e.clone();
    e.block_timestamp = "6399".into();
    assert!(validate_evidence(&serde_json::to_vec(&e).unwrap(), &stale, &digest, NOW).is_err());
}
#[test]
fn zero_balance_nonzero_nonce_or_account_code_cannot_yield_verified_evidence() {
    for (nonce, balance, code) in [
        (0, 0, EMPTY_CODE_HASH),
        (1, 1, EMPTY_CODE_HASH),
        (0, 1, capture::STORAGE_ROOT),
    ] {
        let (r, o) = fixture_with(nonce, balance, code);
        assert!(verify(&r, &o, NOW).is_err());
    }
    let (r, input, e) = evidence();
    for (field, value) in [
        ("nonce", "1"),
        ("nonce", "18446744073709551616"),
        ("balance_wei", "0"),
        ("balance_wei", "01"),
        ("code_hash", capture::STORAGE_ROOT),
    ] {
        let mut v = serde_json::to_value(&e).unwrap();
        v[field] = json!(value);
        assert!(validate_evidence(
            &serde_json::to_vec(&v).unwrap(),
            &r,
            &request_digest(&input),
            NOW
        )
        .is_err());
    }
}
#[test]
fn strict_wire_shapes_and_canonical_fields() {
    let (r, o) = fixture();
    for field in ["request_id", "chain_id", "requested_at", "expires_at"] {
        for bad in [
            json!(1),
            json!("01"),
            json!("-1"),
            json!("1.0"),
            json!("18446744073709551616"),
        ] {
            let mut v = serde_json::to_value(&r).unwrap();
            v[field] = bad;
            assert!(
                verify_request(&serde_json::to_vec(&v).unwrap(), &o, NOW).is_err(),
                "{field}"
            );
        }
    }
    for controller in [
        "A.testnet",
        "a",
        "a..testnet",
        "a_-b.testnet",
        "-a.testnet",
        "a/.testnet",
    ] {
        let mut r = r.clone();
        r.controller_id = controller.into();
        assert!(verify(&r, &o, NOW).is_err());
    }
    for (field, bad) in [
        ("vault", json!("0X1111111111111111111111111111111111111111")),
        ("schema_version", json!(1.0)),
        ("schema_version", json!("1")),
        ("schema_version", json!(2)),
        ("unknown", json!(true)),
    ] {
        let mut v = serde_json::to_value(&r).unwrap();
        v[field] = bad;
        assert!(verify_request(&serde_json::to_vec(&v).unwrap(), &o, NOW).is_err());
    }
    let mut v = serde_json::to_value(&r).unwrap();
    v["bundle"]["extra"] = json!(true);
    assert!(verify_request(&serde_json::to_vec(&v).unwrap(), &o, NOW).is_err());
    for field in ["block_hash", "state_root"] {
        let mut r = r.clone();
        match field {
            "block_hash" => r.bundle.block_hash = hex(&[0xab; 32]).to_uppercase(),
            _ => r.bundle.state_root = "0x00".into(),
        };
        assert!(verify(&r, &o, NOW).is_err());
    }
    let output=serde_json::to_vec(&json!({"provider_id":"publicnode","chain_id":"11155111","finalized_number":"123","block_number":"123","block_hash":r.bundle.block_hash,"state_root":r.bundle.state_root,"block_timestamp":"9900","extra":true})).unwrap();
    assert!(serde_json::from_slice::<CheckpointObservation>(&output).is_err());
}
#[test]
fn malformed_absent_and_over_limit_proofs_reject() {
    let (r, o) = fixture();
    for nodes in [
        vec![],
        vec!["0x0".into()],
        vec!["0xAA".into()],
        vec!["0xzz".into()],
        vec![format!("0x{}", "00".repeat(1025))],
        vec!["0x00".into(); 66],
    ] {
        let mut r = r.clone();
        r.bundle.account_proof = nodes;
        assert!(verify(&r, &o, NOW).is_err());
    }
    let raw = bytes(&r.bundle.account_proof[0]);
    for byte in 0..raw.len() {
        let mut r = r.clone();
        let mut changed = raw.clone();
        changed[byte] ^= 1;
        r.bundle.account_proof[0] = hex(&changed);
        assert!(verify(&r, &o, NOW).is_err());
    }
    let mut r = r.clone();
    r.bundle.state_root = hex(&keccak(&[0x80]));
    r.bundle.account_proof.clear();
    assert!(verify(&r, &observations(&r), NOW).is_err());
}
#[test]
fn digest_is_sha256_of_exact_input_bytes() {
    assert_eq!(
        hex(&request_digest(b"abc")),
        "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    let (r, o) = fixture();
    let input = encoded(&r);
    let mut spaced = input.clone();
    spaced.push(b' ');
    assert_ne!(
        verify_request(&input, &o, NOW).unwrap().request_hash,
        verify_request(&spaced, &o, NOW).unwrap().request_hash
    );
}
#[test]
fn captured_proof_regression_retains_original_metadata_without_finality_claim() {
    // Capture metadata and unmodified RPC node strings are retained in fixtures/.
    // Only these two observations are synthetic, not claims about capture finality.
    let (mut r, _) = fixture();
    r.vault = capture::ADDRESS.into();
    r.bundle.state_root = capture::STATE_ROOT.into();
    r.bundle.block_number = "12114654".into();
    r.bundle.block_hash =
        "0x3e182d9c3ff5291ec28cefa32f14023fe2137c07f1cc8fdb64bc776084a8335a".into();
    let now = 0x6af4ea58_u64;
    r.requested_at = now.to_string();
    r.expires_at = (now + 600).to_string();
    r.bundle.block_timestamp = now.to_string();
    r.bundle.account_proof = capture::NODES.iter().map(|s| (*s).into()).collect();
    let mut o = observations(&r);
    for observation in &mut o {
        observation.finalized_number = r.bundle.block_number.clone();
    }
    let e = verify(&r, &o, now).unwrap();
    assert_eq!(e.balance_wei, "134063687988144710887678");
    assert_eq!(e.nonce, "0");
    assert_eq!(capture::NONCE, "0x0");
    assert_eq!(capture::BALANCE, "0x1c639b6a255b488828fe");
    assert_eq!(e.code_hash, capture::CODE_HASH);
}

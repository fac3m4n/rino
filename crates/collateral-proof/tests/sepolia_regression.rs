use rino_collateral_proof::{verify_account, AccountState, ProofError};

mod capture {
    include!("fixtures/sepolia_account.rs");
}

fn bytes(hex: &str) -> Vec<u8> {
    let mut digits = hex.strip_prefix("0x").unwrap().to_string();
    if !digits.len().is_multiple_of(2) {
        digits.insert(0, '0');
    }
    digits
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn uint256(hex: &str) -> [u8; 32] {
    let value = bytes(hex);
    let mut out = [0; 32];
    out[32 - value.len()..].copy_from_slice(&value);
    out
}

#[test]
fn captured_sepolia_account_matches_original_rpc_values_under_captured_root() {
    let root = bytes(capture::STATE_ROOT).try_into().unwrap();
    let address = bytes(capture::ADDRESS).try_into().unwrap();
    let nodes: Vec<_> = capture::NODES.iter().map(|n| bytes(n)).collect();
    let expected_nonce = u64::from_str_radix(capture::NONCE.trim_start_matches("0x"), 16).unwrap();
    assert_eq!(
        verify_account(&root, &address, &nodes),
        Ok(Some(AccountState {
            nonce: expected_nonce,
            balance_wei: uint256(capture::BALANCE),
            storage_root: bytes(capture::STORAGE_ROOT).try_into().unwrap(),
            code_hash: bytes(capture::CODE_HASH).try_into().unwrap(),
        }))
    );
}

#[test]
fn every_captured_node_is_required_and_corruption_of_every_byte_fails() {
    let root = bytes(capture::STATE_ROOT).try_into().unwrap();
    let address = bytes(capture::ADDRESS).try_into().unwrap();
    let nodes: Vec<_> = capture::NODES.iter().map(|n| bytes(n)).collect();
    let mut tampered = nodes.clone();
    for index in 0..nodes.len() {
        for byte in 0..nodes[index].len() {
            tampered[index][byte] ^= 1;
            assert_eq!(
                verify_account(&root, &address, &tampered),
                Err(ProofError::InvalidProof),
                "node {index}, byte {byte} corruption was accepted"
            );
            tampered[index][byte] ^= 1;
        }
        assert_eq!(
            verify_account(&root, &address, &nodes[..index]),
            Err(ProofError::InvalidProof),
            "truncated proof with {index} nodes was accepted"
        );
    }
}

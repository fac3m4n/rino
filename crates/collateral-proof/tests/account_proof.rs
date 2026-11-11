use proofcredit_collateral_proof::{
    verify_account, AccountState, ProofError, MAX_NODE_BYTES, MAX_PROOF_NODES,
};
use rlp::RlpStream;
use tiny_keccak::{Hasher, Keccak};

const ADDRESS: [u8; 20] = [0x11; 20];

fn hash(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak::v256();
    let mut out = [0; 32];
    hasher.update(bytes);
    hasher.finalize(&mut out);
    out
}

fn account(nonce: &[u8], balance: &[u8]) -> Vec<u8> {
    let mut rlp = RlpStream::new_list(4);
    rlp.append(&nonce);
    rlp.append(&balance);
    rlp.append(&[0x22u8; 32].as_slice());
    rlp.append(&[0x33u8; 32].as_slice());
    rlp.out().to_vec()
}

fn leaf(path: &[u8], value: &[u8]) -> Vec<u8> {
    let mut rlp = RlpStream::new_list(2);
    rlp.append(&path);
    rlp.append(&value);
    rlp.out().to_vec()
}

fn account_leaf(value: &[u8]) -> Vec<u8> {
    let mut path = vec![0x20];
    path.extend_from_slice(&hash(&ADDRESS));
    leaf(&path, value)
}

fn fixture() -> ([u8; 32], Vec<Vec<u8>>) {
    let node = account_leaf(&account(&[7], &[1, 0, 0]));
    (hash(&node), vec![node])
}

#[test]
fn decodes_nonce_and_integer_wei_from_included_account() {
    let (root, proof) = fixture();
    let mut balance = [0; 32];
    balance[29..].copy_from_slice(&[1, 0, 0]);
    assert_eq!(
        verify_account(&root, &ADDRESS, &proof),
        Ok(Some(AccountState {
            nonce: 7,
            balance_wei: balance,
            storage_root: [0x22; 32],
            code_hash: [0x33; 32],
        }))
    );
}

#[test]
fn preserves_full_256_bit_balance_and_maximum_nonce() {
    let node = account_leaf(&account(&[0xff; 8], &[0xff; 32]));
    let proven = verify_account(&hash(&node), &ADDRESS, &[node])
        .unwrap()
        .unwrap();
    assert_eq!(proven.balance_wei, [0xff; 32]);
    assert_eq!(proven.nonce, u64::MAX);
}

#[test]
fn zero_integers_are_empty_rlp_scalars() {
    let node = account_leaf(&account(&[], &[]));
    let proven = verify_account(&hash(&node), &ADDRESS, &[node])
        .unwrap()
        .unwrap();
    assert_eq!(proven.balance_wei, [0; 32]);
    assert_eq!(proven.nonce, 0);
}

#[test]
fn an_inclusion_for_a_different_address_is_absence_not_credit() {
    let (root, proof) = fixture();
    assert_eq!(verify_account(&root, &[0x12; 20], &proof), Ok(None));
}

#[test]
fn distinguishes_empty_trie_absence_from_missing_proof() {
    assert_eq!(verify_account(&hash(&[0x80]), &ADDRESS, &[]), Ok(None));
    assert_eq!(
        verify_account(&[0x41; 32], &ADDRESS, &[]),
        Err(ProofError::InvalidProof)
    );
}

#[test]
fn changed_node_or_wrong_root_cannot_prove_the_account() {
    let (root, mut proof) = fixture();
    *proof[0].last_mut().unwrap() ^= 1;
    assert_eq!(
        verify_account(&root, &ADDRESS, &proof),
        Err(ProofError::InvalidProof)
    );
    let (_, proof) = fixture();
    assert_eq!(
        verify_account(&[0x41; 32], &ADDRESS, &proof),
        Err(ProofError::InvalidProof)
    );
}

#[test]
fn rejects_unused_trailing_proof_nodes() {
    let (root, mut proof) = fixture();
    proof.push(proof[0].clone());
    assert_eq!(
        verify_account(&root, &ADDRESS, &proof),
        Err(ProofError::InvalidProof)
    );
}

#[test]
fn malformed_hex_prefix_flags_and_even_padding_fail_closed() {
    for flag in [0x40, 0x21] {
        let mut path = vec![flag];
        path.extend_from_slice(&hash(&ADDRESS));
        let node = leaf(&path, &account(&[], &[1]));
        assert_eq!(
            verify_account(&hash(&node), &ADDRESS, &[node]),
            Err(ProofError::InvalidPath)
        );
    }
}

#[test]
fn rejects_rlp_trailing_bytes_even_if_root_matches() {
    let (_, mut proof) = fixture();
    proof[0].push(0x80);
    assert_eq!(
        verify_account(&hash(&proof[0]), &ADDRESS, &proof),
        Err(ProofError::InvalidRlp)
    );
}

#[test]
fn rejects_malformed_last_rlp_child_and_nonminimal_scalar_encoding() {
    let mut stream = RlpStream::new_list(3);
    stream.append(&[0x20u8].as_slice());
    stream.append(&account(&[], &[1]));
    // Declares a one-byte scalar but supplies no payload. A permissive iterator
    // could stop here and mistake this three-field list for a two-field leaf.
    stream.append_raw(&[0x81], 1);
    let node = stream.out().to_vec();
    assert_eq!(
        verify_account(&hash(&node), &ADDRESS, &[node]),
        Err(ProofError::InvalidRlp)
    );

    let mut stream = RlpStream::new_list(4);
    // Single-byte 0x01 must be encoded directly, without a string prefix.
    stream.append_raw(&[0x81, 0x01], 1);
    stream.append(&[1u8].as_slice());
    stream.append(&[0x22u8; 32].as_slice());
    stream.append(&[0x33u8; 32].as_slice());
    let node = account_leaf(&stream.out());
    assert_eq!(
        verify_account(&hash(&node), &ADDRESS, &[node]),
        Err(ProofError::InvalidAccount)
    );
}

#[test]
fn rejects_account_trailing_data_and_empty_extension_paths() {
    let mut value = account(&[], &[1]);
    value.push(0x80);
    let node = account_leaf(&value);
    assert_eq!(
        verify_account(&hash(&node), &ADDRESS, &[node]),
        Err(ProofError::InvalidAccount)
    );
    let node = leaf(&[0x00], &[0x22; 32]);
    assert_eq!(
        verify_account(&hash(&node), &ADDRESS, &[node]),
        Err(ProofError::InvalidPath)
    );
}

#[test]
fn rejects_noncanonical_account_integers_and_width_overflow() {
    for (nonce, balance) in [
        (vec![0], vec![1]),
        (vec![0, 1], vec![1]),
        (vec![1; 9], vec![1]),
        (vec![1], vec![0]),
        (vec![1], vec![0, 1]),
        (vec![1], vec![1; 33]),
    ] {
        let node = account_leaf(&account(&nonce, &balance));
        assert_eq!(
            verify_account(&hash(&node), &ADDRESS, &[node]),
            Err(ProofError::InvalidAccount)
        );
    }
}

#[test]
fn rejects_wrong_account_field_count_and_root_widths() {
    for (count, root_width) in [(3, 32), (5, 32), (4, 31), (4, 33)] {
        let mut rlp = RlpStream::new_list(count);
        rlp.append_empty_data();
        rlp.append(&[1u8].as_slice());
        rlp.append(&vec![0x22; root_width]);
        if count >= 4 {
            rlp.append(&[0x33u8; 32].as_slice());
        }
        if count == 5 {
            rlp.append_empty_data();
        }
        let node = account_leaf(&rlp.out());
        assert_eq!(
            verify_account(&hash(&node), &ADDRESS, &[node]),
            Err(ProofError::InvalidAccount)
        );
    }
}

#[test]
fn bounds_untrusted_proof_work() {
    let (root, proof) = fixture();
    assert_eq!(
        verify_account(
            &root,
            &ADDRESS,
            &vec![proof[0].clone(); MAX_PROOF_NODES + 1]
        ),
        Err(ProofError::LimitExceeded)
    );
    assert_eq!(
        verify_account(&root, &ADDRESS, &[vec![0; MAX_NODE_BYTES + 1]]),
        Err(ProofError::LimitExceeded)
    );
    assert_eq!(
        verify_account(
            &root,
            &ADDRESS,
            &vec![vec![0; MAX_NODE_BYTES]; MAX_PROOF_NODES]
        ),
        Err(ProofError::LimitExceeded)
    );
}

#[test]
fn follows_hashed_branch_and_extension_nodes_and_rejects_truncation() {
    let key = hash(&ADDRESS);
    let mut rest = vec![0x30 | (key[1] & 0x0f)];
    rest.extend_from_slice(&key[2..]);
    let terminal = leaf(&rest, &account(&[], &[1]));
    let mut branch = RlpStream::new_list(17);
    for index in 0..16 {
        if index == (key[1] >> 4) as usize {
            branch.append(&hash(&terminal).as_slice());
        } else if index == ((key[1] >> 4) as usize + 1) % 16 {
            // A real branch has at least two children. The other subtree's
            // hash is opaque and need not be expanded along this proof path.
            branch.append(&[0x44u8; 32].as_slice());
        } else {
            branch.append_empty_data();
        }
    }
    branch.append_empty_data();
    let branch = branch.out().to_vec();
    let extension = leaf(&[0, key[0]], &hash(&branch));
    let root = hash(&extension);
    let proof = vec![extension, branch, terminal];
    assert_eq!(
        verify_account(&root, &ADDRESS, &proof)
            .unwrap()
            .unwrap()
            .balance_wei[31],
        1
    );
    assert_eq!(
        verify_account(&root, &ADDRESS, &proof[..2]),
        Err(ProofError::InvalidProof)
    );
}

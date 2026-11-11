//! Ethereum account inclusion under a caller-supplied state root.
//! This core does not authenticate the root, establish finality or authorize credit.
//!
//! Trie traversal is adapted from OutLayer's MIT-licensed eth-proof-example.
//! See THIRD_PARTY_NOTICES.md for provenance and the preserved license.

use rlp::Rlp;
use tiny_keccak::{Hasher, Keccak};

pub type Hash = [u8; 32];
pub type Address = [u8; 20];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountState {
    pub nonce: u64,
    /// Unsigned 256-bit big-endian wei, without truncation or floating point.
    pub balance_wei: [u8; 32],
    pub storage_root: Hash,
    pub code_hash: Hash,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProofError {
    InvalidProof,
    InvalidRlp,
    InvalidPath,
    InvalidAccount,
    LimitExceeded,
}

pub const MAX_PROOF_NODES: usize = 65;
pub const MAX_NODE_BYTES: usize = 1024;
pub const MAX_PROOF_BYTES: usize = 65_536;

pub fn verify_account(
    state_root: &Hash,
    address: &Address,
    proof: &[Vec<u8>],
) -> Result<Option<AccountState>, ProofError> {
    if proof.len() > MAX_PROOF_NODES {
        return Err(ProofError::LimitExceeded);
    }
    let total_bytes = proof.iter().try_fold(0usize, |total, node| {
        if node.len() > MAX_NODE_BYTES {
            return Err(ProofError::LimitExceeded);
        }
        total
            .checked_add(node.len())
            .ok_or(ProofError::LimitExceeded)
    })?;
    if total_bytes > MAX_PROOF_BYTES {
        return Err(ProofError::LimitExceeded);
    }

    if proof.is_empty() && *state_root == keccak256(&[0x80]) {
        return Ok(None);
    }

    let key = nibbles(&keccak256(address));
    let mut offset = 0usize;
    let mut expected = *state_root;

    for (index, raw) in proof.iter().enumerate() {
        if keccak256(raw) != expected {
            return Err(ProofError::InvalidProof);
        }
        let fields = scalar_list(raw)?;
        match fields.len() {
            17 => {
                // Fixed-length secure account keys never terminate at a branch.
                // Account leaves are >32 bytes, so their ancestors are hash-referenced;
                // this account-only verifier does not implement short storage-trie nodes.
                if offset >= key.len() || !fields[16].is_empty() {
                    return Err(ProofError::InvalidPath);
                }
                if fields[..16].iter().any(|c| !c.is_empty() && c.len() != 32) {
                    return Err(ProofError::InvalidProof);
                }
                let child = &fields[key[offset] as usize];
                offset += 1;
                if child.is_empty() {
                    return finish(index, proof.len(), None);
                }
                expected = hash_field(child)?;
            }
            2 => {
                let (segment, is_leaf) = compact_path(&fields[0])?;
                let end = offset
                    .checked_add(segment.len())
                    .ok_or(ProofError::InvalidPath)?;
                if (is_leaf && end != key.len()) || (!is_leaf && end >= key.len()) {
                    return Err(ProofError::InvalidPath);
                }
                let account = if is_leaf {
                    Some(decode_account(&fields[1])?)
                } else {
                    expected = hash_field(&fields[1])?;
                    None
                };
                if key[offset..end] != segment {
                    return finish(index, proof.len(), None);
                }
                offset = end;
                if is_leaf {
                    return finish(index, proof.len(), account);
                }
            }
            _ => return Err(ProofError::InvalidProof),
        }
    }
    Err(ProofError::InvalidProof)
}

fn finish(
    index: usize,
    proof_len: usize,
    account: Option<AccountState>,
) -> Result<Option<AccountState>, ProofError> {
    if index + 1 != proof_len {
        return Err(ProofError::InvalidProof);
    }
    Ok(account)
}

fn keccak256(bytes: &[u8]) -> Hash {
    let mut result = [0u8; 32];
    let mut hasher = Keccak::v256();
    hasher.update(bytes);
    hasher.finalize(&mut result);
    result
}

fn nibbles(bytes: &[u8]) -> Vec<u8> {
    bytes
        .iter()
        .flat_map(|byte| [byte >> 4, byte & 0x0f])
        .collect()
}

fn compact_path(encoded: &[u8]) -> Result<(Vec<u8>, bool), ProofError> {
    let first = *encoded.first().ok_or(ProofError::InvalidPath)?;
    let flags = first >> 4;
    if flags > 3 || (flags & 1 == 0 && first & 0x0f != 0) {
        return Err(ProofError::InvalidPath);
    }
    let all = nibbles(encoded);
    let path = all[if flags & 1 == 0 { 2 } else { 1 }..].to_vec();
    let is_leaf = flags & 2 != 0;
    if !is_leaf && path.is_empty() {
        return Err(ProofError::InvalidPath);
    }
    Ok((path, is_leaf))
}

/// Parse every scalar explicitly: Rlp::iter() stops at the first invalid child,
/// which must not allow malformed trailing list payload to go unnoticed.
fn scalar_list(raw: &[u8]) -> Result<Vec<Vec<u8>>, ProofError> {
    let outer = Rlp::new(raw);
    let info = outer.payload_info().map_err(|_| ProofError::InvalidRlp)?;
    if !outer.is_list() || info.total() != raw.len() {
        return Err(ProofError::InvalidRlp);
    }
    let mut payload = &raw[info.header_len..];
    let mut fields = Vec::new();
    while !payload.is_empty() {
        let child = Rlp::new(payload);
        let info = child.payload_info().map_err(|_| ProofError::InvalidRlp)?;
        if !child.is_data() {
            return Err(ProofError::InvalidRlp);
        }
        let end = info.total();
        // val_at/as_val validate the short-string canonicality rule as well.
        let value = Rlp::new(&payload[..end])
            .as_val::<Vec<u8>>()
            .map_err(|_| ProofError::InvalidRlp)?;
        fields.push(value);
        if fields.len() > 17 {
            return Err(ProofError::InvalidRlp);
        }
        payload = &payload[end..];
    }
    Ok(fields)
}

fn hash_field(bytes: &[u8]) -> Result<Hash, ProofError> {
    bytes.try_into().map_err(|_| ProofError::InvalidProof)
}

fn decode_account(raw: &[u8]) -> Result<AccountState, ProofError> {
    let fields = scalar_list(raw).map_err(|_| ProofError::InvalidAccount)?;
    if fields.len() != 4 {
        return Err(ProofError::InvalidAccount);
    }
    let nonce = integer::<8>(&fields[0])?;
    let balance_wei = integer::<32>(&fields[1])?;
    let storage_root = fields[2]
        .as_slice()
        .try_into()
        .map_err(|_| ProofError::InvalidAccount)?;
    let code_hash = fields[3]
        .as_slice()
        .try_into()
        .map_err(|_| ProofError::InvalidAccount)?;
    Ok(AccountState {
        nonce: u64::from_be_bytes(nonce),
        balance_wei,
        storage_root,
        code_hash,
    })
}

fn integer<const N: usize>(encoded: &[u8]) -> Result<[u8; N], ProofError> {
    if encoded.len() > N || encoded.first() == Some(&0) {
        return Err(ProofError::InvalidAccount);
    }
    let mut result = [0; N];
    result[N - encoded.len()..].copy_from_slice(encoded);
    Ok(result)
}

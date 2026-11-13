use crate::{quantities::*, *};
use rino_collateral_proof::{verify_account, MAX_NODE_BYTES, MAX_PROOF_BYTES, MAX_PROOF_NODES};
use sha2::{Digest, Sha256};

/// Bound and validate the untrusted request before a worker makes RPC calls.
/// Header values remain untrusted until verify_request binds both observations.
pub fn parse_request(input: &[u8], now_seconds: u64) -> Result<ProofRequest, ProtocolError> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(ProtocolError::InputTooLarge);
    }
    let request: ProofRequest =
        serde_json::from_slice(input).map_err(|_| ProtocolError::InvalidJson)?;
    validate_request(&request, now_seconds)?;
    Ok(request)
}

/// Verify account inclusion and the fixed two-source finalized RPC policy.
/// Observation identity must be supplied by the fixed trusted RPC adapter.
/// This does not verify Ethereum consensus or execution hardware attestation.
pub fn verify_request(
    input: &[u8],
    observations: &[CheckpointObservation; 2],
    now_seconds: u64,
) -> Result<ProofEvidence, ProtocolError> {
    let request = parse_request(input, now_seconds)?;
    validate_observations(&request, observations)?;
    let root = decode_fixed::<32>(&request.bundle.state_root)?;
    let address = decode_fixed::<20>(&request.vault)?;
    // Length/count/total and canonical hex were checked before decoding any node.
    let proof: Vec<_> = request
        .bundle
        .account_proof
        .iter()
        .map(|node| decode_hex(node))
        .collect::<Result<_, _>>()?;
    let account = verify_account(&root, &address, &proof)
        .map_err(|_| ProtocolError::InvalidProof)?
        .ok_or(ProtocolError::AccountPolicy)?;
    let code_hash = encode_hex(&account.code_hash);
    if account.nonce != 0 || account.balance_wei == [0; 32] || code_hash != EMPTY_CODE_HASH {
        return Err(ProtocolError::AccountPolicy);
    }
    let evidence = ProofEvidence {
        schema_version: SCHEMA_VERSION,
        policy_id: POLICY_ID.into(),
        status: "verified".into(),
        controller_id: request.controller_id,
        request_id: request.request_id,
        request_hash: encode_hex(&request_digest(input)),
        chain_id: request.chain_id,
        vault: request.vault,
        block_number: request.bundle.block_number,
        block_hash: request.bundle.block_hash,
        state_root: request.bundle.state_root,
        block_timestamp: request.bundle.block_timestamp,
        nonce: account.nonce.to_string(),
        balance_wei: format_u256(&account.balance_wei),
        code_hash,
        finality_basis: FINALITY_BASIS.into(),
    };
    if serde_json::to_vec(&evidence)
        .map_err(|_| ProtocolError::InvalidJson)?
        .len()
        > MAX_OUTPUT_BYTES
    {
        return Err(ProtocolError::OutputTooLarge);
    }
    Ok(evidence)
}

/// Recheck a strictly parsed successful result against the pending request and
/// original input digest using current controller time. The caller must first
/// authenticate its promise; echoed fields do not authenticate an executor.
pub fn validate_evidence(
    output: &[u8],
    expected: &ProofRequest,
    expected_input_hash: &[u8; 32],
    now_seconds: u64,
) -> Result<ProofEvidence, ProtocolError> {
    if output.len() > MAX_OUTPUT_BYTES {
        return Err(ProtocolError::OutputTooLarge);
    }
    let evidence: ProofEvidence =
        serde_json::from_slice(output).map_err(|_| ProtocolError::InvalidJson)?;
    validate_request(expected, now_seconds)?;
    if evidence.schema_version != SCHEMA_VERSION
        || evidence.policy_id != POLICY_ID
        || evidence.status != "verified"
        || evidence.finality_basis != FINALITY_BASIS
        || evidence.controller_id != expected.controller_id
        || evidence.request_id != expected.request_id
        || evidence.request_hash != encode_hex(expected_input_hash)
        || evidence.chain_id != expected.chain_id
        || evidence.vault != expected.vault
        || evidence.block_number != expected.bundle.block_number
        || evidence.block_hash != expected.bundle.block_hash
        || evidence.state_root != expected.bundle.state_root
        || evidence.block_timestamp != expected.bundle.block_timestamp
    {
        return Err(ProtocolError::EvidenceMismatch);
    }
    if parse_u64(&evidence.nonce)? != 0
        || parse_u256(&evidence.balance_wei)? == [0; 32]
        || evidence.code_hash != EMPTY_CODE_HASH
    {
        return Err(ProtocolError::AccountPolicy);
    }
    Ok(evidence)
}

/// SHA-256 of the exact original input bytes, including JSON whitespace.
pub fn request_digest(input: &[u8]) -> [u8; 32] {
    Sha256::digest(input).into()
}

fn validate_request(request: &ProofRequest, now: u64) -> Result<(), ProtocolError> {
    if request.schema_version != SCHEMA_VERSION
        || request.policy_id != POLICY_ID
        || parse_u64(&request.chain_id)? != CHAIN_ID
        || !valid_near_account(&request.controller_id)
    {
        return Err(ProtocolError::InvalidRequest);
    }
    parse_u64(&request.request_id)?;
    let start = parse_u64(&request.requested_at)?;
    let end = parse_u64(&request.expires_at)?;
    let lifetime = end.checked_sub(start).ok_or(ProtocolError::InvalidTime)?;
    if start > now || now > end || lifetime > MAX_REQUEST_LIFETIME_SECONDS {
        return Err(ProtocolError::InvalidTime);
    }
    let timestamp = parse_u64(&request.bundle.block_timestamp)?;
    let age = now
        .checked_sub(timestamp)
        .ok_or(ProtocolError::InvalidTime)?;
    if age > MAX_CHECKPOINT_AGE_SECONDS {
        return Err(ProtocolError::InvalidTime);
    }
    parse_u64(&request.bundle.block_number)?;
    validate_hex(&request.vault, Some(20))?;
    validate_hex(&request.bundle.block_hash, Some(32))?;
    validate_hex(&request.bundle.state_root, Some(32))?;
    validate_proof_encoding(&request.bundle.account_proof)
}

fn validate_proof_encoding(proof: &[String]) -> Result<(), ProtocolError> {
    if proof.len() > MAX_PROOF_NODES {
        return Err(ProtocolError::ProofLimit);
    }
    let mut total = 0usize;
    for node in proof {
        if node.len() > 2 + MAX_NODE_BYTES * 2 {
            return Err(ProtocolError::ProofLimit);
        }
        let length = validate_hex(node, None)?;
        if length == 0 {
            return Err(ProtocolError::InvalidHex);
        }
        total = total.checked_add(length).ok_or(ProtocolError::ProofLimit)?;
        if total > MAX_PROOF_BYTES {
            return Err(ProtocolError::ProofLimit);
        }
    }
    Ok(())
}

fn validate_observations(
    request: &ProofRequest,
    observations: &[CheckpointObservation; 2],
) -> Result<(), ProtocolError> {
    if observations[0].provider_id == observations[1].provider_id {
        return Err(ProtocolError::InvalidCheckpoint);
    }
    let requested_number = parse_u64(&request.bundle.block_number)?;
    for observation in observations {
        if !PROVIDER_IDS.contains(&observation.provider_id.as_str())
            || observation.chain_id != request.chain_id
            || observation.block_number != request.bundle.block_number
            || observation.block_hash != request.bundle.block_hash
            || observation.state_root != request.bundle.state_root
            || observation.block_timestamp != request.bundle.block_timestamp
            || parse_u64(&observation.finalized_number)? < requested_number
        {
            return Err(ProtocolError::InvalidCheckpoint);
        }
    }
    Ok(())
}

fn valid_near_account(account: &str) -> bool {
    if !(2..=64).contains(&account.len()) {
        return false;
    }
    let mut previous_separator = true;
    for b in account.bytes() {
        let separator = matches!(b, b'-' | b'_' | b'.');
        if !(b.is_ascii_lowercase() || b.is_ascii_digit() || separator)
            || (separator && previous_separator)
        {
            return false;
        }
        previous_separator = separator;
    }
    !previous_separator
}

fn validate_hex(value: &str, expected_bytes: Option<usize>) -> Result<usize, ProtocolError> {
    let digits = value.strip_prefix("0x").ok_or(ProtocolError::InvalidHex)?;
    if digits.len() % 2 != 0
        || expected_bytes.is_some_and(|len| digits.len() != len * 2)
        || !digits
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(ProtocolError::InvalidHex);
    }
    Ok(digits.len() / 2)
}

fn decode_hex(value: &str) -> Result<Vec<u8>, ProtocolError> {
    validate_hex(value, None)?;
    value.as_bytes()[2..]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let nibble = |b| match b {
                b'0'..=b'9' => b - b'0',
                _ => b - b'a' + 10,
            };
            Ok((nibble(pair[0]) << 4) | nibble(pair[1]))
        })
        .collect()
}

fn decode_fixed<const N: usize>(value: &str) -> Result<[u8; N], ProtocolError> {
    validate_hex(value, Some(N))?;
    decode_hex(value)?
        .try_into()
        .map_err(|_| ProtocolError::InvalidHex)
}

fn encode_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(2 + bytes.len() * 2);
    output.push_str("0x");
    for b in bytes {
        output.push(char::from(DIGITS[(b >> 4) as usize]));
        output.push(char::from(DIGITS[(b & 15) as usize]));
    }
    output
}

use crate::*;
use proofcredit_collateral_proof::{
    verify_account, MAX_NODE_BYTES, MAX_PROOF_BYTES, MAX_PROOF_NODES,
};
use proofcredit_loan_core::{verify_mpc_signature, TransferIntent};
use proofcredit_proof_protocol::quantities::{format_u256, parse_u256};
use serde_json::json;
use sha2::{Digest, Sha256};

pub fn decimal_u64(s: &str) -> Result<u64, ProtocolError> {
    decimal_u128(s)?
        .try_into()
        .map_err(|_| ProtocolError::InvalidQuantity)
}
pub fn decimal_u128(s: &str) -> Result<u128, ProtocolError> {
    let n = parse_u256(s)?;
    if n[..16] != [0; 16] {
        return Err(ProtocolError::InvalidQuantity);
    }
    Ok(u128::from_be_bytes(
        n[16..]
            .try_into()
            .map_err(|_| ProtocolError::InvalidQuantity)?,
    ))
}
pub fn decode_hex(s: &str) -> Result<Vec<u8>, ProtocolError> {
    let digits = s.strip_prefix("0x").ok_or(ProtocolError::InvalidHex)?;
    if digits.len() % 2 != 0
        || !digits
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(ProtocolError::InvalidHex);
    }
    hex::decode(digits).map_err(|_| ProtocolError::InvalidHex)
}
pub fn fixed_hex<const N: usize>(s: &str) -> Result<[u8; N], ProtocolError> {
    if s.len() != 2 + 2 * N {
        return Err(ProtocolError::InvalidHex);
    }
    decode_hex(s)?
        .try_into()
        .map_err(|_| ProtocolError::InvalidHex)
}
fn encoded(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}
impl TransferIntentDto {
    pub fn to_native(&self) -> Result<TransferIntent, ProtocolError> {
        Ok(TransferIntent {
            chain_id: decimal_u64(&self.chain_id)?,
            nonce: decimal_u64(&self.nonce)?,
            to: fixed_hex(&self.to)?,
            value: decimal_u128(&self.value)?,
            gas_limit: decimal_u64(&self.gas_limit)?,
            gas_price: decimal_u128(&self.gas_price)?,
        })
    }
    pub fn from_native(i: &TransferIntent) -> Self {
        Self {
            chain_id: i.chain_id.to_string(),
            nonce: i.nonce.to_string(),
            to: encoded(&i.to),
            value: i.value.to_string(),
            gas_limit: i.gas_limit.to_string(),
            gas_price: i.gas_price.to_string(),
        }
    }
}
impl SignedTransactionDto {
    pub fn from_native(s: &proofcredit_loan_core::SignedTransaction) -> Self {
        Self {
            raw: encoded(&s.raw),
            hash: encoded(&s.hash),
            signing_digest: encoded(&s.signing_digest),
            r: encoded(&s.r),
            s: encoded(&s.s),
            y_parity: s.recovery_id.to_string(),
        }
    }
}
pub fn settlement_request_digest(input: &[u8]) -> [u8; 32] {
    Sha256::digest(input).into()
}
pub fn parse_settlement_request(
    input: &[u8],
    now: u64,
) -> Result<SettlementRequest, ProtocolError> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(ProtocolError::InputTooLarge);
    }
    let r: SettlementRequest =
        serde_json::from_slice(input).map_err(|_| ProtocolError::InvalidJson)?;
    validate_request(&r, now)?;
    Ok(r)
}
fn proof_encoding(proof: &[String]) -> Result<(), ProtocolError> {
    if proof.len() > MAX_PROOF_NODES {
        return Err(ProtocolError::ProofLimit);
    }
    let mut total = 0;
    for node in proof {
        if node.len() > 2 + MAX_NODE_BYTES * 2 {
            return Err(ProtocolError::ProofLimit);
        }
        let bytes = decode_hex(node)?;
        if bytes.is_empty() {
            return Err(ProtocolError::InvalidHex);
        }
        total += bytes.len();
        if total > MAX_PROOF_BYTES {
            return Err(ProtocolError::ProofLimit);
        }
    }
    Ok(())
}
fn valid_account(s: &str) -> bool {
    if !(2..=64).contains(&s.len()) {
        return false;
    }
    let mut separator = true;
    for b in s.bytes() {
        let next = matches!(b, b'-' | b'_' | b'.');
        if !(b.is_ascii_lowercase() || b.is_ascii_digit() || next) || (next && separator) {
            return false;
        }
        separator = next;
    }
    !separator
}
fn validate_request(r: &SettlementRequest, now: u64) -> Result<(), ProtocolError> {
    if r.schema_version != SCHEMA_VERSION
        || r.policy_id != POLICY_ID
        || decimal_u64(&r.chain_id)? != CHAIN_ID
        || !valid_account(&r.controller_id)
    {
        return Err(ProtocolError::InvalidRequest);
    }
    decimal_u64(&r.request_id)?;
    decimal_u64(&r.generation)?;
    decimal_u64(&r.expected_nonce)?;
    let start = decimal_u64(&r.requested_at)?;
    let end = decimal_u64(&r.expires_at)?;
    if start > now
        || now > end
        || end.checked_sub(start).ok_or(ProtocolError::InvalidTime)? > MAX_REQUEST_LIFETIME_SECONDS
    {
        return Err(ProtocolError::InvalidTime);
    }
    let timestamp = decimal_u64(&r.bundle.block_timestamp)?;
    if now
        .checked_sub(timestamp)
        .ok_or(ProtocolError::InvalidTime)?
        > MAX_CHECKPOINT_AGE_SECONDS
    {
        return Err(ProtocolError::InvalidTime);
    }
    let number = decimal_u64(&r.bundle.block_number)?;
    let vault = fixed_hex::<20>(&r.vault)?;
    let beneficiary = fixed_hex::<20>(&r.beneficiary)?;
    if vault == [0; 20] || beneficiary == [0; 20] || vault == beneficiary {
        return Err(ProtocolError::InvalidRequest);
    }
    fixed_hex::<32>(&r.bundle.block_hash)?;
    fixed_hex::<32>(&r.bundle.state_root)?;
    proof_encoding(&r.bundle.vault_account_proof)?;
    proof_encoding(&r.bundle.beneficiary_account_proof)?;
    if let SettlementPurpose::Confirm {
        intent,
        candidate,
        before_balance_wei,
        minimum_block_number,
        transaction_index,
    } = &r.purpose
    {
        let native = intent.to_native()?;
        if intent.chain_id != r.chain_id
            || intent.nonce != r.expected_nonce
            || intent.to != r.beneficiary
            || native.nonce == u64::MAX
            || decimal_u64(minimum_block_number)? > number
        {
            return Err(ProtocolError::InvalidRequest);
        }
        decimal_u64(transaction_index)?;
        let before = decimal_u128(before_balance_wei)?;
        let fee = native
            .gas_price
            .checked_mul(u128::from(native.gas_limit))
            .ok_or(ProtocolError::InvalidQuantity)?;
        if native
            .value
            .checked_add(fee)
            .ok_or(ProtocolError::InvalidQuantity)?
            > before
        {
            return Err(ProtocolError::AccountPolicy);
        }
        fixed_hex::<32>(&candidate.hash)?;
        fixed_hex::<32>(&candidate.signing_digest)?;
        fixed_hex::<32>(&candidate.r)?;
        fixed_hex::<32>(&candidate.s)?;
        let parity = decimal_u64(&candidate.y_parity)?;
        if parity > 1 || candidate.raw.len() > 1026 {
            return Err(ProtocolError::InvalidRequest);
        }
        decode_hex(&candidate.raw)?;
        let mpc=serde_json::to_vec(&json!({"scheme":"Secp256k1","big_r":{"affine_point":format!("0{}{}",2+parity,&candidate.r[2..])},"s":{"scalar":&candidate.s[2..]},"recovery_id":parity})).map_err(|_|ProtocolError::InvalidJson)?;
        let signed = verify_mpc_signature(&native, vault, &mpc)
            .map_err(|_| ProtocolError::InvalidRequest)?;
        if SignedTransactionDto::from_native(&signed) != *candidate {
            return Err(ProtocolError::InvalidRequest);
        }
    }
    Ok(())
}
fn validate_observations(
    r: &SettlementRequest,
    o: &[SettlementObservation; 2],
) -> Result<(), ProtocolError> {
    if o[0].base_fee_per_gas != o[1].base_fee_per_gas
        || o[0].checkpoint.provider_id == o[1].checkpoint.provider_id
    {
        return Err(ProtocolError::InvalidCheckpoint);
    }
    for item in o {
        decimal_u128(&item.base_fee_per_gas)?;
        let c = &item.checkpoint;
        if !PROVIDER_IDS.contains(&c.provider_id.as_str())
            || c.chain_id != r.chain_id
            || c.block_number != r.bundle.block_number
            || c.block_hash != r.bundle.block_hash
            || c.state_root != r.bundle.state_root
            || c.block_timestamp != r.bundle.block_timestamp
            || decimal_u64(&c.finalized_number)? < decimal_u64(&r.bundle.block_number)?
        {
            return Err(ProtocolError::InvalidCheckpoint);
        }
    }
    Ok(())
}
fn account(
    r: &SettlementRequest,
    address: &str,
    proof: &[String],
) -> Result<(u64, String, String), ProtocolError> {
    let nodes = proof
        .iter()
        .map(|p| decode_hex(p))
        .collect::<Result<Vec<_>, _>>()?;
    let a = verify_account(
        &fixed_hex(&r.bundle.state_root)?,
        &fixed_hex(address)?,
        &nodes,
    )
    .map_err(|_| ProtocolError::InvalidProof)?;
    Ok(match a {
        Some(a) => (a.nonce, format_u256(&a.balance_wei), encoded(&a.code_hash)),
        None => (0, "0".into(), EMPTY_CODE_HASH.into()),
    })
}
fn expected_transaction(r: &SettlementRequest) -> Result<TransactionObservation, ProtocolError> {
    let SettlementPurpose::Confirm {
        intent,
        candidate,
        transaction_index,
        ..
    } = &r.purpose
    else {
        return Err(ProtocolError::InvalidRequest);
    };
    Ok(TransactionObservation {
        hash: candidate.hash.clone(),
        chain_id: intent.chain_id.clone(),
        nonce: intent.nonce.clone(),
        from: r.vault.clone(),
        to: intent.to.clone(),
        value: intent.value.clone(),
        gas: intent.gas_limit.clone(),
        max_fee_per_gas: intent.gas_price.clone(),
        max_priority_fee_per_gas: intent.gas_price.clone(),
        transaction_type: "2".into(),
        input: "0x".into(),
        empty_access_list: true,
        r: candidate.r.clone(),
        s: candidate.s.clone(),
        y_parity: candidate.y_parity.clone(),
        block_hash: r.bundle.block_hash.clone(),
        block_number: r.bundle.block_number.clone(),
        transaction_index: transaction_index.clone(),
    })
}
fn validate_receipt(
    r: &SettlementRequest,
    receipt: &ReceiptObservation,
) -> Result<(), ProtocolError> {
    let SettlementPurpose::Confirm {
        intent,
        candidate,
        transaction_index,
        ..
    } = &r.purpose
    else {
        return Err(ProtocolError::InvalidRequest);
    };
    if receipt.transaction_hash != candidate.hash
        || receipt.transaction_index != *transaction_index
        || receipt.block_hash != r.bundle.block_hash
        || receipt.block_number != r.bundle.block_number
        || receipt.from != r.vault
        || receipt.to != r.beneficiary
        || receipt.transaction_type != "2"
        || !matches!(receipt.status.as_str(), "0" | "1")
        || receipt.gas_used != "21000"
        || receipt.effective_gas_price != intent.gas_price
        || receipt.contract_address.is_some()
    {
        return Err(ProtocolError::EvidenceMismatch);
    }
    Ok(())
}
fn evidence(
    r: &SettlementRequest,
    hash: &[u8; 32],
    base_fee_per_gas: &str,
    receipt: Option<ReceiptObservation>,
) -> Result<SettlementEvidence, ProtocolError> {
    let base_fee = decimal_u128(base_fee_per_gas)?;
    let (nonce, balance, code) = account(r, &r.vault, &r.bundle.vault_account_proof)?;
    if code != EMPTY_CODE_HASH {
        return Err(ProtocolError::AccountPolicy);
    }
    let beneficiary_code_hash = match &r.purpose {
        SettlementPurpose::Prepare => {
            if nonce != decimal_u64(&r.expected_nonce)? || receipt.is_some() {
                return Err(ProtocolError::AccountPolicy);
            }
            let (_, _, recipient_code) =
                account(r, &r.beneficiary, &r.bundle.beneficiary_account_proof)?;
            if recipient_code != EMPTY_CODE_HASH {
                return Err(ProtocolError::AccountPolicy);
            }
            Some(recipient_code)
        }
        SettlementPurpose::Confirm {
            intent,
            before_balance_wei,
            ..
        } => {
            let receipt = receipt.as_ref().ok_or(ProtocolError::EvidenceMismatch)?;
            if decimal_u128(&intent.gas_price)? < base_fee {
                return Err(ProtocolError::EvidenceMismatch);
            }
            validate_receipt(r, receipt)?;
            if nonce
                != decimal_u64(&r.expected_nonce)?
                    .checked_add(1)
                    .ok_or(ProtocolError::InvalidQuantity)?
            {
                return Err(ProtocolError::AccountPolicy);
            }
            let fee = decimal_u128(&intent.gas_price)?
                .checked_mul(21000)
                .ok_or(ProtocolError::InvalidQuantity)?;
            let paid = if receipt.status == "1" {
                decimal_u128(&intent.value)?
            } else {
                0
            };
            let floor = decimal_u128(before_balance_wei)?
                .checked_sub(paid)
                .and_then(|b| b.checked_sub(fee))
                .ok_or(ProtocolError::AccountPolicy)?;
            if decimal_u128(&balance)? < floor {
                return Err(ProtocolError::AccountPolicy);
            }
            None
        }
    };
    Ok(SettlementEvidence {
        schema_version: SCHEMA_VERSION,
        policy_id: POLICY_ID.into(),
        status: "verified".into(),
        controller_id: r.controller_id.clone(),
        request_id: r.request_id.clone(),
        generation: r.generation.clone(),
        request_hash: encoded(hash),
        chain_id: r.chain_id.clone(),
        vault: r.vault.clone(),
        beneficiary: r.beneficiary.clone(),
        expected_nonce: r.expected_nonce.clone(),
        purpose: r.purpose.clone(),
        block_number: r.bundle.block_number.clone(),
        block_hash: r.bundle.block_hash.clone(),
        state_root: r.bundle.state_root.clone(),
        block_timestamp: r.bundle.block_timestamp.clone(),
        nonce: nonce.to_string(),
        balance_wei: balance,
        code_hash: code,
        beneficiary_code_hash,
        base_fee_per_gas: base_fee_per_gas.into(),
        receipt,
        finality_basis: FINALITY_BASIS.into(),
    })
}
pub fn verify_prepare(
    input: &[u8],
    observations: &[SettlementObservation; 2],
    now: u64,
) -> Result<SettlementEvidence, ProtocolError> {
    let r = parse_settlement_request(input, now)?;
    if r.purpose != SettlementPurpose::Prepare
        || observations
            .iter()
            .any(|o| o.transaction.is_some() || o.receipt.is_some())
    {
        return Err(ProtocolError::InvalidRequest);
    }
    validate_observations(&r, observations)?;
    evidence(
        &r,
        &settlement_request_digest(input),
        &observations[0].base_fee_per_gas,
        None,
    )
}
pub fn verify_confirmation(
    input: &[u8],
    observations: &[SettlementObservation; 2],
    now: u64,
) -> Result<SettlementEvidence, ProtocolError> {
    let r = parse_settlement_request(input, now)?;
    let tx = expected_transaction(&r)?;
    validate_observations(&r, observations)?;
    if observations
        .iter()
        .any(|o| o.transaction.as_ref() != Some(&tx))
        || observations[0].receipt != observations[1].receipt
    {
        return Err(ProtocolError::EvidenceMismatch);
    }
    evidence(
        &r,
        &settlement_request_digest(input),
        &observations[0].base_fee_per_gas,
        observations[0].receipt.clone(),
    )
}
/// Authenticate the executor callback separately. Rechecks exact stored context,
/// MPT state, economic bounds and acceptance-time freshness before consumption.
pub fn validate_settlement_evidence(
    output: &[u8],
    expected: &SettlementRequest,
    expected_input_hash: &[u8; 32],
    now: u64,
) -> Result<SettlementEvidence, ProtocolError> {
    if output.len() > MAX_OUTPUT_BYTES {
        return Err(ProtocolError::OutputTooLarge);
    }
    let actual: SettlementEvidence =
        serde_json::from_slice(output).map_err(|_| ProtocolError::InvalidJson)?;
    validate_request(expected, now)?;
    let wanted = evidence(
        expected,
        expected_input_hash,
        &actual.base_fee_per_gas,
        actual.receipt.clone(),
    )?;
    if actual != wanted {
        return Err(ProtocolError::EvidenceMismatch);
    }
    Ok(actual)
}

use crate::{Error, TransferIntent, CHAIN_ID, GAS_LIMIT};
use borsh::{BorshDeserialize, BorshSerialize};
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use omni_transaction::evm::{types::Signature as OmniSignature, EVMTransaction};
use serde::Deserialize;
use tiny_keccak::{Hasher, Keccak};

pub const MAX_MPC_SIGNATURE_BYTES: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct SignedTransaction {
    pub raw: Vec<u8>,
    pub hash: [u8; 32],
    pub signing_digest: [u8; 32],
    pub r: [u8; 32],
    pub s: [u8; 32],
    pub recovery_id: u8,
}

fn transaction(intent: &TransferIntent) -> Result<EVMTransaction, Error> {
    if intent.chain_id != CHAIN_ID
        || intent.gas_limit != GAS_LIMIT
        || intent.gas_price == 0
        || intent.value == 0
        || intent.to == [0; 20]
    {
        return Err(Error::InvalidIntent);
    }
    intent
        .gas_price
        .checked_mul(u128::from(intent.gas_limit))
        .and_then(|fee| fee.checked_add(intent.value))
        .ok_or(Error::Overflow)?;
    Ok(EVMTransaction {
        chain_id: intent.chain_id,
        nonce: intent.nonce,
        to: Some(intent.to),
        value: intent.value,
        input: vec![],
        gas_limit: u128::from(intent.gas_limit),
        max_fee_per_gas: intent.gas_price,
        max_priority_fee_per_gas: intent.gas_price,
        access_list: vec![],
    })
}

pub fn signing_preimage(intent: &TransferIntent) -> Result<Vec<u8>, Error> {
    Ok(transaction(intent)?.build_for_signing())
}
pub fn signing_digest(intent: &TransferIntent) -> Result<[u8; 32], Error> {
    Ok(signed_transaction_hash(&signing_preimage(intent)?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MpcSignature {
    scheme: String,
    big_r: MpcPoint,
    s: MpcScalar,
    recovery_id: u8,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MpcPoint {
    affine_point: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MpcScalar {
    scalar: String,
}

fn decode<const N: usize>(text: &str) -> Result<[u8; N], Error> {
    if text.len() != 2 * N {
        return Err(Error::MalformedSignature);
    }
    let mut out = [0; N];
    hex::decode_to_slice(text, &mut out).map_err(|_| Error::MalformedSignature)?;
    Ok(out)
}

/// Strict current MPC tagged response; high-s is rejected, never normalized.
/// r/s leading zeroes are removed only for canonical Ethereum integer encoding.
pub fn verify_mpc_signature(
    intent: &TransferIntent,
    expected_vault: [u8; 20],
    raw_mpc_json: &[u8],
) -> Result<SignedTransaction, Error> {
    if raw_mpc_json.len() > MAX_MPC_SIGNATURE_BYTES {
        return Err(Error::SignatureTooLarge);
    }
    let response: MpcSignature =
        serde_json::from_slice(raw_mpc_json).map_err(|_| Error::MalformedSignature)?;
    if response.scheme != "Secp256k1" || response.recovery_id > 1 {
        return Err(Error::InvalidSignature);
    }
    let point = decode::<33>(&response.big_r.affine_point)?;
    let s = decode::<32>(&response.s.scalar)?;
    let r: [u8; 32] = point[1..].try_into().map_err(|_| Error::InvalidSignature)?;
    let signature = Signature::from_scalars(r, s).map_err(|_| Error::InvalidSignature)?;
    if signature.normalize_s().is_some() {
        return Err(Error::HighS);
    }
    if point[0] != 2 + response.recovery_id || k256::PublicKey::from_sec1_bytes(&point).is_err() {
        return Err(Error::InvalidSignature);
    }
    if expected_vault == [0; 20] || expected_vault == intent.to {
        return Err(Error::InvalidAddress);
    }
    let signing_digest = signing_digest(intent)?;
    let recovery_id = RecoveryId::from_byte(response.recovery_id).ok_or(Error::InvalidSignature)?;
    let recovered = VerifyingKey::recover_from_prehash(&signing_digest, &signature, recovery_id)
        .map_err(|_| Error::InvalidSignature)?;
    let public = recovered.to_encoded_point(false);
    let address_hash = signed_transaction_hash(&public.as_bytes()[1..]);
    if address_hash[12..] != expected_vault {
        return Err(Error::WrongVault);
    }
    let minimal = |scalar: &[u8]| {
        scalar
            .iter()
            .position(|b| *b != 0)
            .map_or_else(Vec::new, |first| scalar[first..].to_vec())
    };
    let raw = transaction(intent)?.build_with_signature(&OmniSignature {
        v: u64::from(response.recovery_id),
        r: minimal(&r),
        s: minimal(&s),
    });
    let hash = signed_transaction_hash(&raw);
    Ok(SignedTransaction {
        raw,
        hash,
        signing_digest,
        r,
        s,
        recovery_id: response.recovery_id,
    })
}

/// Keccak-256 of canonical signed bytes (also used internally for preimage/key hashes).
pub fn signed_transaction_hash(raw: &[u8]) -> [u8; 32] {
    let mut output = [0; 32];
    let mut hasher = Keccak::v256();
    hasher.update(raw);
    hasher.finalize(&mut output);
    output
}

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettlementRequest {
    pub schema_version: u32,
    pub policy_id: String,
    pub controller_id: String,
    pub request_id: String,
    pub generation: String,
    pub chain_id: String,
    pub vault: String,
    pub beneficiary: String,
    pub expected_nonce: String,
    pub requested_at: String,
    pub expires_at: String,
    pub purpose: SettlementPurpose,
    pub bundle: SettlementBundle,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
// A single bounded request owns this value; boxing only adds an allocation.
#[allow(clippy::large_enum_variant)]
pub enum SettlementPurpose {
    Prepare,
    Confirm {
        intent: TransferIntentDto,
        candidate: SignedTransactionDto,
        before_balance_wei: String,
        minimum_block_number: String,
        transaction_index: String,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransferIntentDto {
    pub chain_id: String,
    pub nonce: String,
    pub to: String,
    pub value: String,
    pub gas_limit: String,
    pub gas_price: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedTransactionDto {
    pub raw: String,
    pub hash: String,
    pub signing_digest: String,
    pub r: String,
    pub s: String,
    pub y_parity: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettlementBundle {
    pub block_number: String,
    pub block_hash: String,
    pub state_root: String,
    pub block_timestamp: String,
    pub vault_account_proof: Vec<String>,
    pub beneficiary_account_proof: Vec<String>,
}
/// Adapter-normalized transaction fields. Provider identity never comes from RPC JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransactionObservation {
    pub hash: String,
    pub chain_id: String,
    pub nonce: String,
    pub from: String,
    pub to: String,
    pub value: String,
    pub gas: String,
    pub max_fee_per_gas: String,
    pub max_priority_fee_per_gas: String,
    pub transaction_type: String,
    pub input: String,
    pub empty_access_list: bool,
    pub r: String,
    pub s: String,
    pub y_parity: String,
    pub block_hash: String,
    pub block_number: String,
    pub transaction_index: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptObservation {
    pub transaction_hash: String,
    pub transaction_index: String,
    pub block_hash: String,
    pub block_number: String,
    pub from: String,
    pub to: String,
    pub transaction_type: String,
    pub status: String,
    pub gas_used: String,
    pub effective_gas_price: String,
    pub contract_address: Option<String>,
}
/// Canonical receipt inclusion header, independently observed when historical.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InclusionHeader {
    pub block_number: String,
    pub block_hash: String,
    pub state_root: String,
    pub block_timestamp: String,
    pub base_fee_per_gas: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettlementObservation {
    pub inclusion_header: Option<InclusionHeader>,
    pub base_fee_per_gas: String,
    pub checkpoint: rino_proof_protocol::CheckpointObservation,
    pub transaction: Option<TransactionObservation>,
    pub receipt: Option<ReceiptObservation>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettlementEvidence {
    pub schema_version: u32,
    pub policy_id: String,
    pub status: String,
    pub controller_id: String,
    pub request_id: String,
    pub generation: String,
    pub request_hash: String,
    pub chain_id: String,
    pub vault: String,
    pub beneficiary: String,
    pub expected_nonce: String,
    pub purpose: SettlementPurpose,
    pub block_number: String,
    pub block_hash: String,
    pub state_root: String,
    pub block_timestamp: String,
    pub nonce: String,
    pub balance_wei: String,
    pub code_hash: String,
    pub beneficiary_code_hash: Option<String>,
    pub inclusion_header: Option<InclusionHeader>,
    pub base_fee_per_gas: String,
    pub receipt: Option<ReceiptObservation>,
    pub finality_basis: String,
}

// Serde's internally tagged unit variant ignores extra fields. Deserialize via
// an empty struct variant so Prepare has the same strict shape as Confirm.
impl<'de> Deserialize<'de> for SettlementPurpose {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
        #[allow(clippy::large_enum_variant)]
        enum Strict {
            Prepare {},
            Confirm {
                intent: TransferIntentDto,
                candidate: SignedTransactionDto,
                before_balance_wei: String,
                minimum_block_number: String,
                transaction_index: String,
            },
        }
        Ok(match Strict::deserialize(deserializer)? {
            Strict::Prepare {} => Self::Prepare,
            Strict::Confirm {
                intent,
                candidate,
                before_balance_wei,
                minimum_block_number,
                transaction_index,
            } => Self::Confirm {
                intent,
                candidate,
                before_balance_wei,
                minimum_block_number,
                transaction_index,
            },
        })
    }
}

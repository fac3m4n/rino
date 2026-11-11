use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProofRequest {
    pub schema_version: u32,
    pub policy_id: String,
    pub controller_id: String,
    pub request_id: String,
    pub chain_id: String,
    pub vault: String,
    pub requested_at: String,
    pub expires_at: String,
    pub bundle: ProofBundle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProofBundle {
    pub block_number: String,
    pub block_hash: String,
    pub state_root: String,
    pub block_timestamp: String,
    pub account_proof: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckpointObservation {
    pub provider_id: String,
    pub chain_id: String,
    pub finalized_number: String,
    pub block_number: String,
    pub block_hash: String,
    pub state_root: String,
    pub block_timestamp: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProofEvidence {
    pub schema_version: u32,
    pub policy_id: String,
    pub status: String,
    pub controller_id: String,
    pub request_id: String,
    pub request_hash: String,
    pub chain_id: String,
    pub vault: String,
    pub block_number: String,
    pub block_hash: String,
    pub state_root: String,
    pub block_timestamp: String,
    pub nonce: String,
    pub balance_wei: String,
    pub code_hash: String,
    pub finality_basis: String,
}

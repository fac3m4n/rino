//! Bounded ProofCredit request and evidence validation. RPC agreement is a trust
//! policy, not Ethereum consensus verification or execution attestation.
pub mod quantities;
mod types;
mod verify;
pub use types::*;
pub use verify::*;

pub const SCHEMA_VERSION: u32 = 1;
pub const POLICY_ID: &str = "rpc-finalized-2of2-v1";
pub const CHAIN_ID: u64 = 11_155_111;
pub const PROVIDER_IDS: [&str; 2] = ["publicnode", "automata"];
pub const MAX_INPUT_BYTES: usize = 32768;
pub const MAX_OUTPUT_BYTES: usize = 8192;
pub const MAX_RPC_BYTES: usize = 262144;
pub const MAX_REQUEST_LIFETIME_SECONDS: u64 = 600;
pub const MAX_CHECKPOINT_AGE_SECONDS: u64 = 3600;
pub const EMPTY_CODE_HASH: &str =
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
pub const FINALITY_BASIS: &str = "rpc-finalized-2of2";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    InputTooLarge,
    OutputTooLarge,
    InvalidJson,
    InvalidQuantity,
    InvalidHex,
    InvalidRequest,
    InvalidTime,
    InvalidCheckpoint,
    InvalidProof,
    AccountPolicy,
    EvidenceMismatch,
    ProofLimit,
}
impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ProtocolError {}

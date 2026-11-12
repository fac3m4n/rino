//! Purpose-bound settlement evidence; account MPT and named RPC receipt trust remain distinct.
mod types;
pub use proofcredit_proof_protocol::{
    ProtocolError, CHAIN_ID, EMPTY_CODE_HASH, MAX_CHECKPOINT_AGE_SECONDS, MAX_INPUT_BYTES,
    MAX_OUTPUT_BYTES, MAX_REQUEST_LIFETIME_SECONDS, MAX_RPC_BYTES, PROVIDER_IDS, SCHEMA_VERSION,
};
pub use types::*;
pub const POLICY_ID: &str = "rpc-finalized-2of2-settlement-v1";
pub const FINALITY_BASIS: &str = "rpc-finalized-2of2";
mod verify;
pub use verify::*;

use near_sdk::{
    AccountId,
    json_types::{U64, U128},
    near,
};
#[near(serializers=[json,borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NetworkMode {
    NearTestnet,
    Sandbox { mpc: AccountId },
}
#[near(serializers=[json,borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub borrower: AccountId,
    pub executor: AccountId,
    pub mpc: AccountId,
    pub wasm_url: String,
    pub wasm_sha256: String,
    pub operation_deposit: U128,
    pub network: NetworkMode,
}
#[near(serializers=[json,borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    Uninitialized,
    Deriving,
    Funding,
    ProofPending,
    ProofReady,
    Cancelled,
}
#[near(serializers=[json,borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OperationKind {
    Derivation,
    Proof,
    SettlementPrepare,
    SettlementConfirm,
    FeeTopup,
    Signature,
}
#[near(serializers=[borsh])]
pub struct Pending {
    pub kind: OperationKind,
    pub generation: u64,
    pub expires_at: u64,
    pub input: Vec<u8>,
    pub input_hash: [u8; 32],
}
#[near(serializers=[json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingView {
    pub kind: OperationKind,
    pub request_id: U64,
    pub expires_at: U64,
    pub input_hash: Option<String>,
}

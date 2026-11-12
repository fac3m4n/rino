//! Immutable proof-backed demo CREDIT loan and purpose-restricted Ethereum settlement.
use near_sdk::{
    AccountId, Gas, PanicOnDefault, Promise, env,
    json_types::{U64, U128},
    near,
};
use proofcredit_proof_protocol::{
    CHAIN_ID, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, MAX_REQUEST_LIFETIME_SECONDS, POLICY_ID,
    ProofBundle, ProofEvidence, ProofRequest, SCHEMA_VERSION, parse_request, request_digest,
    validate_evidence,
};
mod credit;
mod executor;
mod init;
mod loan;
mod proof;
mod settlement;
mod signing;
mod views;
pub use loan::{LoanConfig, LoanPhase};
pub use settlement::ConfirmationBundle;
pub use views::*;
mod state;
mod vault;
pub use state::*;

pub const MAX_OPERATION_DEPOSIT: u128 = 50_000_000_000_000_000_000_000;
// Financial callback budgets require fresh Sandbox measurement in Task 5.
const MPC_GAS: Gas = Gas::from_tgas(30);
const DERIVATION_CALLBACK_GAS: Gas = Gas::from_tgas(20);
const EXECUTOR_GAS: Gas = Gas::from_tgas(200);
const PROOF_CALLBACK_GAS: Gas = Gas::from_tgas(30);
const ENTRY_RESERVE: Gas = Gas::from_tgas(30);
const MAX_MPC_RESULT_BYTES: usize = 256;

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Controller {
    config: Config,
    status: Status,
    vault: Option<String>,
    generation: u64,
    pending: Option<Pending>,
    evidence: Option<Vec<u8>>,
    token: Option<near_contract_standards::fungible_token::FungibleToken>,
    loan: Option<loan::Loan>,
}

#[near]
impl Controller {
    /// Invalidate local work. This does not cancel an upstream job or release ETH.
    pub fn cancel(&mut self) {
        self.assert_borrower();
        if self.loan.is_some() {
            self.cancel_loan();
            return;
        }
        assert!(
            !matches!(self.status, Status::Cancelled | Status::ProofReady),
            "terminal controller"
        );
        let generation = self
            .generation
            .checked_add(1)
            .expect("generation exhausted");
        self.generation = generation;
        self.pending = None;
        self.status = Status::Cancelled;
    }

    /// Expiry restores transport availability; issued financial intents remain immutable.
    pub fn expire_pending(&mut self) {
        if self.loan.is_some() {
            self.assert_party();
        } else {
            self.assert_borrower();
        }
        let pending = self.pending.as_ref().expect("no pending operation");
        assert!(
            Self::now() > pending.expires_at,
            "operation has not expired"
        );
        let generation = self
            .generation
            .checked_add(1)
            .expect("generation exhausted");
        let kind = pending.kind.clone();
        self.generation = generation;
        self.clear_pending(kind);
    }

    pub fn get_config(&self) -> Config {
        self.config.clone()
    }
    pub fn get_status(&self) -> Status {
        self.status.clone()
    }
    pub fn get_vault(&self) -> Option<String> {
        self.vault.clone()
    }
    pub fn get_generation(&self) -> U64 {
        U64(self.generation)
    }
    pub fn get_pending(&self) -> Option<PendingView> {
        self.pending.as_ref().map(|p| PendingView {
            kind: p.kind.clone(),
            request_id: U64(p.generation),
            expires_at: U64(p.expires_at),
            input_hash: (p.kind != OperationKind::Derivation).then(|| vault::hex(&p.input_hash)),
        })
    }
    pub fn get_evidence(&self) -> Option<ProofEvidence> {
        self.evidence
            .as_ref()
            .map(|raw| serde_json::from_slice(raw).expect("validated evidence"))
    }
}

impl Controller {
    fn now() -> u64 {
        env::block_timestamp() / 1_000_000_000
    }
    fn assert_borrower(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            self.config.borrower,
            "borrower only"
        );
    }
    // Explicit guard also protects direct Rust calls that bypass macro wrappers.
    fn assert_self() {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "private callback"
        );
    }
    fn assert_gas(external: Gas, callback: Gas) {
        assert!(
            env::prepaid_gas().as_gas()
                >= external.as_gas() + callback.as_gas() + ENTRY_RESERVE.as_gas(),
            "insufficient prepaid gas"
        );
    }
    fn next_operation(&self) -> (u64, u64) {
        (
            self.generation
                .checked_add(1)
                .expect("generation exhausted"),
            Self::now()
                .checked_add(MAX_REQUEST_LIFETIME_SECONDS)
                .expect("expiry overflow"),
        )
    }
    fn matches_pending(&self, id: u64, kind: OperationKind) -> bool {
        let expected_status = match kind {
            OperationKind::Derivation => Status::Deriving,
            OperationKind::Proof => Status::ProofPending,
            _ => self.status.clone(),
        };
        self.status == expected_status
            && self
                .pending
                .as_ref()
                .is_some_and(|p| p.generation == id && p.kind == kind)
    }
    fn result(&self, max_len: usize) -> Option<Vec<u8>> {
        if Self::now() > self.pending.as_ref()?.expires_at || env::promise_results_count() != 1 {
            return None;
        }
        env::promise_result_checked(0, max_len).ok()
    }
    fn clear_pending(&mut self, kind: OperationKind) {
        if !matches!(kind, OperationKind::Derivation | OperationKind::Proof) {
            self.clear_financial_pending(kind);
            self.pending = None;
            return;
        }
        self.pending = None;
        self.status = match kind {
            OperationKind::Derivation => Status::Uninitialized,
            OperationKind::Proof => Status::Funding,
            _ => unreachable!("handled financial operation"),
        };
    }
}
#[cfg(test)]
mod tests;

#[cfg(test)]
mod financial_tests;

#[cfg(test)]
mod settlement_tests;

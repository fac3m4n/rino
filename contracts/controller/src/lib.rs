//! A proof-only controller. Accepted evidence creates no credit or spending authority.
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
mod executor;
mod state;
mod vault;
pub use state::*;

pub const MAX_OPERATION_DEPOSIT: u128 = 50_000_000_000_000_000_000_000;
// Explicit initial budgets, pending real Sandbox measurement (Task 4).
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
}

#[near]
impl Controller {
    /// Immutable deployment policy. Fund the account separately for operational work.
    #[init]
    pub fn new(
        borrower: AccountId,
        executor: AccountId,
        wasm_url: String,
        wasm_sha256: String,
        operation_deposit: U128,
        network: NetworkMode,
    ) -> Self {
        assert!(
            operation_deposit.0 <= MAX_OPERATION_DEPOSIT,
            "operation deposit exceeds cap"
        );
        assert!(
            wasm_sha256.len() == 64
                && wasm_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid WASM SHA-256"
        );
        executor::validate_url(&wasm_url);
        let mpc = match &network {
            NetworkMode::NearTestnet => {
                assert_eq!(
                    executor.as_str(),
                    "outlayer.testnet",
                    "wrong testnet executor"
                );
                "v1.signer-prod.testnet".parse().expect("fixed account")
            }
            NetworkMode::Sandbox { mpc } => mpc.clone(),
        };
        Self {
            config: Config {
                borrower,
                executor,
                mpc,
                wasm_url,
                wasm_sha256,
                operation_deposit,
                network,
            },
            status: Status::Uninitialized,
            vault: None,
            generation: 0,
            pending: None,
            evidence: None,
        }
    }

    /// Derive only the controller's fixed-path vault. Never accepts an address.
    pub fn initialize_vault(&mut self) -> Promise {
        self.assert_borrower();
        assert_eq!(
            self.status,
            Status::Uninitialized,
            "vault cannot be initialized in this state"
        );
        assert!(
            self.pending.is_none() && self.vault.is_none(),
            "vault or operation exists"
        );
        Self::assert_gas(MPC_GAS, DERIVATION_CALLBACK_GAS);
        let (generation, expires_at) = self.next_operation();
        self.generation = generation;
        self.pending = Some(Pending {
            kind: OperationKind::Derivation,
            generation,
            expires_at,
            input: vec![],
            input_hash: [0; 32],
        });
        self.status = Status::Deriving;
        let args = serde_json::to_vec(&serde_json::json!({
            "path": vault::DERIVATION_PATH,
            "predecessor": env::current_account_id(),
            "domain_id": 0
        }))
        .expect("fixed arguments");
        Promise::new(self.config.mpc.clone())
            .function_call(
                "derived_public_key",
                args,
                near_sdk::NearToken::from_yoctonear(0),
                MPC_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(DERIVATION_CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_vault_derived(U64(generation)),
            )
    }

    /// Reserve a proof request and pin every authority-bearing field locally.
    pub fn request_proof(&mut self, bundle: ProofBundle) -> Promise {
        self.assert_borrower();
        assert_eq!(
            self.status,
            Status::Funding,
            "proof cannot be requested in this state"
        );
        assert!(self.pending.is_none(), "operation already pending");
        Self::assert_gas(EXECUTOR_GAS, PROOF_CALLBACK_GAS);
        let (generation, expires_at) = self.next_operation();
        let request = ProofRequest {
            schema_version: SCHEMA_VERSION,
            policy_id: POLICY_ID.into(),
            controller_id: env::current_account_id().to_string(),
            request_id: generation.to_string(),
            chain_id: CHAIN_ID.to_string(),
            vault: self.vault.clone().expect("derived vault missing"),
            requested_at: Self::now().to_string(),
            expires_at: expires_at.to_string(),
            bundle,
        };
        let input = serde_json::to_vec(&request).expect("request serializable");
        assert!(
            input.len() <= MAX_INPUT_BYTES,
            "serialized input exceeds limit"
        );
        assert!(
            parse_request(&input, Self::now()).is_ok(),
            "invalid proof request"
        );
        let args = executor::execution_args(&self.config, &input);
        self.generation = generation;
        self.pending = Some(Pending {
            kind: OperationKind::Proof,
            generation,
            expires_at,
            input_hash: request_digest(&input),
            input,
        });
        self.status = Status::ProofPending;
        Promise::new(self.config.executor.clone())
            .function_call(
                "request_execution",
                args,
                near_sdk::NearToken::from_yoctonear(self.config.operation_deposit.0),
                EXECUTOR_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(PROOF_CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_proof_result(U64(generation)),
            )
    }

    /// Invalidate local work. This does not cancel an upstream job or release ETH.
    pub fn cancel(&mut self) {
        self.assert_borrower();
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

    /// Safe only for this proof-only milestone, which never emits spending signatures.
    pub fn expire_pending(&mut self) {
        self.assert_borrower();
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

    /// Read raw, bounded bytes from the single chained MPC receipt.
    #[private]
    pub fn on_vault_derived(&mut self, request_id: U64) -> bool {
        Self::assert_self();
        if !self.matches_pending(request_id.0, OperationKind::Derivation) {
            return false;
        }
        let address = self
            .result(MAX_MPC_RESULT_BYTES)
            .and_then(|raw| vault::derive_address(&raw));
        self.clear_pending(OperationKind::Derivation);
        if let Some(address) = address {
            self.vault = Some(address);
            self.status = Status::Funding;
            true
        } else {
            false
        }
    }

    /// Accept only configured-executor promise bytes matching this pending request.
    #[private]
    pub fn on_proof_result(&mut self, request_id: U64) -> bool {
        Self::assert_self();
        if !self.matches_pending(request_id.0, OperationKind::Proof) {
            return false;
        }
        let accepted = self.result(MAX_OUTPUT_BYTES).and_then(|raw| {
            let p = self.pending.as_ref()?;
            let expected: ProofRequest = serde_json::from_slice(&p.input).ok()?;
            validate_evidence(&raw, &expected, &p.input_hash, Self::now()).ok()?;
            Some(raw)
        });
        self.clear_pending(OperationKind::Proof);
        if let Some(raw) = accepted {
            self.evidence = Some(raw);
            self.status = Status::ProofReady;
            true
        } else {
            false
        }
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
            input_hash: (p.kind == OperationKind::Proof).then(|| vault::hex(&p.input_hash)),
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
        self.pending = None;
        self.status = match kind {
            OperationKind::Derivation => Status::Uninitialized,
            OperationKind::Proof => Status::Funding,
        };
    }
}
#[cfg(test)]
mod tests;

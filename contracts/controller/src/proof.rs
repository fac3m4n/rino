//! Original collateral eligibility and fixed vault derivation remain separate from settlement.
use crate::*;
#[near]
impl Controller {
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
        let refreshing = self.status == Status::ProofReady
            && self
                .loan
                .as_ref()
                .is_some_and(|l| l.phase == LoanPhase::Offered);
        assert!(
            self.status == Status::Funding || refreshing,
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
}

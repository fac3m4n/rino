//! A timeout only releases transport work. The exact economic intent stays locked.
use crate::settlement::SettlementStage;
use crate::*;
use proofcredit_loan_core::{MAX_MPC_SIGNATURE_BYTES, verify_mpc_signature};
use proofcredit_settlement_protocol::fixed_hex;
const SIGN_CALLBACK_GAS: Gas = Gas::from_tgas(100);
#[near]
impl Controller {
    pub fn request_signature(&mut self) -> Promise {
        self.sign_stored_intent()
    }
    pub fn retry_signature(&mut self) -> Promise {
        self.sign_stored_intent()
    }
    pub fn adopt_signature(&mut self, signature_json: String) -> bool {
        self.assert_party();
        assert!(
            self.pending
                .as_ref()
                .is_none_or(|p| p.kind == OperationKind::Signature),
            "operation pending"
        );
        if !self.record_signature(signature_json.as_bytes()) {
            return false;
        }
        if self.pending.is_some() {
            self.generation = self
                .generation
                .checked_add(1)
                .expect("generation exhausted");
            self.pending = None;
        }
        self.loan.as_mut().unwrap().settlement.stage = SettlementStage::Signed;
        true
    }
    #[private]
    pub fn on_signature_result(&mut self, request_id: U64) -> bool {
        Self::assert_self();
        if !self.matches_pending(request_id.0, OperationKind::Signature) {
            return false;
        }
        let result = self.result(MAX_MPC_SIGNATURE_BYTES);
        self.clear_pending(OperationKind::Signature);
        if let Some(raw) = result {
            self.record_signature(&raw)
        } else {
            false
        }
    }
}
impl Controller {
    fn sign_stored_intent(&mut self) -> Promise {
        self.assert_party();
        assert!(self.pending.is_none(), "operation pending");
        let l = self.loan.as_ref().expect("loan disabled");
        assert!(
            matches!(
                l.phase,
                LoanPhase::Repaid | LoanPhase::DefaultLocked | LoanPhase::CancelLocked
            ),
            "settlement branch not locked"
        );
        let s = &l.settlement;
        let f = s.intent.as_ref().expect("prepare intent first");
        assert!(s.candidates.len() < 4, "candidate limit reached");
        Self::assert_gas(MPC_GAS, SIGN_CALLBACK_GAS);
        let args=serde_json::to_vec(&serde_json::json!({"request":{"path":vault::DERIVATION_PATH,"payload_v2":{"Ecdsa":&vault::hex(&f.digest)[2..]},"domain_id":0}})).expect("fixed MPC request");
        let digest = f.digest;
        let (generation, expires_at) = self.next_operation();
        self.generation = generation;
        self.pending = Some(Pending {
            kind: OperationKind::Signature,
            generation,
            expires_at,
            input: vec![],
            input_hash: digest,
        });
        self.loan.as_mut().unwrap().settlement.stage = SettlementStage::Signing;
        Promise::new(self.config.mpc.clone())
            .function_call(
                "sign",
                args,
                near_sdk::NearToken::from_yoctonear(1),
                MPC_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(SIGN_CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_signature_result(U64(generation)),
            )
    }
    fn record_signature(&mut self, raw: &[u8]) -> bool {
        let l = self.loan.as_ref().expect("loan disabled");
        let s = &l.settlement;
        let Some(f) = s.intent.as_ref() else {
            return false;
        };
        let Ok(vault) = fixed_hex::<20>(self.vault.as_ref().expect("derived vault")) else {
            return false;
        };
        let Ok(candidate) = verify_mpc_signature(&f.transfer, vault, raw) else {
            return false;
        };
        if s.candidates.iter().any(|c| c.hash == candidate.hash) {
            return true;
        }
        if s.candidates.len() >= 4 {
            return false;
        }
        let s = &mut self.loan.as_mut().unwrap().settlement;
        s.candidates.push(candidate);
        s.stage = SettlementStage::Signed;
        true
    }
}

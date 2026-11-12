//! A timeout only releases transport work. The exact economic intent stays locked.
use crate::settlement::SettlementStage;
use crate::*;
use proofcredit_loan_core::{MAX_MPC_SIGNATURE_BYTES, verify_mpc_signature};
use proofcredit_settlement_protocol::fixed_hex;
const SIGN_CALLBACK_GAS: Gas = Gas::from_tgas(100);

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ServiceSignature {
    scheme: String,
    big_r: ServicePoint,
    s: ServiceScalar,
    recovery_id: u8,
}
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ServicePoint {
    affine_point: String,
}
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ServiceScalar {
    scalar: String,
}

/// The service may retain its original R parity after low-s normalization.
/// Adapt only that transport representation; the canonical verifier still
/// validates scalars, low-s, curve membership, vault recovery and exact intent.
fn canonical_service_signature(raw: &[u8]) -> Option<Vec<u8>> {
    if raw.len() > MAX_MPC_SIGNATURE_BYTES {
        return None;
    }
    // Typed decoding rejects unknown and duplicate fields at every level.
    let mut response: ServiceSignature = serde_json::from_slice(raw).ok()?;
    if response.scheme != "Secp256k1" || response.recovery_id > 1 {
        return None;
    }
    let encoded = &response.big_r.affine_point;
    if encoded.len() != 66 || !encoded.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut point = [0; 33];
    for (byte, digits) in point.iter_mut().zip(encoded.as_bytes().as_chunks::<2>().0) {
        *byte = u8::from_str_radix(std::str::from_utf8(digits).ok()?, 16).ok()?;
    }
    if !matches!(point[0], 2 | 3) {
        return None;
    }
    k256::PublicKey::from_sec1_bytes(&point).ok()?;
    response.big_r.affine_point.replace_range(
        ..2,
        if response.recovery_id == 0 {
            "02"
        } else {
            "03"
        },
    );
    serde_json::to_vec(&response).ok()
}
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
        if let Some(raw) = result.and_then(|raw| canonical_service_signature(&raw)) {
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

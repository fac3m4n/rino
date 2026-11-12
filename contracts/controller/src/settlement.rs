use crate::*;
use proofcredit_loan_core::{SettlementBranch, SignedTransaction, TransferIntent};
#[near(serializers = [json, borsh])]
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettlementStage {
    #[default]
    Idle,
    Preparing,
    ReadyToSign,
    Signing,
    Signed,
    Confirming,
    NeedsTopup,
    Complete,
}
#[near(serializers = [borsh])]
#[derive(Default)]
pub struct Settlement {
    pub stage: SettlementStage,
    pub branch: Option<SettlementBranch>,
    pub nonce: u64,
    pub balance: u128,
    pub accounted_balance: u128,
    pub baseline_set: bool,
    pub fee_budget: u128,
    pub fees_paid: u128,
    pub lender_paid: u128,
    pub borrower_surplus: u128,
    pub shortfall: u128,
    pub checkpoint: Option<u64>,
    pub intent: Option<FrozenIntent>,
    pub candidates: Vec<SignedTransaction>,
    pub action: Option<SettlementAction>,
    pub last_confirmation: Option<ConfirmedLeg>,
}
#[near(serializers = [borsh])]
pub struct FrozenIntent {
    pub transfer: TransferIntent,
    pub preimage: Vec<u8>,
    pub digest: [u8; 32],
    pub before_balance: u128,
    pub minimum_block: u64,
}
#[near(serializers = [borsh])]
#[derive(Clone)]
pub enum SettlementAction {
    Prepare {
        gas_price: u128,
        previous: SettlementStage,
    },
    Topup {
        amount: u128,
        previous: SettlementStage,
    },
    Confirm,
}
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct ConfirmedLeg {
    pub transaction_hash: String,
    pub nonce: U64,
    pub success: bool,
    pub paid_value: U128,
    pub fee: U128,
    pub block_number: U64,
}
use proofcredit_settlement_protocol::SettlementBundle;
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ConfirmationBundle {
    pub checkpoint: SettlementBundle,
    pub transaction_index: String,
}
use proofcredit_loan_core::{
    Plan, SettlementState, WEI_PER_ETH, debt_units, default_cap_wei, plan_transfer, signing_digest,
    signing_preimage,
};
use proofcredit_settlement_protocol::{
    self as protocol, SettlementEvidence, SettlementPurpose, SettlementRequest,
    SignedTransactionDto, TransferIntentDto, decimal_u64, decimal_u128, fixed_hex,
};
// Initial conservative allocation. Actual Sandbox receipt cost must be measured before public use.
pub(crate) const SETTLEMENT_EXECUTOR_GAS: Gas = Gas::from_tgas(140);
pub(crate) const SETTLEMENT_CALLBACK_GAS: Gas = Gas::from_tgas(90);
// Max-wire direct confirmation burned 52.0685 Tgas while reserving promises in
// real Sandbox. Reserve 70 Tgas for settlement entry; other routes keep 30 Tgas.
pub(crate) const SETTLEMENT_ENTRY_RESERVE: Gas = Gas::from_tgas(70);
#[near]
impl Controller {
    pub fn prepare_settlement(&mut self, bundle: SettlementBundle, gas_price: U128) -> Promise {
        self.assert_party();
        self.assert_settlement_unissued();
        let l = self.loan.as_ref().unwrap();
        assert!(
            gas_price.0 > 0 && gas_price.0 <= l.terms.fee_cap_wei_per_gas,
            "invalid gas price"
        );
        let action = SettlementAction::Prepare {
            gas_price: gas_price.0,
            previous: l.settlement.stage,
        };
        self.start_settlement(
            bundle,
            SettlementPurpose::Prepare,
            action,
            OperationKind::SettlementPrepare,
        )
    }
    pub fn confirm_settlement(
        &mut self,
        candidate_hash: String,
        bundle: ConfirmationBundle,
        signature_json: Option<String>,
    ) -> Promise {
        self.assert_party();
        assert!(self.pending.is_none(), "operation pending");
        let s = &self.loan.as_ref().expect("loan disabled").settlement;
        let f = s.intent.as_ref().expect("no issued intent");
        let hash = fixed_hex::<32>(&candidate_hash).expect("invalid candidate hash");
        // A lost/superseded MPC reply can yield a valid included hash after all
        // four relay slots are occupied. Bind it only into this pending request;
        // the immutable intent and bounded relay alias list never change.
        let candidate = if let Some(packet) = signature_json {
            let vault = fixed_hex::<20>(self.vault.as_ref().expect("derived vault"))
                .expect("validated vault");
            let candidate =
                proofcredit_loan_core::verify_mpc_signature(&f.transfer, vault, packet.as_bytes())
                    .expect("invalid confirmation signature");
            assert_eq!(candidate.hash, hash, "confirmation signature hash mismatch");
            candidate
        } else {
            s.candidates
                .iter()
                .find(|c| c.hash == hash)
                .expect("unverified candidate")
                .clone()
        };
        let purpose = SettlementPurpose::Confirm {
            intent: TransferIntentDto::from_native(&f.transfer),
            candidate: SignedTransactionDto::from_native(&candidate),
            before_balance_wei: f.before_balance.to_string(),
            minimum_block_number: f.minimum_block.to_string(),
            transaction_index: bundle.transaction_index,
        };
        self.start_settlement(
            bundle.checkpoint,
            purpose,
            SettlementAction::Confirm,
            OperationKind::SettlementConfirm,
        )
    }
    pub fn add_fee_budget(&mut self, bundle: SettlementBundle, amount: U128) -> Promise {
        self.assert_party();
        self.assert_settlement_unissued();
        assert!(amount.0 > 0, "positive topup required");
        let s = &self.loan.as_ref().unwrap().settlement;
        assert!(s.baseline_set, "prepare state first");
        let action = SettlementAction::Topup {
            amount: amount.0,
            previous: s.stage,
        };
        self.start_settlement(
            bundle,
            SettlementPurpose::Prepare,
            action,
            OperationKind::FeeTopup,
        )
    }
    #[private]
    pub fn on_settlement_result(&mut self, request_id: U64) -> bool {
        Self::assert_self();
        let Some(p) = self.pending.as_ref() else {
            return false;
        };
        let kind = p.kind.clone();
        if !matches!(
            kind,
            OperationKind::SettlementPrepare
                | OperationKind::SettlementConfirm
                | OperationKind::FeeTopup
        ) || !self.matches_pending(request_id.0, kind.clone())
        {
            return false;
        }
        let evidence = self.result(protocol::MAX_OUTPUT_BYTES).and_then(|raw| {
            let p = self.pending.as_ref()?;
            let expected: SettlementRequest = serde_json::from_slice(&p.input).ok()?;
            protocol::validate_settlement_evidence(&raw, &expected, &p.input_hash, Self::now()).ok()
        });
        let action = self.loan.as_ref().and_then(|l| l.settlement.action.clone());
        self.clear_pending(kind);
        match (evidence, action) {
            (Some(e), Some(SettlementAction::Prepare { gas_price, .. })) => {
                self.accept_preparation(e, gas_price)
            }
            (Some(e), Some(SettlementAction::Topup { amount, .. })) => self.accept_topup(e, amount),
            (Some(e), Some(SettlementAction::Confirm)) => self.accept_confirmation(e),
            _ => false,
        }
    }
}
impl Controller {
    pub(crate) fn beneficiary(&self) -> String {
        let l = self.loan.as_ref().expect("loan disabled");
        let s = &l.settlement;
        if s.branch == Some(SettlementBranch::Default)
            && s.lender_paid < default_cap_wei(&l.terms).expect("fixed terms")
        {
            l.config.lender_recipient.clone()
        } else {
            l.config.borrower_recipient.clone()
        }
    }
    fn assert_settlement_unissued(&self) {
        let l = self.loan.as_ref().expect("loan disabled");
        assert!(
            matches!(
                l.phase,
                LoanPhase::Repaid | LoanPhase::DefaultLocked | LoanPhase::CancelLocked
            ),
            "settlement branch not locked"
        );
        assert!(self.pending.is_none(), "operation pending");
        assert!(l.settlement.intent.is_none(), "intent locked");
    }
    fn start_settlement(
        &mut self,
        bundle: SettlementBundle,
        purpose: SettlementPurpose,
        action: SettlementAction,
        kind: OperationKind,
    ) -> Promise {
        assert!(
            env::prepaid_gas().as_gas()
                >= SETTLEMENT_EXECUTOR_GAS.as_gas()
                    + SETTLEMENT_CALLBACK_GAS.as_gas()
                    + SETTLEMENT_ENTRY_RESERVE.as_gas(),
            "insufficient prepaid settlement gas"
        );
        let (generation, expires_at) = self.next_operation();
        let beneficiary = match &purpose {
            SettlementPurpose::Confirm { intent, .. } => intent.to.clone(),
            SettlementPurpose::Prepare => self.beneficiary(),
        };
        let r = SettlementRequest {
            schema_version: protocol::SCHEMA_VERSION,
            policy_id: protocol::POLICY_ID.into(),
            controller_id: env::current_account_id().to_string(),
            request_id: generation.to_string(),
            generation: generation.to_string(),
            chain_id: protocol::CHAIN_ID.to_string(),
            vault: self.vault.clone().expect("derived vault required"),
            beneficiary,
            expected_nonce: self.loan.as_ref().unwrap().settlement.nonce.to_string(),
            requested_at: Self::now().to_string(),
            expires_at: expires_at.to_string(),
            purpose,
            bundle,
        };
        let input = serde_json::to_vec(&r).expect("request serializable");
        assert!(
            input.len() <= protocol::MAX_INPUT_BYTES,
            "serialized input exceeds limit"
        );
        protocol::parse_settlement_request(&input, Self::now())
            .expect("invalid settlement request");
        let l = self.loan.as_ref().unwrap();
        let mut config = self.config.clone();
        config.wasm_url = l.config.settlement_wasm_url.clone();
        config.wasm_sha256 = l.config.settlement_wasm_sha256.clone();
        let args = executor::execution_args(&config, &input);
        self.generation = generation;
        self.pending = Some(Pending {
            kind: kind.clone(),
            generation,
            expires_at,
            input_hash: protocol::settlement_request_digest(&input),
            input,
        });
        let s = &mut self.loan.as_mut().unwrap().settlement;
        s.action = Some(action);
        s.stage = if kind == OperationKind::SettlementConfirm {
            SettlementStage::Confirming
        } else {
            SettlementStage::Preparing
        };
        Promise::new(self.config.executor.clone())
            .function_call(
                "request_execution",
                args,
                near_sdk::NearToken::from_yoctonear(self.config.operation_deposit.0),
                SETTLEMENT_EXECUTOR_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(SETTLEMENT_CALLBACK_GAS)
                    .with_unused_gas_weight(0)
                    .on_settlement_result(U64(generation)),
            )
    }
    fn accept_preparation(&mut self, e: SettlementEvidence, gas_price: u128) -> bool {
        let Ok(balance) = decimal_u128(&e.balance_wei) else {
            return false;
        };
        let Ok(floor) = decimal_u128(&e.base_fee_per_gas) else {
            return false;
        };
        let Ok(block) = decimal_u64(&e.block_number) else {
            return false;
        };
        if gas_price < floor {
            return false;
        }
        let l = self.loan.as_ref().unwrap();
        let s = &l.settlement;
        let Ok(plan) = plan_transfer(
            &l.terms,
            SettlementState {
                branch: s.branch.expect("locked branch"),
                balance_wei: balance,
                nonce: s.nonce,
                vault: fixed_hex::<20>(self.vault.as_ref().unwrap()).expect("validated vault"),
                borrower: fixed_hex::<20>(&l.config.borrower_recipient)
                    .expect("validated recipient"),
                lender: fixed_hex::<20>(&l.config.lender_recipient).expect("validated recipient"),
                lender_paid_wei: s.lender_paid,
                remaining_fee_budget_wei: s.fee_budget,
                gas_price,
            },
        ) else {
            return false;
        };
        let frozen = if let Plan::Transfer(transfer) = plan {
            let Ok(preimage) = signing_preimage(&transfer) else {
                return false;
            };
            let Ok(digest) = signing_digest(&transfer) else {
                return false;
            };
            Some(FrozenIntent {
                transfer,
                preimage,
                digest,
                before_balance: balance,
                minimum_block: block,
            })
        } else {
            None
        };
        let l = self.loan.as_mut().unwrap();
        let s = &mut l.settlement;
        s.balance = balance;
        s.checkpoint = Some(block);
        if !s.baseline_set {
            s.accounted_balance = balance;
            s.baseline_set = true;
        }
        match plan {
            Plan::Transfer(_) => {
                s.intent = frozen;
                s.candidates.clear();
                s.stage = SettlementStage::ReadyToSign;
            }
            Plan::NeedsTopup { .. } => s.stage = SettlementStage::NeedsTopup,
            Plan::Complete {
                shortfall_credit_units,
            } => {
                s.shortfall = shortfall_credit_units;
                s.stage = SettlementStage::Complete;
                l.phase = LoanPhase::Closed;
                l.debt = 0;
            }
        }
        true
    }
    fn accept_topup(&mut self, e: SettlementEvidence, amount: u128) -> bool {
        let Ok(balance) = decimal_u128(&e.balance_wei) else {
            return false;
        };
        let Ok(block) = decimal_u64(&e.block_number) else {
            return false;
        };
        let s = &mut self.loan.as_mut().unwrap().settlement;
        let Some(delta) = balance.checked_sub(s.accounted_balance) else {
            return false;
        };
        if amount > delta {
            return false;
        }
        let Some(budget) = s.fee_budget.checked_add(amount) else {
            return false;
        };
        let Some(baseline) = s.accounted_balance.checked_add(amount) else {
            return false;
        };
        s.fee_budget = budget;
        s.accounted_balance = baseline;
        s.balance = balance;
        s.checkpoint = Some(block);
        true
    }
    fn accept_confirmation(&mut self, e: SettlementEvidence) -> bool {
        let Ok(balance) = decimal_u128(&e.balance_wei) else {
            return false;
        };
        let Ok(block) = decimal_u64(&e.block_number) else {
            return false;
        };
        let Some(receipt) = e.receipt else {
            return false;
        };
        let Ok(inclusion_block) = decimal_u64(&receipt.block_number) else {
            return false;
        };
        let s = &self.loan.as_ref().unwrap().settlement;
        let Some(f) = s.intent.as_ref() else {
            return false;
        };
        let Some(fee) = f
            .transfer
            .gas_price
            .checked_mul(u128::from(f.transfer.gas_limit))
        else {
            return false;
        };
        let success = receipt.status == "1";
        let paid = if success { f.transfer.value } else { 0 };
        let Some(outflow) = fee.checked_add(paid) else {
            return false;
        };
        let Some(budget) = s.fee_budget.checked_sub(fee) else {
            return false;
        };
        let Some(fees) = s.fees_paid.checked_add(fee) else {
            return false;
        };
        let Some(nonce) = s.nonce.checked_add(1) else {
            return false;
        };
        let l = self.loan.as_ref().unwrap();
        let lender_leg = s.branch == Some(SettlementBranch::Default)
            && f.transfer.to
                == fixed_hex::<20>(&l.config.lender_recipient).expect("validated recipient");
        let Some(lender_paid) = s.lender_paid.checked_add(if lender_leg { paid } else { 0 }) else {
            return false;
        };
        let Some(surplus) = s
            .borrower_surplus
            .checked_add(if lender_leg { 0 } else { paid })
        else {
            return false;
        };
        if lender_paid > default_cap_wei(&l.terms).expect("fixed terms") {
            return false;
        }
        let recovery = lender_paid
            .checked_mul(l.terms.reference_units_per_eth)
            .map(|v| v / WEI_PER_ETH);
        let Some(recovery) = recovery else {
            return false;
        };
        let shortfall = if s.branch == Some(SettlementBranch::Default) {
            debt_units(&l.terms)
                .expect("fixed debt")
                .saturating_sub(recovery)
        } else {
            0
        };
        let leg = ConfirmedLeg {
            transaction_hash: receipt.transaction_hash,
            nonce: U64(s.nonce),
            success,
            paid_value: U128(paid),
            fee: U128(fee),
            block_number: U64(inclusion_block),
        };
        let l = self.loan.as_mut().unwrap();
        let s = &mut l.settlement;
        s.nonce = nonce;
        s.balance = balance;
        s.accounted_balance = s.accounted_balance.saturating_sub(outflow);
        s.fee_budget = budget;
        s.fees_paid = fees;
        s.lender_paid = lender_paid;
        s.borrower_surplus = surplus;
        s.checkpoint = Some(block);
        s.last_confirmation = Some(leg);
        s.intent = None;
        s.candidates.clear();
        s.stage = SettlementStage::Idle;
        s.shortfall = shortfall;
        if balance == 0 {
            s.stage = SettlementStage::Complete;
            l.phase = LoanPhase::Closed;
            l.debt = 0;
        }
        true
    }
    pub(crate) fn clear_financial_pending(&mut self, kind: OperationKind) {
        let s = &mut self.loan.as_mut().expect("financial pending").settlement;
        s.stage = match s.action.take() {
            Some(
                SettlementAction::Prepare { previous, .. }
                | SettlementAction::Topup { previous, .. },
            ) => previous,
            Some(SettlementAction::Confirm) => SettlementStage::Signed,
            None => {
                if s.candidates.is_empty() {
                    SettlementStage::ReadyToSign
                } else {
                    SettlementStage::Signed
                }
            }
        };
        if kind == OperationKind::Signature {
            s.stage = if s.candidates.is_empty() {
                SettlementStage::ReadyToSign
            } else {
                SettlementStage::Signed
            };
        }
    }
}

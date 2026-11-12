use crate::settlement::{ConfirmedLeg, SettlementStage};
use crate::*;
use proofcredit_settlement_protocol::{SignedTransactionDto, TransferIntentDto};
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct TermsView {
    pub version: String,
    pub principal_units: U128,
    pub fee_units: U128,
    pub debt_units: U128,
    pub reference_units_per_eth: U128,
    pub max_ltv_bps: U64,
    pub term_seconds: U64,
    pub fee_cap_wei_per_gas: U128,
    pub gas_limit: U64,
    pub initial_fee_budget_wei: U128,
}
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MarketView {
    pub phase: LoanPhase,
    pub borrower: AccountId,
    pub lender: AccountId,
    pub vault: Option<String>,
    pub borrower_recipient: String,
    pub lender_recipient: String,
    pub settlement_wasm_url: String,
    pub settlement_wasm_sha256: String,
    pub terms: TermsView,
    pub available_liquidity_units: U128,
    pub lender_claim_units: U128,
    pub debt_units: U128,
    pub borrowed_at: Option<U64>,
    pub maturity: Option<U64>,
    pub borrower_balance_units: U128,
    pub lender_balance_units: U128,
    pub escrow_balance_units: U128,
    pub proof_timestamp: Option<U64>,
    pub proof_fresh: bool,
    pub pending_reason: String,
}
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct IntentView {
    pub transfer: TransferIntentDto,
    pub signing_preimage: String,
    pub signing_digest: String,
    pub before_balance_wei: U128,
    pub minimum_block_number: U64,
}
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SettlementView {
    pub stage: SettlementStage,
    pub branch: Option<String>,
    pub expected_nonce: U64,
    pub balance_wei: U128,
    pub accounted_balance_wei: U128,
    pub unallocated_incoming_wei: U128,
    pub remaining_fee_budget_wei: U128,
    pub fees_paid_wei: U128,
    pub lender_cap_wei: U128,
    pub lender_paid_wei: U128,
    pub remaining_lender_cap_wei: U128,
    pub recovered_credit_units: U128,
    pub shortfall_credit_units: U128,
    pub borrower_surplus_wei: U128,
    pub checkpoint_block_number: Option<U64>,
    pub current_intent: Option<IntentView>,
    pub candidate_count: u8,
    pub last_confirmation: Option<ConfirmedLeg>,
    pub pending: Option<PendingView>,
    pub pending_reason: String,
    pub retired: bool,
}
use near_contract_standards::fungible_token::FungibleTokenCore;
use proofcredit_loan_core::{
    GAS_LIMIT, SettlementBranch, WEI_PER_ETH, debt_units, default_cap_wei, initial_fee_budget,
};
#[near]
impl Controller {
    pub fn get_market(&self) -> Option<MarketView> {
        let l = self.loan.as_ref()?;
        let t = &l.terms;
        let timestamp = self
            .get_evidence()
            .and_then(|e| e.block_timestamp.parse::<u64>().ok());
        Some(MarketView {
            phase: l.phase,
            borrower: self.config.borrower.clone(),
            lender: l.config.lender.clone(),
            vault: self.vault.clone(),
            borrower_recipient: l.config.borrower_recipient.clone(),
            lender_recipient: l.config.lender_recipient.clone(),
            settlement_wasm_url: l.config.settlement_wasm_url.clone(),
            settlement_wasm_sha256: l.config.settlement_wasm_sha256.clone(),
            terms: TermsView {
                version: "proofcredit-demo-v1".into(),
                principal_units: U128(t.principal_units),
                fee_units: U128(t.fee_units),
                debt_units: U128(debt_units(t).expect("fixed terms")),
                reference_units_per_eth: U128(t.reference_units_per_eth),
                max_ltv_bps: U64(u64::from(t.max_ltv_bps)),
                term_seconds: U64(t.term_seconds),
                fee_cap_wei_per_gas: U128(t.fee_cap_wei_per_gas),
                gas_limit: U64(GAS_LIMIT),
                initial_fee_budget_wei: U128(initial_fee_budget(t).expect("fixed terms")),
            },
            available_liquidity_units: U128(l.available),
            lender_claim_units: U128(l.claim),
            debt_units: U128(l.debt),
            borrowed_at: l.borrowed_at.map(U64),
            maturity: l.maturity.map(U64),
            borrower_balance_units: self.ft_balance_of(self.config.borrower.clone()),
            lender_balance_units: self.ft_balance_of(l.config.lender.clone()),
            escrow_balance_units: self.ft_balance_of(env::current_account_id()),
            proof_timestamp: timestamp.map(U64),
            proof_fresh: self.status == Status::ProofReady
                && timestamp.is_some_and(|t| t <= Self::now() && Self::now() - t <= 3600),
            pending_reason: self.financial_reason(),
        })
    }
    pub fn get_settlement(&self) -> Option<SettlementView> {
        let l = self.loan.as_ref()?;
        let s = &l.settlement;
        let cap = default_cap_wei(&l.terms).expect("fixed terms");
        Some(SettlementView {
            stage: s.stage,
            branch: s.branch.map(|b| {
                match b {
                    SettlementBranch::Repay => "repay",
                    SettlementBranch::Cancel => "cancel",
                    SettlementBranch::Default => "default",
                }
                .into()
            }),
            expected_nonce: U64(s.nonce),
            balance_wei: U128(s.balance),
            accounted_balance_wei: U128(s.accounted_balance),
            unallocated_incoming_wei: U128(if s.baseline_set {
                s.balance.saturating_sub(s.accounted_balance)
            } else {
                0
            }),
            remaining_fee_budget_wei: U128(s.fee_budget),
            fees_paid_wei: U128(s.fees_paid),
            lender_cap_wei: U128(cap),
            lender_paid_wei: U128(s.lender_paid),
            remaining_lender_cap_wei: U128(if s.branch == Some(SettlementBranch::Default) {
                cap.saturating_sub(s.lender_paid)
            } else {
                0
            }),
            recovered_credit_units: U128(
                s.lender_paid
                    .checked_mul(l.terms.reference_units_per_eth)
                    .expect("bounded cap")
                    / WEI_PER_ETH,
            ),
            shortfall_credit_units: U128(s.shortfall),
            borrower_surplus_wei: U128(s.borrower_surplus),
            checkpoint_block_number: s.checkpoint.map(U64),
            current_intent: s.intent.as_ref().map(|f| IntentView {
                transfer: TransferIntentDto::from_native(&f.transfer),
                signing_preimage: vault::hex(&f.preimage),
                signing_digest: vault::hex(&f.digest),
                before_balance_wei: U128(f.before_balance),
                minimum_block_number: U64(f.minimum_block),
            }),
            candidate_count: u8::try_from(s.candidates.len()).expect("bounded candidates"),
            last_confirmation: s.last_confirmation.clone(),
            pending: self.get_pending(),
            pending_reason: self.financial_reason(),
            retired: l.phase == LoanPhase::Closed,
        })
    }
    pub fn get_signed_transactions(&self) -> Vec<SignedTransactionDto> {
        self.loan.as_ref().map_or_else(Vec::new, |l| {
            l.settlement
                .candidates
                .iter()
                .map(SignedTransactionDto::from_native)
                .collect()
        })
    }
}
impl Controller {
    fn financial_reason(&self) -> String {
        let Some(l) = self.loan.as_ref() else {
            return "Loan disabled".into();
        };
        if let Some(p) = self.pending.as_ref() {
            return format!(
                "Awaiting {:?} callback; generation {}",
                p.kind, p.generation
            );
        }
        let text = match l.settlement.stage {
            SettlementStage::ReadyToSign => {
                "Stored intent is immutable; request or retry its exact signature"
            }
            SettlementStage::Signed => {
                "Verified signed bytes await relay and authenticated inclusion confirmation"
            }
            SettlementStage::NeedsTopup => {
                "Positive ETH dust or insufficient fee budget; no release confirmed"
            }
            SettlementStage::Complete => "Closed at the proven Ethereum checkpoint; vault retired",
            _ => match l.phase {
                LoanPhase::Offered => {
                    "Awaiting liquidity, derived vault and fresh eligible collateral proof"
                }
                LoanPhase::Active => {
                    "CREDIT debt active; repay before maturity or lender declares default at maturity"
                }
                LoanPhase::Repaid | LoanPhase::DefaultLocked | LoanPhase::CancelLocked => {
                    "Branch locked; authenticate fresh settlement state"
                }
                LoanPhase::Closed => "Vault retired",
            },
        };
        text.into()
    }
}

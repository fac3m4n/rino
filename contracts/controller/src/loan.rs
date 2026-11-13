use crate::*;
use near_sdk::assert_one_yocto;
use rino_loan_core::{
    SettlementBranch, Terms, debt_units, demo_terms, initial_fee_budget, validate_collateral,
};
use rino_settlement_protocol::{decimal_u64, decimal_u128, fixed_hex};

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct LoanConfig {
    pub lender: AccountId,
    pub borrower_recipient: String,
    pub lender_recipient: String,
    pub settlement_wasm_url: String,
    pub settlement_wasm_sha256: String,
}
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoanPhase {
    Offered,
    Active,
    Repaid,
    DefaultLocked,
    CancelLocked,
    Closed,
}
#[near(serializers = [borsh])]
pub struct Loan {
    pub config: LoanConfig,
    pub terms: Terms,
    pub phase: LoanPhase,
    pub available: u128,
    pub claim: u128,
    pub debt: u128,
    pub borrowed_at: Option<u64>,
    pub maturity: Option<u64>,
    pub settlement: crate::settlement::Settlement,
}
impl Loan {
    pub fn new(config: LoanConfig, network: &NetworkMode) -> Self {
        assert!(
            config.lender != env::current_account_id(),
            "escrow cannot be lender"
        );
        executor::validate_url(&config.settlement_wasm_url);
        assert!(
            config.settlement_wasm_sha256.len() == 64
                && config
                    .settlement_wasm_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid settlement hash"
        );
        let borrower =
            fixed_hex::<20>(&config.borrower_recipient).expect("invalid borrower recipient");
        let lender = fixed_hex::<20>(&config.lender_recipient).expect("invalid lender recipient");
        assert!(
            borrower != [0; 20] && lender != [0; 20] && borrower != lender,
            "invalid recipients"
        );
        Self {
            config,
            terms: demo_terms(if matches!(network, NetworkMode::Sandbox { .. }) {
                120
            } else {
                86400
            }),
            phase: LoanPhase::Offered,
            available: 0,
            claim: 0,
            debt: 0,
            borrowed_at: None,
            maturity: None,
            settlement: Default::default(),
        }
    }
}
#[near]
impl Controller {
    #[payable]
    pub fn fund_liquidity(&mut self) {
        assert_one_yocto();
        self.assert_lender();
        let l = self.loan.as_ref().expect("loan disabled");
        assert_eq!(l.phase, LoanPhase::Offered, "offer unavailable");
        assert_eq!(l.available, 0, "already funded");
        let amount = l.terms.principal_units;
        self.credit_move(
            &env::predecessor_account_id(),
            &env::current_account_id(),
            amount,
        );
        self.loan.as_mut().unwrap().available = amount;
    }
    #[payable]
    pub fn borrow(&mut self) {
        assert_one_yocto();
        self.assert_borrower();
        let l = self.loan.as_ref().expect("loan disabled");
        assert_eq!(l.phase, LoanPhase::Offered, "loan unavailable");
        assert!(self.pending.is_none(), "operation pending");
        assert_eq!(self.status, Status::ProofReady, "eligible proof required");
        assert_eq!(
            l.available, l.terms.principal_units,
            "insufficient liquidity"
        );
        let proof = self.get_evidence().expect("eligible proof required");
        let timestamp = decimal_u64(&proof.block_timestamp).expect("unsupported proof time");
        assert!(
            timestamp <= Self::now() && Self::now() - timestamp <= 3600,
            "proof expired"
        );
        let balance = decimal_u128(&proof.balance_wei).expect("unsupported financial balance");
        validate_collateral(&l.terms, balance).expect("insufficient collateral");
        let debt = debt_units(&l.terms).expect("debt overflow");
        let budget = initial_fee_budget(&l.terms).expect("budget overflow");
        let maturity = Self::now()
            .checked_add(l.terms.term_seconds)
            .expect("maturity overflow");
        let amount = l.terms.principal_units;
        self.credit_move(
            &env::current_account_id(),
            &self.config.borrower.clone(),
            amount,
        );
        let l = self.loan.as_mut().unwrap();
        l.available = 0;
        l.debt = debt;
        l.phase = LoanPhase::Active;
        l.borrowed_at = Some(Self::now());
        l.maturity = Some(maturity);
        l.settlement.fee_budget = budget;
        l.settlement.balance = balance;
        l.settlement.accounted_balance = balance;
        l.settlement.baseline_set = true;
    }
    #[payable]
    pub fn repay(&mut self) {
        assert_one_yocto();
        self.assert_borrower();
        let l = self.loan.as_ref().expect("loan disabled");
        assert_eq!(l.phase, LoanPhase::Active, "active loan required");
        assert!(
            Self::now() < l.maturity.expect("active maturity"),
            "loan matured"
        );
        let debt = l.debt;
        let claim = l.claim.checked_add(debt).expect("claim overflow");
        self.credit_move(
            &self.config.borrower.clone(),
            &env::current_account_id(),
            debt,
        );
        let l = self.loan.as_mut().unwrap();
        l.debt = 0;
        l.claim = claim;
        l.phase = LoanPhase::Repaid;
        l.settlement.branch = Some(SettlementBranch::Repay);
    }
    #[payable]
    pub fn claim_credit(&mut self) {
        assert_one_yocto();
        self.assert_lender();
        let l = self.loan.as_ref().expect("loan disabled");
        let amount = l.claim.checked_add(l.available).expect("claim overflow");
        assert!(amount > 0, "no claim");
        let receiver = l.config.lender.clone();
        self.credit_move(&env::current_account_id(), &receiver, amount);
        let l = self.loan.as_mut().unwrap();
        l.claim = 0;
        l.available = 0;
    }
    pub fn declare_default(&mut self) {
        self.assert_lender();
        let l = self.loan.as_mut().expect("loan disabled");
        assert_eq!(l.phase, LoanPhase::Active, "active loan required");
        assert!(
            Self::now() >= l.maturity.expect("active maturity"),
            "loan not matured"
        );
        l.phase = LoanPhase::DefaultLocked;
        l.debt = 0;
        l.settlement.branch = Some(SettlementBranch::Default);
    }
}
impl Controller {
    pub(crate) fn assert_lender(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            self.loan.as_ref().expect("loan disabled").config.lender,
            "lender only"
        );
    }
    pub(crate) fn assert_party(&self) {
        let who = env::predecessor_account_id();
        assert!(
            who == self.config.borrower
                || who == self.loan.as_ref().expect("loan disabled").config.lender,
            "loan party only"
        );
    }
    pub(crate) fn cancel_loan(&mut self) {
        assert!(
            self.vault.is_some()
                && !matches!(self.status, Status::Uninitialized | Status::Deriving),
            "derive vault first"
        );
        let l = self.loan.as_mut().unwrap();
        assert_eq!(l.phase, LoanPhase::Offered, "cannot cancel loan");
        assert!(l.settlement.intent.is_none(), "intent locked");
        let generation = self
            .generation
            .checked_add(1)
            .expect("generation exhausted");
        l.phase = LoanPhase::CancelLocked;
        l.settlement.branch = Some(SettlementBranch::Cancel);
        l.settlement.fee_budget = initial_fee_budget(&l.terms).expect("budget overflow");
        self.generation = generation;
        self.pending = None;
        self.status = Status::Cancelled;
    }
}

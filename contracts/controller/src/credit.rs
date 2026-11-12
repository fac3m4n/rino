//! CREDIT is an embedded standard ledger. Only the fixed initialization issues tokens.
use crate::*;
use near_contract_standards::{
    fungible_token::{
        FungibleToken, FungibleTokenCore, FungibleTokenResolver,
        metadata::{FT_METADATA_SPEC, FungibleTokenMetadata, FungibleTokenMetadataProvider},
    },
    storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement},
};
use near_sdk::{NearToken, PromiseOrValue, assert_one_yocto};
impl Controller {
    pub(crate) fn initial_credit(loan: &loan::Loan, borrower: &AccountId) -> FungibleToken {
        let mut token = FungibleToken::new(b"credit".to_vec());
        for account in [&loan.config.lender, borrower, &env::current_account_id()] {
            token.internal_register_account(account);
        }
        token.internal_deposit(&loan.config.lender, 1_000_000_000);
        near_contract_standards::fungible_token::events::FtMint {
            owner_id: &loan.config.lender,
            amount: U128(1_000_000_000),
            memo: Some("Fixed demo supply; no redemption"),
        }
        .emit();
        token
    }
    fn token(&self) -> &FungibleToken {
        self.token.as_ref().expect("CREDIT disabled")
    }
    fn token_mut(&mut self) -> &mut FungibleToken {
        self.token.as_mut().expect("CREDIT disabled")
    }
    pub(crate) fn credit_move(&mut self, sender: &AccountId, receiver: &AccountId, amount: u128) {
        self.check_credit_move(sender, receiver, amount);
        self.token_mut()
            .internal_transfer(sender, receiver, amount, None);
    }
    fn check_credit_move(&self, sender: &AccountId, receiver: &AccountId, amount: u128) {
        assert!(amount > 0 && sender != receiver, "invalid transfer");
        let t = self.token();
        let from = t.accounts.get(sender).expect("sender unregistered");
        let to = t.accounts.get(receiver).expect("receiver unregistered");
        assert!(from >= amount, "insufficient CREDIT");
        to.checked_add(amount).expect("CREDIT overflow");
    }
    fn assert_external_credit(&self) {
        assert_ne!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "escrow is protected"
        );
    }
}
#[near]
impl FungibleTokenCore for Controller {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        assert_one_yocto();
        self.assert_external_credit();
        self.check_credit_move(&env::predecessor_account_id(), &receiver_id, amount.0);
        self.token_mut().ft_transfer(receiver_id, amount, memo);
    }
    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        assert_one_yocto();
        self.assert_external_credit();
        self.check_credit_move(&env::predecessor_account_id(), &receiver_id, amount.0);
        self.token_mut()
            .ft_transfer_call(receiver_id, amount, memo, msg)
    }
    fn ft_total_supply(&self) -> U128 {
        self.token.as_ref().map_or(U128(0), |t| t.ft_total_supply())
    }
    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token
            .as_ref()
            .map_or(U128(0), |t| t.ft_balance_of(account_id))
    }
}
#[near]
impl FungibleTokenResolver for Controller {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        Self::assert_self();
        self.token_mut()
            .ft_resolve_transfer(sender_id, receiver_id, amount)
    }
}
#[near]
impl FungibleTokenMetadataProvider for Controller {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.token();
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.into(),
            name: "ProofCredit demo CREDIT (no redemption)".into(),
            symbol: "CREDIT".into(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}
#[near]
impl StorageManagement for Controller {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token_mut()
            .storage_deposit(account_id, registration_only)
    }
    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.assert_external_credit();
        self.token_mut().storage_withdraw(amount)
    }
    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.assert_external_credit();
        let who = env::predecessor_account_id();
        let l = self.loan.as_ref().expect("CREDIT disabled");
        let borrower_obligation = who == self.config.borrower && l.phase != LoanPhase::Closed;
        let lender_obligation = who == l.config.lender
            && (l.phase != LoanPhase::Closed || l.available > 0 || l.claim > 0);
        assert!(
            !borrower_obligation && !lender_obligation,
            "loan participant has outstanding obligations"
        );
        let removed = self.token_mut().internal_storage_unregister(force);
        if let Some((account, balance)) = removed {
            if balance > 0 {
                near_contract_standards::fungible_token::events::FtBurn {
                    owner_id: &account,
                    amount: U128(balance),
                    memo: Some("Standard forced storage unregister"),
                }
                .emit();
            }
            true
        } else {
            false
        }
    }
    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token().storage_balance_bounds()
    }
    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token().storage_balance_of(account_id)
    }
}
#[near]
impl Controller {
    /// Incoming transfer-call messages grant no lending authority: refund all units.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        let _ = (sender_id, msg);
        amount
    }
}

use super::*;
use crate::tests::{ADDRESS, context, id};
use near_contract_standards::fungible_token::FungibleTokenCore;
const LENDER: &str = "lender.testnet";
fn config() -> LoanConfig {
    LoanConfig {
        lender: id(LENDER),
        borrower_recipient: "0x1111111111111111111111111111111111111111".into(),
        lender_recipient: "0x2222222222222222222222222222222222222222".into(),
        settlement_wasm_url: "https://example.com/settlement.wasm".into(),
        settlement_wasm_sha256: "552ddd26f2a0caaaad9c4e06ec08e24b24ab2c54c57d5b5b1991b03277f639a8"
            .into(),
    }
}
pub(super) fn market() -> Controller {
    near_sdk::mock::with_mocked_blockchain(|b| {
        b.take_storage();
    });
    context(LENDER, 1000, vec![]);
    let mut c = Controller::new(
        id("borrower.testnet"),
        id("executor.testnet"),
        "https://example.com/proof.wasm".into(),
        "ab".repeat(32),
        U128(0),
        NetworkMode::Sandbox {
            mpc: id("mpc.testnet"),
        },
        Some(config()),
    );
    c.vault = Some(ADDRESS.into());
    c.status = Status::ProofReady;
    c
}
#[test]
fn fixed_credit_supply_is_owned_only_by_lender_and_participants_registered() {
    let c = market();
    assert_eq!(c.ft_total_supply().0, 1_000_000_000);
    assert_eq!(c.ft_balance_of(id(LENDER)).0, 1_000_000_000);
    assert_eq!(c.ft_balance_of(id("borrower.testnet")).0, 0);
    assert_eq!(c.ft_balance_of(id("controller.testnet")).0, 0);
}
use near_sdk::{Gas, NearToken, test_utils::VMContextBuilder, testing_env};
use std::panic::{AssertUnwindSafe, catch_unwind};
pub(super) fn ctx(who: &str, now: u64) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(id("controller.testnet"))
            .predecessor_account_id(id(who))
            .signer_account_id(id(who))
            .block_timestamp(now * 1_000_000_000)
            .attached_deposit(NearToken::from_yoctonear(1))
            .prepaid_gas(Gas::from_tgas(300))
            .account_balance(NearToken::from_near(100))
            .build()
    );
}
pub(super) fn panic(f: impl FnOnce()) {
    assert!(catch_unwind(AssertUnwindSafe(f)).is_err());
}
fn eligible(c: &mut Controller, timestamp: u64, balance: &str) {
    c.evidence=Some(serde_json::to_vec(&serde_json::json!({"schema_version":1,"policy_id":"rpc-finalized-2of2-v1","status":"verified","controller_id":"controller.testnet","request_id":"1","request_hash":format!("0x{}","ab".repeat(32)),"chain_id":"11155111","vault":ADDRESS,"block_number":"42","block_hash":format!("0x{}","11".repeat(32)),"state_root":format!("0x{}","22".repeat(32)),"block_timestamp":timestamp.to_string(),"nonce":"0","balance_wei":balance,"code_hash":proofcredit_proof_protocol::EMPTY_CODE_HASH,"finality_basis":"rpc-finalized-2of2"})).unwrap());
}
pub(super) fn funded() -> Controller {
    let mut c = market();
    eligible(&mut c, 1000, "1000000000000000000");
    ctx(LENDER, 1000);
    c.fund_liquidity();
    c
}
#[test]
fn credit_transfers_are_usable_and_unsupported_receiver_does_not_spend() {
    let mut c = market();
    ctx(LENDER, 1000);
    c.ft_transfer(id("borrower.testnet"), U128(1_000_000), None);
    assert_eq!(c.ft_balance_of(id("borrower.testnet")).0, 1_000_000);
    let before = c.ft_balance_of(id(LENDER));
    panic(|| c.ft_transfer(id("unknown.testnet"), U128(1), None));
    assert_eq!(c.ft_balance_of(id(LENDER)), before);
    context(LENDER, 1000, vec![]);
    panic(|| c.ft_transfer(id("borrower.testnet"), U128(1), None));
}
#[test]
fn funding_borrow_repay_and_claim_conserve_exact_supply_and_debt() {
    let mut c = funded();
    ctx(LENDER, 1000);
    c.ft_transfer(id("borrower.testnet"), U128(1_000_000), None);
    ctx("borrower.testnet", 1000);
    c.borrow();
    let l = c.loan.as_ref().unwrap();
    assert_eq!(l.phase, LoanPhase::Active);
    assert_eq!(l.debt, 101_000_000);
    assert_eq!(l.maturity, Some(1120));
    assert_eq!(c.ft_balance_of(id("borrower.testnet")).0, 101_000_000);
    panic(|| c.borrow());
    c.repay();
    let l = c.loan.as_ref().unwrap();
    assert_eq!(l.phase, LoanPhase::Repaid);
    assert_eq!((l.debt, l.claim), (0, 101_000_000));
    assert_eq!(c.ft_balance_of(id("controller.testnet")).0, 101_000_000);
    panic(|| c.repay());
    ctx(LENDER, 1001);
    c.claim_credit();
    assert_eq!(c.ft_balance_of(id(LENDER)).0, 1_000_000_000);
    assert_eq!(c.loan.as_ref().unwrap().claim, 0);
    panic(|| c.claim_credit());
}
#[test]
fn no_fee_endowment_cannot_repay_and_receiver_failure_cannot_create_debt() {
    let mut c = funded();
    ctx("borrower.testnet", 1000);
    c.borrow();
    panic(|| c.repay());
    assert_eq!(c.loan.as_ref().unwrap().phase, LoanPhase::Active);
    assert_eq!(c.loan.as_ref().unwrap().debt, 101_000_000);
    assert_eq!(c.ft_balance_of(id("controller.testnet")).0, 0);
    // Simulate a registration failure before the atomic principal transfer.
    let mut c = funded();
    c.token
        .as_mut()
        .unwrap()
        .accounts
        .remove(&id("borrower.testnet"));
    ctx("borrower.testnet", 1000);
    panic(|| c.borrow());
    assert_eq!(c.loan.as_ref().unwrap().phase, LoanPhase::Offered);
    assert_eq!(c.loan.as_ref().unwrap().debt, 0);
    assert_eq!(c.loan.as_ref().unwrap().available, 100_000_000);
}
#[test]
fn withdrawal_donations_and_ownership_never_create_lender_entitlement() {
    let mut c = funded();
    ctx(LENDER, 1000);
    c.ft_transfer(id("controller.testnet"), U128(3), None);
    c.claim_credit();
    assert_eq!(c.ft_balance_of(id("controller.testnet")).0, 3);
    assert_eq!(c.loan.as_ref().unwrap().available, 0);
    ctx("borrower.testnet", 1000);
    panic(|| c.borrow());
    panic(|| c.fund_liquidity());
    panic(|| c.claim_credit());
    ctx(LENDER, 1000);
    c.fund_liquidity();
    assert_eq!(c.loan.as_ref().unwrap().available, 100_000_000);
}
#[test]
fn exact_proof_age_and_maturity_boundaries_lock_default_branch() {
    let mut c = funded();
    eligible(&mut c, 1000, "1000000000000000000");
    ctx(LENDER, 1000);
    c.ft_transfer(id("borrower.testnet"), U128(1_000_000), None);
    ctx("borrower.testnet", 4600);
    c.borrow();
    ctx(LENDER, 4719);
    panic(|| c.declare_default());
    ctx("borrower.testnet", 4720);
    panic(|| c.repay());
    assert_eq!(c.loan.as_ref().unwrap().phase, LoanPhase::Active);
    ctx(LENDER, 4720);
    c.declare_default();
    assert_eq!(c.loan.as_ref().unwrap().phase, LoanPhase::DefaultLocked);
    ctx("borrower.testnet", 4720);
    panic(|| c.repay());
    panic(|| c.cancel());
    let mut c = funded();
    ctx("borrower.testnet", 4601);
    panic(|| c.borrow());
    assert_eq!(c.loan.as_ref().unwrap().phase, LoanPhase::Offered);
    let mut c = funded();
    eligible(&mut c, 1000, "340282366920938463463374607431768211456");
    ctx("borrower.testnet", 1000);
    panic(|| c.borrow());
    eligible(&mut c, 1000, "100000000000000000");
    panic(|| c.borrow());
}
#[test]
fn financial_cancel_requires_fixed_vault_and_preloan_branch() {
    let mut c = market();
    c.status = Status::Uninitialized;
    c.vault = None;
    ctx("borrower.testnet", 1000);
    panic(|| c.cancel());
    c.vault = Some(ADDRESS.into());
    c.status = Status::Funding;
    c.cancel();
    assert_eq!(c.loan.as_ref().unwrap().phase, LoanPhase::CancelLocked);
    assert_eq!(c.vault.as_deref(), Some(ADDRESS));
    panic(|| c.borrow());
}
#[test]
fn expired_offered_proof_can_be_refreshed_but_active_collateral_cannot() {
    let mut c = funded();
    ctx("borrower.testnet", 4601);
    let b = ProofBundle {
        block_number: "43".into(),
        block_hash: format!("0x{}", "11".repeat(32)),
        state_root: format!("0x{}", "22".repeat(32)),
        block_timestamp: "4601".into(),
        account_proof: vec!["0xc0".into()],
    };
    drop(c.request_proof(b.clone()));
    assert_eq!(c.status, Status::ProofPending);
    panic(|| c.borrow());
    let mut c = funded();
    ctx("borrower.testnet", 1000);
    c.borrow();
    let mut fresh = b;
    fresh.block_timestamp = "1000".into();
    panic(|| {
        drop(c.request_proof(fresh));
    });
}
#[test]
fn standard_storage_resolver_and_unsupported_transfer_call_cannot_spend_escrow_claims() {
    use near_contract_standards::{
        fungible_token::FungibleTokenResolver, storage_management::StorageManagement,
    };
    use near_sdk::PromiseResult;
    let mut c = funded();
    assert!(c.storage_balance_of(id("borrower.testnet")).is_some());
    assert!(c.storage_balance_of(id("lender.testnet")).is_some());
    assert!(c.storage_balance_of(id("controller.testnet")).is_some());
    for who in ["borrower.testnet", "lender.testnet", "controller.testnet"] {
        ctx(who, 1000);
        panic(|| {
            c.storage_unregister(Some(true));
        });
    }
    ctx("controller.testnet", 1000);
    panic(|| c.ft_transfer(id("borrower.testnet"), U128(1), None));
    ctx("lender.testnet", 1000);
    drop(c.ft_transfer_call(id("controller.testnet"), U128(7), None, "repay".into()));
    assert_eq!(c.loan.as_ref().unwrap().available, 100_000_000);
    assert_eq!(c.loan.as_ref().unwrap().claim, 0);
    assert_eq!(
        c.ft_on_transfer(id("lender.testnet"), U128(7), "borrow".into())
            .0,
        7
    );
    context("attacker.testnet", 1000, vec![PromiseResult::Failed]);
    panic(|| {
        c.ft_resolve_transfer(id("lender.testnet"), id("controller.testnet"), U128(7));
    });
    context("controller.testnet", 1000, vec![PromiseResult::Failed]);
    assert_eq!(
        c.ft_resolve_transfer(id("lender.testnet"), id("controller.testnet"), U128(7))
            .0,
        0
    );
    assert_eq!(c.ft_balance_of(id("controller.testnet")).0, 100_000_000);
    assert_eq!(c.loan.as_ref().unwrap().available, 100_000_000);
}
#[test]
fn initial_supply_and_standard_forced_burn_emit_nep141_events() {
    use near_contract_standards::storage_management::StorageManagement;
    use near_sdk::test_utils::get_logs;
    let mut c = market();
    assert!(
        get_logs()
            .iter()
            .any(|l| l.contains("\"event\":\"ft_mint\"") && l.contains("1000000000"))
    );
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(id("controller.testnet"))
            .predecessor_account_id(id("holder.testnet"))
            .attached_deposit(NearToken::from_near(1))
            .account_balance(NearToken::from_near(100))
            .build()
    );
    c.storage_deposit(None, None);
    ctx("lender.testnet", 1000);
    c.ft_transfer(id("holder.testnet"), U128(5), None);
    ctx("holder.testnet", 1000);
    assert!(c.storage_unregister(Some(true)));
    assert_eq!(c.ft_total_supply().0, 999_999_995);
    assert!(
        get_logs()
            .iter()
            .any(|l| l.contains("\"event\":\"ft_burn\""))
    );
}

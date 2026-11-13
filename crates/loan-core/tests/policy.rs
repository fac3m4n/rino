use rino_loan_core::*;
const G: u128 = 2_100_000_000_000_000;
const C: u128 = 50_500_000_000_000_000;
fn state(branch: SettlementBranch, balance_wei: u128) -> SettlementState {
    SettlementState {
        branch,
        balance_wei,
        nonce: 7,
        vault: [1; 20],
        borrower: [2; 20],
        lender: [3; 20],
        lender_paid_wei: 0,
        remaining_fee_budget_wei: 6 * G,
        gas_price: 100_000_000_000,
    }
}
fn transfer(s: SettlementState, to: [u8; 20], value: u128) {
    assert_eq!(
        plan_transfer(&demo_terms(120), s),
        Ok(Plan::Transfer(TransferIntent {
            chain_id: 11_155_111,
            nonce: 7,
            to,
            value,
            gas_limit: 21000,
            gas_price: s.gas_price
        }))
    );
}
#[test]
fn exact_debt_cap_budget_and_one_wei_ltv_boundary() {
    let t = demo_terms(120);
    assert_eq!(debt_units(&t), Ok(101_000_000));
    assert_eq!(default_cap_wei(&t), Ok(C));
    assert_eq!(initial_fee_budget(&t), Ok(12_600_000_000_000_000));
    assert_eq!(
        validate_collateral(&t, 112_600_000_000_000_000),
        Ok(100_000_000_000_000_000)
    );
    assert_eq!(
        validate_collateral(&t, 112_599_999_999_999_999),
        Err(Error::InsufficientCollateral)
    );
    assert_eq!(
        validate_collateral(&t, 12_600_000_000_000_000),
        Err(Error::InsufficientCollateral)
    );
}
#[test]
fn checked_arithmetic_and_ceil_rounding() {
    let mut t = demo_terms(120);
    t.principal_units = u128::MAX;
    assert_eq!(debt_units(&t), Err(Error::Overflow));
    t = demo_terms(120);
    t.fee_cap_wei_per_gas = u128::MAX;
    assert_eq!(initial_fee_budget(&t), Err(Error::Overflow));
    assert_eq!(
        validate_collateral(&demo_terms(120), u128::MAX),
        Err(Error::Overflow)
    );
    t = demo_terms(120);
    t.reference_units_per_eth = 0;
    assert_eq!(default_cap_wei(&t), Err(Error::InvalidTerms));
    t = demo_terms(120);
    t.reference_units_per_eth = 3;
    t.principal_units = 1;
    t.fee_units = 0;
    assert_eq!(default_cap_wei(&t), Ok(333_333_333_333_333_334));
    t.principal_units = u128::MAX;
    assert_eq!(default_cap_wei(&t), Err(Error::Overflow));
}
#[test]
fn repay_cancel_close_zero_preserve_dust_and_drain_exactly() {
    for branch in [SettlementBranch::Repay, SettlementBranch::Cancel] {
        assert_eq!(
            plan_transfer(&demo_terms(120), state(branch, 0)),
            Ok(Plan::Complete {
                shortfall_credit_units: 0
            })
        );
        for b in [1, G - 1, G] {
            assert_eq!(
                plan_transfer(&demo_terms(120), state(branch, b)),
                Ok(Plan::NeedsTopup {
                    balance_wei: b,
                    required_fee_wei: G
                })
            );
        }
        transfer(state(branch, G + 1), [2; 20], 1);
        transfer(state(branch, C + 2 * G), [2; 20], C + G);
    }
}
#[test]
fn default_caps_full_and_partial_then_surplus_without_zero_value_transfers() {
    assert_eq!(
        plan_transfer(&demo_terms(120), state(SettlementBranch::Default, 0)),
        Ok(Plan::Complete {
            shortfall_credit_units: 101_000_000
        })
    );
    for b in [1, G - 1, G] {
        assert_eq!(
            plan_transfer(&demo_terms(120), state(SettlementBranch::Default, b)),
            Ok(Plan::NeedsTopup {
                balance_wei: b,
                required_fee_wei: G
            })
        );
    }
    for b in [G + 1, 2 * G, C + G - 1] {
        transfer(state(SettlementBranch::Default, b), [3; 20], b - G);
    }
    for b in [C + G, C + 2 * G, C + 3 * G] {
        transfer(state(SettlementBranch::Default, b), [3; 20], C);
    }
    let mut s = state(SettlementBranch::Default, 5 * G);
    s.lender_paid_wei = C;
    transfer(s, [2; 20], 4 * G);
    s.balance_wei = G;
    assert_eq!(
        plan_transfer(&demo_terms(120), s),
        Ok(Plan::NeedsTopup {
            balance_wei: G,
            required_fee_wei: G
        })
    );
}
#[test]
fn incoming_funds_after_partial_payment_still_pay_only_unpaid_cap() {
    let mut s = state(SettlementBranch::Default, C + 3 * G);
    s.lender_paid_wei = C - 10;
    transfer(s, [3; 20], 10);
    s.balance_wei = 0;
    assert_eq!(
        plan_transfer(&demo_terms(120), s),
        Ok(Plan::Complete {
            shortfall_credit_units: 1
        })
    );
    s.lender_paid_wei = C + 1;
    assert_eq!(plan_transfer(&demo_terms(120), s), Err(Error::InvalidPaid));
}
#[test]
fn exhausted_budget_invalid_fee_address_and_nonce_overflow_issue_no_transfer() {
    let mut s = state(SettlementBranch::Cancel, C);
    s.remaining_fee_budget_wei = G - 1;
    assert_eq!(
        plan_transfer(&demo_terms(120), s),
        Ok(Plan::NeedsTopup {
            balance_wei: C,
            required_fee_wei: G
        })
    );
    for f in [0, 100_000_000_001] {
        s.gas_price = f;
        assert_eq!(plan_transfer(&demo_terms(120), s), Err(Error::InvalidFee));
    }
    s = state(SettlementBranch::Cancel, C);
    s.borrower = s.vault;
    assert_eq!(
        plan_transfer(&demo_terms(120), s),
        Err(Error::InvalidAddress)
    );
    s = state(SettlementBranch::Cancel, C);
    s.nonce = u64::MAX;
    assert_eq!(plan_transfer(&demo_terms(120), s), Err(Error::Overflow));
    s = state(SettlementBranch::Cancel, C);
    s.gas_price = 1;
    s.remaining_fee_budget_wei = 21000;
    transfer(s, [2; 20], C - 21000);
}

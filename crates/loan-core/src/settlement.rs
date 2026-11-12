use crate::{debt_units, default_cap_wei, Error, Terms, CHAIN_ID, GAS_LIMIT, WEI_PER_ETH};
use borsh::{BorshDeserialize, BorshSerialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum SettlementBranch {
    Repay,
    Cancel,
    Default,
}

/// Frozen, purpose-restricted native transfer. Calldata/access lists are always empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct TransferIntent {
    pub chain_id: u64,
    pub nonce: u64,
    pub to: [u8; 20],
    pub value: u128,
    pub gas_limit: u64,
    pub gas_price: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum Plan {
    Transfer(TransferIntent),
    Complete {
        shortfall_credit_units: u128,
    },
    NeedsTopup {
        balance_wei: u128,
        required_fee_wei: u128,
    },
}

/// All balance/nonce fields must come from authenticated current state. The
/// controller owns branch locking, fee debits, payment totals and replay control.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettlementState {
    pub branch: SettlementBranch,
    pub balance_wei: u128,
    pub nonce: u64,
    pub vault: [u8; 20],
    pub borrower: [u8; 20],
    pub lender: [u8; 20],
    pub lender_paid_wei: u128,
    pub remaining_fee_budget_wei: u128,
    pub gas_price: u128,
}

pub fn plan_transfer(terms: &Terms, state: SettlementState) -> Result<Plan, Error> {
    if state.gas_price == 0 || state.gas_price > terms.fee_cap_wei_per_gas {
        return Err(Error::InvalidFee);
    }
    if [state.vault, state.borrower, state.lender].contains(&[0; 20])
        || state.borrower == state.vault
        || state.lender == state.vault
        || state.borrower == state.lender
    {
        return Err(Error::InvalidAddress);
    }
    let cap = default_cap_wei(terms)?;
    if state.lender_paid_wei > cap
        || (state.branch != SettlementBranch::Default && state.lender_paid_wei != 0)
    {
        return Err(Error::InvalidPaid);
    }
    if state.balance_wei == 0 {
        let recovered = state
            .lender_paid_wei
            .checked_mul(terms.reference_units_per_eth)
            .ok_or(Error::Overflow)?
            / WEI_PER_ETH;
        let shortfall_credit_units = if state.branch == SettlementBranch::Default {
            debt_units(terms)?.saturating_sub(recovered)
        } else {
            0
        };
        return Ok(Plan::Complete {
            shortfall_credit_units,
        });
    }
    let fee = state
        .gas_price
        .checked_mul(u128::from(GAS_LIMIT))
        .ok_or(Error::Overflow)?;
    if state.balance_wei <= fee || state.remaining_fee_budget_wei < fee {
        return Ok(Plan::NeedsTopup {
            balance_wei: state.balance_wei,
            required_fee_wei: fee,
        });
    }
    // A prepared transfer must have a representable authenticated post-nonce.
    state.nonce.checked_add(1).ok_or(Error::Overflow)?;
    let transferable = state.balance_wei.checked_sub(fee).ok_or(Error::Overflow)?;
    let remaining_cap = cap
        .checked_sub(state.lender_paid_wei)
        .ok_or(Error::InvalidPaid)?;
    let (to, value) = if state.branch == SettlementBranch::Default && remaining_cap > 0 {
        (state.lender, transferable.min(remaining_cap))
    } else {
        (state.borrower, transferable)
    };
    Ok(Plan::Transfer(TransferIntent {
        chain_id: CHAIN_ID,
        nonce: state.nonce,
        to,
        value,
        gas_limit: GAS_LIMIT,
        gas_price: state.gas_price,
    }))
}

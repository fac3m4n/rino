use crate::Error;
use borsh::{BorshDeserialize, BorshSerialize};

pub const WEI_PER_ETH: u128 = 1_000_000_000_000_000_000;
pub const CHAIN_ID: u64 = 11_155_111;
pub const GAS_LIMIT: u64 = 21_000;

/// Immutable integer offer. No JSON financial representation is exposed here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Terms {
    pub principal_units: u128,
    pub fee_units: u128,
    pub reference_units_per_eth: u128,
    pub max_ltv_bps: u16,
    pub term_seconds: u64,
    pub fee_cap_wei_per_gas: u128,
}

pub fn demo_terms(term_seconds: u64) -> Terms {
    Terms {
        principal_units: 100_000_000,
        fee_units: 1_000_000,
        reference_units_per_eth: 2_000_000_000,
        max_ltv_bps: 5000,
        term_seconds,
        fee_cap_wei_per_gas: 100_000_000_000,
    }
}

pub fn debt_units(terms: &Terms) -> Result<u128, Error> {
    terms
        .principal_units
        .checked_add(terms.fee_units)
        .ok_or(Error::Overflow)
}

pub fn initial_fee_budget(terms: &Terms) -> Result<u128, Error> {
    if terms.fee_cap_wei_per_gas == 0 {
        return Err(Error::InvalidTerms);
    }
    terms
        .fee_cap_wei_per_gas
        .checked_mul(u128::from(GAS_LIMIT))
        .and_then(|v| v.checked_mul(6))
        .ok_or(Error::Overflow)
}

/// Returns pledgeable wei after excluding the complete six-attempt fee budget.
/// Overflow rejects an unsupported financial range rather than truncating it.
pub fn validate_collateral(terms: &Terms, balance_wei: u128) -> Result<u128, Error> {
    if terms.principal_units == 0
        || terms.reference_units_per_eth == 0
        || terms.max_ltv_bps == 0
        || terms.max_ltv_bps > 10_000
        || terms.term_seconds == 0
    {
        return Err(Error::InvalidTerms);
    }
    let pledgeable = balance_wei
        .checked_sub(initial_fee_budget(terms)?)
        .ok_or(Error::InsufficientCollateral)?;
    let reference_value = pledgeable
        .checked_mul(terms.reference_units_per_eth)
        .ok_or(Error::Overflow)?
        / WEI_PER_ETH;
    let limit = reference_value
        .checked_mul(u128::from(terms.max_ltv_bps))
        .ok_or(Error::Overflow)?
        / 10_000;
    if terms.principal_units > limit {
        return Err(Error::InsufficientCollateral);
    }
    Ok(pledgeable)
}

pub fn default_cap_wei(terms: &Terms) -> Result<u128, Error> {
    if terms.reference_units_per_eth == 0 {
        return Err(Error::InvalidTerms);
    }
    let numerator = debt_units(terms)?
        .checked_mul(WEI_PER_ETH)
        .ok_or(Error::Overflow)?;
    // Quotient/remainder ceiling avoids an unnecessary numerator + denominator overflow.
    let quotient = numerator / terms.reference_units_per_eth;
    quotient
        .checked_add(u128::from(numerator % terms.reference_units_per_eth != 0))
        .ok_or(Error::Overflow)
}

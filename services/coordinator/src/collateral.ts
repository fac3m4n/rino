import type { Terms } from "./api.ts";
const U128_MAX = (1n << 128n) - 1n;
export const COLLATERAL_TARGET_WEI = 120_000_000_000_000_000n;
function u128(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    value.length > 39
  )
    throw new Error("Invalid collateral amount");
  const n = BigInt(value);
  if (n > U128_MAX) throw new Error("Collateral amount exceeds u128");
  return n;
}
function multiply(a: bigint, b: bigint): bigint {
  const n = a * b;
  if (n > U128_MAX) throw new Error("Collateral arithmetic overflow");
  return n;
}
/** Mirrors loan-core::terms::validate_collateral: principal, reserve, two floors, checked u128. */
export function collateralSufficient(terms: Terms, balance: unknown): boolean {
  try {
    const principal = u128(terms.principal_units);
    const reference = u128(terms.reference_units_per_eth);
    const ltv = u128(terms.max_ltv_bps);
    const term = u128(terms.term_seconds);
    const cap = u128(terms.fee_cap_wei_per_gas);
    if (
      !principal ||
      !reference ||
      !ltv ||
      ltv > 10_000n ||
      !term ||
      term > (1n << 64n) - 1n ||
      !cap
    )
      return false;
    const reserve = multiply(multiply(cap, 21_000n), 6n);
    const amount = u128(balance);
    if (amount < reserve) return false;
    const value =
      multiply(amount - reserve, reference) / 1_000_000_000_000_000_000n;
    return principal <= multiply(value, ltv) / 10_000n;
  } catch {
    return false;
  }
}
/** No deposit when already sufficient; otherwise top up only to the documented target. */
export function collateralShortfall(terms: Terms, balance: unknown): bigint {
  const current = u128(balance);
  if (collateralSufficient(terms, balance)) return 0n;
  if (
    current >= COLLATERAL_TARGET_WEI ||
    !collateralSufficient(terms, COLLATERAL_TARGET_WEI.toString())
  )
    throw new Error("Unsupported collateral terms or range");
  return COLLATERAL_TARGET_WEI - current;
}

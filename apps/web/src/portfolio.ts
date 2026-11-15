import type { Role, ActionName } from "@rino/coordinator/api";
import type { Snapshot } from "./client";
import type { MarketDescriptor } from "./markets";
import { collateralSufficient } from "@rino/coordinator/collateral";
export interface PositionRecord {
  descriptor: MarketDescriptor;
  snapshot?: Snapshot;
  paused: boolean;
  pending: boolean;
  unavailable: boolean;
}
export interface AssetBalance {
  assetId: string;
  name: string;
  units: bigint;
}
/** Match the current public/local coordinators' fixed 1 CREDIT endowment. */
export function fundingAmounts(record: PositionRecord) {
  const snapshot = record.snapshot,
    market = snapshot?.state.market;
  if (!market) return { escrowUnits: 0n, feeUnits: 0n };
  const balance = BigInt(market.borrower_balance_units);
  return {
    escrowUnits:
      BigInt(market.available_liquidity_units) === 0n
        ? BigInt(market.terms.principal_units)
        : 0n,
    feeUnits:
      snapshot.config.mode === "public"
        ? balance < 1000000n
          ? 1000000n - balance
          : 0n
        : balance === 0n
          ? 1000000n
          : 0n,
  };
}
const ready = (r: PositionRecord) =>
  !!r.snapshot &&
  !r.unavailable &&
  r.snapshot.config.ready &&
  r.snapshot.state.ready;
export function claimable(record: PositionRecord): bigint {
  const market = record.snapshot?.state.market;
  if (!market) return 0n;
  return (
    BigInt(market.lender_claim_units) + BigInt(market.available_liquidity_units)
  );
}
function hasLenderPayout(record: PositionRecord): boolean {
  const market = record.snapshot?.state.market;
  return (
    !!market &&
    (BigInt(market.lender_claim_units) > 0n ||
      ((market.phase === "CancelLocked" || market.phase === "Closed") &&
        claimable(record) > 0n))
  );
}
export function portfolioSummary(
  records: PositionRecord[],
  paused = records.some((record) => record.paused),
): {
  collateralWei: bigint | null;
  debts: AssetBalance[];
  claimable: AssetBalance[];
  committed: AssetBalance[];
  availableOffers: number | null;
} {
  const complete = records.every(ready);
  const debts: AssetBalance[] = [],
    claims: AssetBalance[] = [],
    committed: AssetBalance[] = [];
  let collateral = 0n,
    available = 0;
  for (const r of records) {
    const s = r.snapshot;
    if (!s) continue;
    const m = s.state.market;
    if (!m) continue;
    const assetId = `${s.config.near.networkId}:${s.config.near.controllerId}`;
    const base = { assetId, name: r.descriptor.name };
    collateral += s.state.settlement?.retired
      ? 0n
      : BigInt(s.state.ethereum?.vaultBalanceWei ?? "0");
    const debt =
      m.phase === "DefaultLocked"
        ? BigInt(m.terms.debt_units)
        : BigInt(m.debt_units);
    if (debt > 0n) debts.push({ ...base, units: debt });
    const claim = claimable(r);
    if (claim > 0n) claims.push({ ...base, units: claim });
    const capital =
      BigInt(m.available_liquidity_units) +
      (m.phase === "Active" ? BigInt(m.terms.principal_units) : 0n);
    if (capital > 0n) committed.push({ ...base, units: capital });
    if (
      ready(r) &&
      !r.paused &&
      !r.pending &&
      !s.state.busy &&
      m.phase === "Offered" &&
      !!m.vault &&
      !s.state.settlement?.retired &&
      m.proof_fresh &&
      collateralSufficient(m.terms, s.state.ethereum?.vaultBalanceWei) &&
      collateralSufficient(m.terms, s.state.evidence?.balance_wei) &&
      BigInt(m.available_liquidity_units) === BigInt(m.terms.principal_units)
    )
      available++;
  }
  return {
    collateralWei: complete ? collateral : null,
    debts,
    claimable: claims,
    committed,
    availableOffers: complete ? (paused ? 0 : available) : null,
  };
}
export function positionAction(
  r: PositionRecord,
  role: Role,
): {
  label: string;
  action?: ActionName;
  panel?: "position" | "recovery";
  disabled?: boolean;
} {
  if (r.paused) return { label: "Check request", panel: "recovery" };
  if (!ready(r))
    return { label: r.unavailable ? "Unavailable" : "Loading", disabled: true };
  const s = r.snapshot!.state,
    m = s.market,
    mode = r.snapshot!.config.mode;
  if (r.pending || s.busy) return { label: "Confirming", disabled: true };
  if (role === "lender" && hasLenderPayout(r))
    return { label: "Claim CREDIT", action: "claim" };
  if (!m?.vault)
    return role === "borrower"
      ? { label: "New position", action: "initialize" }
      : { label: "Awaiting vault", disabled: true };
  if (m.phase === "Closed")
    return { label: "View settlement", panel: "position" };
  if (m.phase === "Offered") {
    const funded =
      BigInt(m.available_liquidity_units) >= BigInt(m.terms.principal_units);
    if (role === "lender")
      return !funded ||
        (mode === "public" &&
          BigInt(m.borrower_balance_units) < BigInt(m.terms.fee_units))
        ? { label: "Fund offer", action: "fund" }
        : { label: "Offer funded", disabled: true };
    if (!collateralSufficient(m.terms, s.ethereum?.vaultBalanceWei))
      return mode === "local"
        ? { label: "Awaiting funding", disabled: true }
        : { label: "Add collateral", action: "fund" };
    if (!funded) return { label: "Awaiting funding", disabled: true };
    if (
      !m.proof_fresh ||
      !collateralSufficient(m.terms, s.evidence?.balance_wei)
    )
      return { label: "Verify collateral", action: "prove" };
    return { label: "Borrow CREDIT", action: "borrow" };
  }
  if (m.phase === "Active") {
    const matured =
      !!m.maturity &&
      !!s.nearTimeSeconds &&
      BigInt(s.nearTimeSeconds) >= BigInt(m.maturity);
    if (role === "lender")
      return matured
        ? { label: "Settle overdue", action: "default" }
        : { label: "Awaiting repayment", disabled: true };
    if (matured) return { label: "View overdue loan", panel: "position" };
    if (BigInt(m.borrower_balance_units) < BigInt(m.debt_units))
      return { label: "More CREDIT needed", panel: "position" };
    return { label: "Repay loan", action: "repay" };
  }
  if (role === "borrower" || m.phase === "DefaultLocked")
    return { label: "Release collateral", action: "settle" };
  return { label: "View position", panel: "position" };
}
export function positionStatus(
  r: PositionRecord,
  role: Role,
): { label: string; tone: string } {
  if (r.paused) return { label: "Needs checking", tone: "warning" };
  if (r.unavailable) return { label: "Unavailable", tone: "danger" };
  if (r.pending || r.snapshot?.state.busy)
    return { label: "Confirming", tone: "warning" };
  if (!ready(r))
    return { label: r.snapshot ? "Unavailable" : "Loading", tone: "neutral" };
  const s = r.snapshot!.state,
    m = s.market;
  if (role === "lender" && hasLenderPayout(r))
    return { label: "Claimable", tone: "repaid" };
  if (s.settlement?.retired || m?.phase === "Closed")
    return { label: "Closed", tone: "neutral" };
  if (!m?.vault) return { label: "Not initialized", tone: "neutral" };
  if (m.phase === "Repaid") return { label: "Repaid", tone: "repaid" };
  if (m.phase === "CancelLocked")
    return { label: "Cancelled", tone: "neutral" };
  if (m.phase === "DefaultLocked")
    return { label: "Default settlement", tone: "warning" };
  if (m.phase === "Active")
    return m.maturity &&
      s.nearTimeSeconds &&
      BigInt(s.nearTimeSeconds) >= BigInt(m.maturity)
      ? { label: "Past maturity", tone: "danger" }
      : { label: "Active", tone: "active" };
  if (role === "lender")
    return BigInt(m.available_liquidity_units) > 0n
      ? { label: "Funded", tone: "ready" }
      : { label: "Open offer", tone: "ready" };
  if (!collateralSufficient(m.terms, s.ethereum?.vaultBalanceWei))
    return { label: "Needs collateral", tone: "neutral" };
  if (BigInt(m.available_liquidity_units) < BigInt(m.terms.principal_units))
    return { label: "Awaiting funding", tone: "neutral" };
  if (!m.proof_fresh || !collateralSufficient(m.terms, s.evidence?.balance_wei))
    return { label: "Verify collateral", tone: "neutral" };
  return { label: "Ready to borrow", tone: "ready" };
}
export function isOpenPosition(r: PositionRecord, role: Role) {
  return (
    !r.snapshot?.state.settlement?.retired ||
    (role === "lender" && claimable(r) > 0n)
  );
}

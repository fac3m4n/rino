import { describe, expect, it } from "vitest";
import {
  positionAction,
  positionStatus,
  portfolioSummary,
  isOpenPosition,
  claimable,
  fundingAmounts,
} from "../src/portfolio";
import { configFixture, stateFixture, settlementFixture } from "./fixtures";
const item = (id = "primary", controller = "controller.test") => ({
  descriptor: {
    id,
    name: `ETH ${id}`,
    apiBase: id === "primary" ? "/api" : `/api/markets/${id}`,
    controllerId: controller,
    networkId: "sandbox" as const,
  },
  snapshot: {
    config: {
      ...configFixture,
      near: { ...configFixture.near, controllerId: controller },
    },
    state: structuredClone(stateFixture),
    receipts: [],
  },
  paused: false,
  pending: false,
  unavailable: false,
});
describe("live portfolio boundaries", () => {
  it("quotes only the missing public fee endowment and no duplicate funded escrow", () => {
    const a = item();
    a.snapshot.config.mode = "public";
    a.snapshot.state.market!.borrower_balance_units = "1";
    expect(fundingAmounts(a)).toEqual({ escrowUnits: 0n, feeUnits: 999999n });
    a.snapshot.state.market!.available_liquidity_units = "0";
    expect(fundingAmounts(a)).toEqual({
      escrowUnits: 100000000n,
      feeUnits: 999999n,
    });
    a.snapshot.config.mode = "local";
    expect(fundingAmounts(a).feeUnits).toBe(0n);
  });
  it("quotes withdrawable offer escrow without relabeling a funded offer as repaid", () => {
    const a = item();
    a.snapshot.state.market!.phase = "Offered";
    a.snapshot.state.market!.debt_units = "0";
    expect(claimable(a)).toBe(100000000n);
    expect(positionStatus(a, "lender")).toEqual({
      label: "Funded",
      tone: "ready",
    });
    expect(positionAction(a, "lender").action).toBeUndefined();
  });
  it("keeps CREDIT debt in separate token identities instead of adding unrelated balances", () => {
    const a = item(),
      b = item("reserve", "reserve.test");
    const totals = portfolioSummary([a, b]);
    expect(totals.collateralWei).toBe(240000000000000000n);
    expect(totals.debts).toHaveLength(2);
    expect(totals.debts.map((x) => x.units)).toEqual([101000000n, 101000000n]);
  });
  it("does not present incomplete or stale portfolio values as current totals", () => {
    const a = item(),
      b = item("reserve", "reserve.test");
    b.unavailable = true;
    expect(portfolioSummary([a, b]).collateralWei).toBeNull();
    expect(portfolioSummary([a, b]).availableOffers).toBeNull();
  });
  it("counts only exact funded collateral-verified offers and pauses unresolved requests", () => {
    const a = item();
    const m = a.snapshot.state.market!;
    m.phase = "Offered";
    m.debt_units = "0";
    a.snapshot.state.evidence = { balance_wei: "120000000000000000" };
    expect(portfolioSummary([a]).availableOffers).toBe(1);
    a.paused = true;
    expect(portfolioSummary([a]).availableOffers).toBe(0);
    a.paused = false;
    m.proof_fresh = false;
    expect(portfolioSummary([a]).availableOffers).toBe(0);
  });
  it("retains independent lender claims after ETH vault retirement", () => {
    const a = item();
    a.snapshot.state.market!.phase = "Closed";
    a.snapshot.state.market!.lender_claim_units = "101000000";
    a.snapshot.state.settlement = {
      ...settlementFixture,
      stage: "Complete",
      retired: true,
    };
    expect(isOpenPosition(a, "lender")).toBe(true);
    expect(isOpenPosition(a, "borrower")).toBe(false);
    expect(positionAction(a, "lender").action).toBe("claim");
    expect(positionStatus(a, "lender").label).toBe("Claimable");
  });
  it("never offers repayment at maturity or with insufficient CREDIT", () => {
    const a = item();
    a.snapshot.state.nearTimeSeconds = a.snapshot.state.market!.maturity;
    expect(positionAction(a, "borrower").action).toBeUndefined();
    expect(positionStatus(a, "borrower").label).toBe("Past maturity");
    a.snapshot.state.nearTimeSeconds = "100";
    a.snapshot.state.market!.borrower_balance_units = "100000000";
    expect(positionAction(a, "borrower").action).toBeUndefined();
    expect(positionAction(a, "borrower").label).toContain("CREDIT");
  });
  it("returns recovery instead of a second financial action while outcome is unknown", () => {
    const a = item();
    a.paused = true;
    expect(positionAction(a, "borrower").panel).toBe("recovery");
    expect(positionStatus(a, "borrower").label).toBe("Needs checking");
  });
});
it("does not advertise other offers while the shared wallet has an unresolved request", () => {
  const a = item(),
    b = item("reserve", "reserve.test");
  a.paused = true;
  b.snapshot.state.market!.phase = "Offered";
  b.snapshot.state.market!.debt_units = "0";
  b.snapshot.state.evidence = { balance_wei: "120000000000000000" };
  expect(portfolioSummary([a, b]).availableOffers).toBe(0);
});

import { describe, expect, it } from "vitest";
import type { Config, State } from "@proofcredit/coordinator/api";
import {
  formatUnits,
  actionGuard,
  settlementLabel,
  loanHistory,
  offeredAction,
} from "../src/model";
import { configFixture, stateFixture, settlementFixture } from "./fixtures";

const config = configFixture;
const state = stateFixture;
// These catch precision loss, early action enablement and optimistic receipt success.
describe("integer token display", () => {
  it("formats balances beyond the floating point safe integer exactly", () =>
    expect(formatUnits("123456789012345678901234", 18, 18)).toBe(
      "123,456.789012345678901234",
    ));
  it("preserves a single smallest CREDIT unit", () =>
    expect(formatUnits("1", 6, 6)).toBe("0.000001"));
  it("truncates ETH display without rounding collateral up", () =>
    expect(formatUnits("99999999999999999", 18, 4)).toBe("0.0999"));
});
describe("transaction readiness", () => {
  it("blocks every action during pending work", () =>
    expect(
      actionGuard("repay", config, { ...state, busy: true }, "borrower"),
    ).toContain("pending"));
  it("blocks actions when configuration is unready", () =>
    expect(
      actionGuard("repay", { ...config, ready: false }, state, "borrower"),
    ).toContain("ready"));
  it("blocks a public action from the wrong NEAR identity", () =>
    expect(
      actionGuard("repay", { ...config, mode: "public" }, state, "borrower", {
        nearAccount: "stranger.test",
        evmChainId: 11155111,
      }),
    ).toContain("borrower.test"));
  it("blocks Ethereum funding on the wrong wallet network", () =>
    expect(
      actionGuard(
        "fund",
        { ...config, mode: "public" },
        { ...state, market: { ...state.market!, phase: "Offered" } },
        "borrower",
        { nearAccount: "borrower.test", evmChainId: 1 },
      ),
    ).toContain("Sepolia"));
  it("rejects repayment at the exact maturity boundary", () =>
    expect(
      actionGuard(
        "repay",
        config,
        { ...state, nearTimeSeconds: "200" },
        "borrower",
      ),
    ).toContain("matured"));
  it("does not permit default before maturity", () =>
    expect(actionGuard("default", config, state, "lender")).toContain(
      "maturity",
    ));
  it("does not permit a stale proof to enable borrowing", () =>
    expect(
      actionGuard(
        "borrow",
        config,
        {
          ...state,
          market: { ...state.market!, phase: "Offered", proof_fresh: false },
        },
        "borrower",
      ),
    ).toContain("proof"));
  it("does not permit borrower-only actions for the lender", () =>
    expect(actionGuard("repay", config, state, "lender")).toContain(
      "borrower",
    ));
  it("permits a funded fresh offer to borrow", () =>
    expect(
      actionGuard(
        "borrow",
        config,
        { ...state, market: { ...state.market!, phase: "Offered" } },
        "borrower",
      ),
    ).toBeNull());
  it("prohibits depositing into a retired vault", () =>
    expect(
      actionGuard(
        "fund",
        config,
        { ...state, settlement: { ...settlementFixture, retired: true } },
        "borrower",
      ),
    ).toContain("retired"));
});
describe("settlement evidence labels", () => {
  it("never calls an included Ethereum transaction an authenticated release", () =>
    expect(settlementLabel("Confirming")).toBe(
      "Included · awaiting NEAR authentication",
    ));
  it("shows completion only for the authenticated terminal stage", () =>
    expect(settlementLabel("Complete")).toBe("NEAR-authenticated release"));
});
describe("derived vault initialization", () => {
  it("allows initialization for a deployed market without a derived vault", () =>
    expect(
      actionGuard(
        "initialize",
        config,
        { ...state, market: { ...state.market!, vault: null } },
        "borrower",
      ),
    ).toBeNull());
});
describe("local actor authority", () => {
  const offered = {
    ...state,
    market: { ...state.market!, phase: "Offered" as const },
  };
  it("allows the local lender to fund the offer and vault", () =>
    expect(actionGuard("fund", config, offered, "lender")).toBeNull());
  it("requires the local lender for the bundled funding action", () =>
    expect(actionGuard("fund", config, offered, "borrower")).toContain(
      "lender",
    ));
  it("requires the local lender for time travel", () =>
    expect(
      actionGuard("advance-maturity", config, state, "borrower"),
    ).toContain("lender"));
});
describe("participant and state guards", () => {
  it("requires the borrower to request collateral authentication", () =>
    expect(actionGuard("prove", config, state, "lender")).toContain(
      "borrower",
    ));
  it("requires the borrower for challenge transactions", () =>
    expect(actionGuard("challenge-forgery", config, state, "lender")).toContain(
      "borrower",
    ));
  it("blocks borrowing when escrow is one unit short", () =>
    expect(
      actionGuard(
        "borrow",
        config,
        {
          ...state,
          market: {
            ...state.market!,
            phase: "Offered",
            available_liquidity_units: "99999999",
          },
        },
        "borrower",
      ),
    ).toContain("insufficient"));
  it("allows lender default at exact maturity", () =>
    expect(
      actionGuard(
        "default",
        config,
        { ...state, nearTimeSeconds: "200" },
        "lender",
      ),
    ).toBeNull());
});
describe("challenge prerequisites", () => {
  it("rejects the duplicate challenge outside an active loan", () =>
    expect(
      actionGuard(
        "challenge-duplicate",
        config,
        { ...state, market: { ...state.market!, phase: "Closed" } },
        "borrower",
      ),
    ).toContain("active"));
  it("requires an otherwise eligible funded offer for forged proof challenge", () =>
    expect(
      actionGuard(
        "challenge-forgery",
        config,
        {
          ...state,
          market: { ...state.market!, phase: "Offered" },
          ethereum: { ...state.ethereum!, vaultBalanceWei: "0" },
        },
        "borrower",
      ),
    ).toContain("funded"));
});

describe("honest cancellation history", () => {
  it("never labels a cancelled credit line as borrowed after terminal closure", () => {
    expect(
      loanHistory({
        ...state,
        market: { ...state.market!, phase: "Closed", borrowed_at: null },
        settlement: {
          ...settlementFixture,
          stage: "Complete",
          branch: "cancel",
          retired: true,
        },
      }),
    ).toEqual({ borrowed: false, cancelled: true });
  });
  it("retains borrowing history after a repaid loan closes", () => {
    expect(
      loanHistory({
        ...state,
        market: { ...state.market!, phase: "Closed" },
        settlement: {
          ...settlementFixture,
          stage: "Complete",
          branch: "repay",
          retired: true,
        },
      }),
    ).toEqual({ borrowed: true, cancelled: false });
  });
});

describe("public funding authority", () => {
  const offered = {
    ...state,
    market: {
      ...state.market!,
      phase: "Offered" as const,
      available_liquidity_units: "0",
    },
  };
  it("allows CREDIT funding only from the connected lender NEAR account without an EVM wallet", () =>
    expect(
      actionGuard("fund", { ...config, mode: "public" }, offered, "lender", {
        nearAccount: "lender.test",
      }),
    ).toBeNull());
  it("blocks public lender funding from a different NEAR identity", () =>
    expect(
      actionGuard("fund", { ...config, mode: "public" }, offered, "lender", {
        nearAccount: "stranger.test",
        evmChainId: 11155111,
      }),
    ).toContain("lender.test"));
});

describe("terminal and recovery action readiness", () => {
  const closed: State = {
    ...state,
    market: {
      ...state.market!,
      phase: "Closed",
      available_liquidity_units: "0",
      lender_claim_units: "0",
      debt_units: "0",
    },
    settlement: {
      ...settlementFixture,
      stage: "Complete",
      branch: "default",
      retired: true,
    },
  };
  it("disables a lender claim when no tracked entitlement remains", () =>
    expect(actionGuard("claim", config, closed, "lender")).toContain("claim"));
  it("does not mistake unsolicited escrow tokens for a lender entitlement", () =>
    expect(
      actionGuard(
        "claim",
        config,
        {
          ...closed,
          market: { ...closed.market!, escrow_balance_units: "999000000" },
        },
        "lender",
      ),
    ).toContain("claim"));
  it("permits the actual repaid lender claim", () =>
    expect(
      actionGuard(
        "claim",
        config,
        {
          ...closed,
          market: { ...closed.market!, lender_claim_units: "101000000" },
        },
        "lender",
      ),
    ).toBeNull());
  it("disables recovery after authenticated terminal closure", () =>
    expect(actionGuard("recover", config, closed, "borrower")).toContain(
      "retired",
    ));
  it("disables maturity controls after the loan closes", () =>
    expect(actionGuard("advance-maturity", config, closed, "lender")).toContain(
      "active",
    ));
});

describe("offer liquidity can be restored independently of ETH", () => {
  const withdrawn: State = {
    ...state,
    market: {
      ...state.market!,
      phase: "Offered",
      available_liquidity_units: "0",
      proof_fresh: false,
    },
  };
  it("exposes lender re-funding after unused CREDIT withdrawal while ETH stays funded", () =>
    expect(offeredAction(withdrawn, "lender")).toBe("fund"));
  it("keeps lender funding visible even after a fresh collateral proof", () =>
    expect(
      offeredAction(
        { ...withdrawn, market: { ...withdrawn.market!, proof_fresh: true } },
        "lender",
      ),
    ).toBe("fund"));
  it("returns a re-funded offer to borrower proof and borrowing", () => {
    const funded = {
      ...withdrawn,
      market: { ...withdrawn.market!, available_liquidity_units: "100000000" },
    };
    expect(offeredAction(funded, "borrower")).toBe("prove");
    expect(
      offeredAction(
        { ...funded, market: { ...funded.market!, proof_fresh: true } },
        "borrower",
      ),
    ).toBe("borrow");
  });
});

describe("financial collateral routing", () => {
  function offered(
    balance: string,
    proofBalance = balance,
    fresh = true,
  ): State {
    return {
      ...state,
      market: {
        ...state.market!,
        phase: "Offered",
        borrowed_at: null,
        proof_fresh: fresh,
      },
      ethereum: { ...state.ethereum!, vaultBalanceWei: balance },
      evidence: { balance_wei: proofBalance },
    };
  }
  for (const balance of ["1", "50000000000000000", "112599999999999999"])
    it(`keeps funding reachable for ${balance} wei and blocks borrowing`, () => {
      const s = offered(balance);
      expect(offeredAction(s, "borrower")).toBe("fund");
      expect(actionGuard("borrow", config, s, "borrower")).toContain(
        "collateral",
      );
    });
  for (const balance of ["112600000000000000", "112600000000000001"])
    it(`permits financially sufficient authenticated ${balance} wei`, () => {
      const s = offered(balance);
      expect(offeredAction(s, "borrower")).toBe("borrow");
      expect(actionGuard("borrow", config, s, "borrower")).toBeNull();
    });
  it("requires new authentication after a topup when the old fresh proof was inadequate", () => {
    const s = offered("120000000000000000", "1");
    expect(offeredAction(s, "borrower")).toBe("prove");
    expect(actionGuard("borrow", config, s, "borrower")).toContain("proof");
  });
  for (const bad of ["-1", "oops", "340282366920938463463374607431768211456"])
    it(`safely blocks malformed or out-of-range collateral ${bad}`, () => {
      expect(actionGuard("borrow", config, offered(bad), "borrower")).toContain(
        "collateral",
      );
    });
});

it("a public lender whose CREDIT side is funded is directed to the borrower ETH side", () => {
  const s = {
    ...state,
    market: { ...state.market!, phase: "Offered" as const },
    ethereum: { ...state.ethereum!, vaultBalanceWei: "1" },
  };
  expect(
    actionGuard("fund", { ...config, mode: "public" }, s, "lender", {
      nearAccount: "lender.test",
    }),
  ).toContain("Switch to the borrower");
});

it.each(["0", "1", "999999"])(
  "keeps the public fee endowment repair reachable with funded liquidity and %s borrower units",
  (balance) => {
    const s: State = {
      ...state,
      market: {
        ...state.market!,
        phase: "Offered",
        borrower_balance_units: balance,
      },
    };
    expect(
      actionGuard("fund", { ...config, mode: "public" }, s, "lender", {
        nearAccount: "lender.test",
      }),
    ).toBeNull();
    expect(offeredAction(s, "lender", "public")).toBe("fund");
  },
);

it("keeps local offer routing unchanged by the public fee endowment repair", () => {
  const s: State = {
    ...state,
    market: { ...state.market!, phase: "Offered", borrower_balance_units: "1" },
  };
  expect(offeredAction(s, "lender", "local")).toBe("borrow");
});

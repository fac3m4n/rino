import { afterEach, expect, it, vi } from "vitest";
import { LocalCoordinator } from "../src/local.ts";
import { stateFixture } from "../../../apps/web/tests/fixtures.ts";
import { SerialQueue } from "../src/safety.ts";
afterEach(() => vi.unstubAllGlobals());
for (const [balance, expected] of [
  [1n, 119999999999999999n],
  [50000000000000000n, 70000000000000000n],
  [112600000000000000n, 0n],
  [120000000000000000n, 0n],
])
  it(`local fund tops up ${balance} wei by the exact shortfall ${expected}`, async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ result: `0x${balance.toString(16)}` })),
    );
    const deposits: bigint[] = [];
    const context = {
      queue: new SerialQueue(4),
      journal: { data: { receipts: [] } },
      manifest: {
        anvilUrl: "http://127.0.0.1:8545",
        vault: stateFixture.market!.vault,
      },
      view: async () => ({
        ...stateFixture.market!,
        phase: "Offered",
        borrower_balance_units: "1000000",
      }),
      fundEth: async (value: bigint) => {
        deposits.push(value);
      },
      state: async () => stateFixture,
    };
    await LocalCoordinator.prototype.action.call(context as never, {
      action: "fund",
      role: "lender",
    });
    expect(deposits).toEqual(expected ? [expected] : []);
  });

import {
  collateralSufficient,
  collateralShortfall,
} from "../src/collateral.ts";
it("uses principal rather than debt and rejects checked arithmetic overflow", () => {
  const terms = stateFixture.market!.terms;
  expect(collateralSufficient(terms, "112600000000000000")).toBe(true);
  expect(collateralSufficient(terms, "112599999999999999")).toBe(false);
  expect(
    collateralSufficient(
      {
        ...terms,
        reference_units_per_eth: "340282366920938463463374607431768211455",
      },
      "120000000000000000",
    ),
  ).toBe(false);
  expect(() => collateralShortfall(terms, "not-an-amount")).toThrow();
  expect(
    collateralSufficient(
      { ...terms, max_ltv_bps: "10001" },
      "120000000000000000",
    ),
  ).toBe(false);
});

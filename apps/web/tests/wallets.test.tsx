import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { useWallets } from "../src/wallets";
import { configFixture } from "./fixtures";
import { installFundingProvider } from "./wallet-fixtures";
function wallet() {
  let result!: ReturnType<typeof useWallets>;
  function Capture() {
    result = useWallets();
    return null;
  }
  renderToString(createElement(Capture));
  return result;
}
const config = {
  ...configFixture,
  mode: "public" as const,
  ethereum: { ...configFixture.ethereum, rpcUrl: null },
};
const vault = "0x1234567890123456789012345678901234567890";
function fixture(mode: string) {
  const provider = installFundingProvider(mode);
  vi.stubGlobal("window", { ethereum: provider });
  return (
    globalThis as unknown as {
      walletFixture: {
        sends: number;
        original: string;
        replacement: string;
        requests: string[];
        sentValue: string;
      };
    }
  ).walletFixture;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("accepted funding with a missing receipt retains hash and pauses rather than declaring failure", async () => {
  vi.useFakeTimers();
  const f = fixture("timeout");
  const result = wallet()
    .fundEvm(config, vault, 120000000000000000n)
    .catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(120001);
  expect(await result).toMatchObject({
    uncertainMutation: true,
    knownHashes: [f.original],
  });
  expect(f.sends).toBe(1);
});
it("a successful self cancellation is not reported as funding", async () => {
  const f = fixture("cancel");
  await expect(
    wallet().fundEvm(config, vault, 120000000000000000n),
  ).rejects.toMatchObject({ uncertainMutation: false, outcome: "cancelled" });
  expect(f.requests).toContain("eth_getBlockByNumber");
  expect(f.sends).toBe(1);
});
it("an equivalent speedup returns the actual included payment hash", async () => {
  const f = fixture("speedup");
  expect(await wallet().fundEvm(config, vault, 120000000000000000n)).toBe(
    f.replacement,
  );
  expect(f.requests).toContain("eth_getBlockByNumber");
});
it("a pre-acceptance user rejection is definitive", async () => {
  fixture("reject");
  await expect(
    wallet().fundEvm(config, vault, 120000000000000000n),
  ).rejects.toMatchObject({
    uncertainMutation: false,
    outcome: "rejected",
    knownHashes: [],
  });
});
it("a confirmed reverted payment is definitive", async () => {
  fixture("revert");
  await expect(
    wallet().fundEvm(config, vault, 120000000000000000n),
  ).rejects.toMatchObject({ uncertainMutation: false, outcome: "failed" });
});

const nearFixture = vi.hoisted(() => ({
  account: "borrower.test",
  calls: 0,
  results: [] as unknown[],
}));
vi.mock("@hot-labs/near-connect", () => ({
  NearConnector: class {
    on() {}
    async wallet() {
      return {
        getAccounts: async () => [{ accountId: nearFixture.account }],
        signAndSendTransaction: async () => {
          const result = nearFixture.results[nearFixture.calls++];
          if (result instanceof Error) throw result;
          return result;
        },
      };
    }
  },
}));
const nearConfig = {
  ...config,
  near: { ...config.near, networkId: "testnet" as const },
};
const nearAction = {
  chain: "near" as const,
  receiverId: "controller.test",
  methodName: "borrow",
  args: {},
  gas: "100000000000000",
  deposit: "1",
};
it("freshly checks the exact signer before any NEAR wallet submission", async () => {
  nearFixture.calls = 0;
  nearFixture.account = "lender.test";
  try {
    await expect(
      wallet().sendNear(nearConfig, [nearAction], "borrower.test"),
    ).rejects.toThrow("Connect borrower.test before signing.");
    expect(nearFixture.calls).toBe(0);
  } finally {
    nearFixture.account = "borrower.test";
  }
});
it("prevalidates every NEAR action before any wallet submission", async () => {
  nearFixture.calls = 0;
  nearFixture.results = [
    {
      status: { SuccessValue: "" },
      transaction: { hash: "confirmed-one" },
      receipts_outcome: [],
    },
  ];
  await expect(
    wallet().sendNear(
      nearConfig,
      [nearAction, { ...nearAction, receiverId: "stranger.test" }],
      "borrower.test",
    ),
  ).rejects.toThrow("destination");
  expect(nearFixture.calls).toBe(0);
});
it("NEAR submission ambiguity is paused even when no transaction hash was returned", async () => {
  nearFixture.calls = 0;
  nearFixture.results = [new Error("connection lost after acceptance")];
  await expect(
    wallet().sendNear(nearConfig, [nearAction], "borrower.test"),
  ).rejects.toMatchObject({
    uncertainMutation: true,
    outcome: "unknown",
    knownHashes: [],
  });
});
it("a later NEAR rejection preserves confirmed earlier effects and hashes", async () => {
  nearFixture.calls = 0;
  nearFixture.results = [
    {
      status: { SuccessValue: "" },
      transaction: { hash: "confirmed-one" },
      receipts_outcome: [],
    },
    Object.assign(new Error("Rejected"), { code: 4001 }),
  ];
  await expect(
    wallet().sendNear(nearConfig, [nearAction, nearAction], "borrower.test"),
  ).rejects.toMatchObject({
    uncertainMutation: true,
    outcome: "partial",
    knownHashes: ["confirmed-one"],
  });
});

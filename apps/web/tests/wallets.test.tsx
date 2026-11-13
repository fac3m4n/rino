import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  manifestId: "generic-wallet",
  accounts: ["borrower.test"],
  selected: ["borrower.test"],
  selectionError: undefined as Error | undefined,
  calls: 0,
  reads: [] as unknown[],
  confirmations: [] as unknown[],
  submissions: [] as unknown[],
  results: [] as unknown[],
}));
vi.mock("@hot-labs/near-connect", () => ({
  NearConnector: class {
    on() {}
    async wallet() {
      return {
        manifest: { id: nearFixture.manifestId },
        getAccounts: async (params: unknown) => {
          nearFixture.reads.push(params);
          return nearFixture.accounts.map((accountId) => ({
            accountId,
            publicKey: "fixture-only",
          }));
        },
        signIn: async (params: unknown) => {
          nearFixture.confirmations.push(params);
          if (nearFixture.selectionError) throw nearFixture.selectionError;
          return nearFixture.selected.map((accountId) => ({
            accountId,
            publicKey: "fixture-only",
          }));
        },
        signAndSendTransaction: async (params: unknown) => {
          nearFixture.submissions.push(params);
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
const nearSuccess = {
  status: { SuccessValue: "" },
  transaction: { hash: "confirmed-one", signer_id: "borrower.test" },
  receipts_outcome: [],
};
beforeEach(() => {
  nearFixture.manifestId = "generic-wallet";
  nearFixture.accounts = ["borrower.test"];
  nearFixture.selected = ["borrower.test"];
  nearFixture.selectionError = undefined;
  nearFixture.calls = 0;
  nearFixture.reads = [];
  nearFixture.confirmations = [];
  nearFixture.submissions = [];
  nearFixture.results = [nearSuccess];
});
it("freshly checks the exact signer before any NEAR wallet submission", async () => {
  nearFixture.accounts = ["lender.test"];
  const error = await wallet()
    .sendNear(nearConfig, [nearAction], "borrower.test")
    .catch((e: unknown) => e);
  expect(error).toHaveProperty(
    "message",
    expect.stringContaining("borrower.test"),
  );
  expect(error).toHaveProperty(
    "message",
    expect.stringContaining("lender.test"),
  );
  expect(nearFixture.calls).toBe(0);
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
  expect(nearFixture.reads).toEqual([]);
  expect(nearFixture.confirmations).toEqual([]);
});

it("Meteor confirms the second imported borrower on testnet without requesting a key", async () => {
  nearFixture.manifestId = "meteor-wallet";
  nearFixture.accounts = ["lender.test", "borrower.test"];
  await wallet().sendNear(nearConfig, [nearAction], "borrower.test");
  expect(nearFixture.reads).toEqual([{ network: "testnet" }]);
  expect(nearFixture.confirmations).toEqual([{ network: "testnet" }]);
  expect(nearFixture.submissions).toEqual([
    {
      network: "testnet",
      signerId: "borrower.test",
      receiverId: "controller.test",
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "borrow",
            args: {},
            gas: "100000000000000",
            deposit: "1",
          },
        },
      ],
    },
  ]);
});

it("Meteor refuses an imported borrower when confirmation selects the lender", async () => {
  nearFixture.manifestId = "meteor-wallet";
  nearFixture.accounts = ["borrower.test", "lender.test"];
  nearFixture.selected = ["lender.test"];
  const error = await wallet()
    .sendNear(nearConfig, [nearAction], "borrower.test")
    .catch((e: unknown) => e);
  expect(error).toMatchObject({
    uncertainMutation: false,
    stage: "before-submission",
    knownHashes: [],
  });
  expect(error).toHaveProperty(
    "message",
    expect.stringContaining("borrower.test"),
  );
  expect(error).toHaveProperty(
    "message",
    expect.stringContaining("lender.test"),
  );
  expect(nearFixture.calls).toBe(0);
});

for (const accounts of [[], ["borrower.test.other"], ["lender.test"]])
  it(`Meteor requires exact fresh account membership before confirmation (${accounts.join(",") || "none"})`, async () => {
    nearFixture.manifestId = "meteor-wallet";
    nearFixture.accounts = accounts;
    const error = await wallet()
      .sendNear(nearConfig, [nearAction], "borrower.test")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      uncertainMutation: false,
      stage: "before-submission",
      knownHashes: [],
    });
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining("borrower.test"),
    );
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining(accounts.join(", ") || "none"),
    );
    expect(nearFixture.confirmations).toEqual([]);
    expect(nearFixture.calls).toBe(0);
  });

for (const selected of [[], ["borrower.test", "lender.test"]])
  it(`Meteor requires exactly one confirmed signer (${selected.length} returned)`, async () => {
    nearFixture.manifestId = "meteor-wallet";
    nearFixture.selected = selected;
    await expect(
      wallet().sendNear(nearConfig, [nearAction], "borrower.test"),
    ).rejects.toMatchObject({
      uncertainMutation: false,
      stage: "before-submission",
      knownHashes: [],
      message: expect.stringContaining(selected.join(", ") || "none"),
    });
    expect(nearFixture.confirmations).toEqual([{ network: "testnet" }]);
    expect(nearFixture.calls).toBe(0);
  });

it("cancelled Meteor account confirmation is definitive and never starts financial signing", async () => {
  nearFixture.manifestId = "meteor-wallet";
  nearFixture.selectionError = Object.assign(new Error("Rejected"), {
    code: 4001,
  });
  await expect(
    wallet().sendNear(nearConfig, [nearAction], "borrower.test"),
  ).rejects.toMatchObject({
    uncertainMutation: false,
    outcome: "rejected",
    stage: "before-submission",
    knownHashes: [],
    message: expect.stringContaining("borrower.test"),
  });
  expect(nearFixture.calls).toBe(0);
});

for (const signer of ["lender.test", undefined])
  it(`Meteor preserves the hash and stops the batch for ${signer ?? "missing"} returned signer`, async () => {
    nearFixture.manifestId = "meteor-wallet";
    nearFixture.results = [
      {
        ...nearSuccess,
        transaction: { hash: "mismatched-signer-hash", signer_id: signer },
      },
      nearSuccess,
    ];
    await expect(
      wallet().sendNear(nearConfig, [nearAction, nearAction], "borrower.test"),
    ).rejects.toMatchObject({
      uncertainMutation: true,
      outcome: "unknown",
      stage: "confirmation",
      knownHashes: ["mismatched-signer-hash"],
      message: expect.stringContaining("borrower.test"),
    });
    expect(nearFixture.calls).toBe(1);
  });

it("generic wallets accept second-position exact membership and receive the explicit signer without Meteor confirmation", async () => {
  nearFixture.accounts = ["lender.test", "borrower.test"];
  await wallet().sendNear(nearConfig, [nearAction], "borrower.test");
  expect(nearFixture.reads).toEqual([{ network: "testnet" }]);
  expect(nearFixture.confirmations).toEqual([]);
  expect(nearFixture.submissions).toEqual([
    expect.objectContaining({ network: "testnet", signerId: "borrower.test" }),
  ]);
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

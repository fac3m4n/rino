/** Real operation client and wallet batch; only SDK and HTTP are controlled. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { OperationClient } from "../src/operation-client";
import { useWallets } from "../src/wallets";
import { configFixture, operationFixture } from "./fixtures";
const sdk = vi.hoisted(() => ({
  sends: [] as unknown[],
  first: undefined as Promise<unknown> | undefined,
}));
vi.mock("@hot-labs/near-connect", () => ({
  NearConnector: class {
    on() {}
    async wallet() {
      return {
        manifest: { id: "controlled-sdk" },
        getAccounts: async () => [
          { accountId: "borrower.test", publicKey: "ed25519:fixture" },
        ],
        signAndSendTransaction: async (request: unknown) => {
          sdk.sends.push(request);
          return sdk.sends.length === 1 && sdk.first ? sdk.first : success;
        },
      };
    }
  },
}));
const hash = "11111111111111111111111111111111";
const success = {
  status: { SuccessValue: "" },
  transaction: { hash, signer_id: "borrower.test" },
  receipts_outcome: [],
};
const config = {
  ...configFixture,
  mode: "public" as const,
  capabilities: { operations: true as const },
  near: { ...configFixture.near, networkId: "testnet" as const },
};
const op = {
  ...operationFixture,
  steps: [
    operationFixture.steps[0],
    { ...operationFixture.steps[0], index: 1 },
  ],
};
const actions = ["request_proof", "borrow"].map((methodName) => ({
  chain: "near" as const,
  receiverId: config.near.controllerId,
  methodName,
  args: {},
  gas: "100000000000000",
  deposit: "0",
}));
function wallet() {
  let result!: ReturnType<typeof useWallets>;
  function Capture() {
    result = useWallets();
    return null;
  }
  renderToString(createElement(Capture));
  return result;
}
beforeEach(() => {
  vi.useFakeTimers();
  sdk.sends = [];
  sdk.first = undefined;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

for (const boundary of ["deadline", "dispose"] as const) {
  it(`does not start step two when the real first wallet result arrives after ${boundary}, while retaining its original hash`, async () => {
    let finish!: (value: typeof success) => void;
    sdk.first = new Promise((resolve) => {
      finish = resolve;
    });
    const observations: { step: number; event: string; hash?: string }[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      observations.push(JSON.parse(String(init.body)));
      return Response.json(op);
    });
    const client = new OperationClient(config, () => {});
    const result = client
      .wallet(op, (progress) =>
        wallet().sendNear(config, actions, config.near.borrowerId, progress),
      )
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk.sends).toHaveLength(1);
    if (boundary === "deadline") await vi.advanceTimersByTimeAsync(180000);
    else client.dispose();
    finish(success);
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk.sends).toHaveLength(1);
    expect(observations).toContainEqual({ step: 0, event: "hash", hash });
    expect(
      observations.some(
        (observation) =>
          observation.step === 1 && observation.event === "submission-started",
      ),
    ).toBe(false);
    await result;
  });

  it(`does not launch the first real wallet call when its initial acknowledgement completes after ${boundary}`, async () => {
    // Every individual metadata request remains below the 15s transport bound.
    // A real per-operation queue can still outlive the 180s wallet observation.
    vi.stubGlobal("fetch", async () => {
      await new Promise((resolve) => setTimeout(resolve, 14000));
      return Response.json(op);
    });
    const client = new OperationClient(config, () => {});
    const queued =
      boundary === "deadline"
        ? Array.from({ length: 14 }, () =>
            client.observe(op, { step: 0, event: "wallet-unknown" }),
          )
        : [];
    const result = client
      .wallet(op, (progress) =>
        wallet().sendNear(
          config,
          [actions[0]],
          config.near.borrowerId,
          progress,
        ),
      )
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(sdk.sends).toHaveLength(0);
    if (boundary === "deadline") await vi.advanceTimersByTimeAsync(180000);
    else client.dispose();
    await vi.advanceTimersByTimeAsync(40000);
    await Promise.all(queued);
    expect(sdk.sends).toHaveLength(0);
    await result;
  });
}

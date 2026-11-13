import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.ts";
import { OperationJournal } from "../src/operations.ts";
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
it("exposes persisted public operations and receipts without reading a provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "operation-routes-"));
  directories.push(dir);
  const journal = await OperationJournal.open(join(dir, "operations.json"), {
    controllerId: "controller.testnet",
  });
  await journal.start({
    id: "12345678-1234-4234-8234-123456789abc",
    action: "prove",
    role: "borrower",
  });
  const engine = {
    deployment: { controllerId: "controller.testnet" },
    operations: {
      list: () => journal.list(),
      receipts: () => journal.receipts(),
    },
    readiness: () => {
      throw Error("GET must not read readiness");
    },
  };
  const app = await createApp({
    publicEngine: engine as never,
    origin: "http://127.0.0.1:3002",
  });
  try {
    const result = await app.inject({
      url: "/api/operations",
      headers: { host: "127.0.0.1:3002" },
    });
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toContain("application/json");
    expect(result.json()).toMatchObject([
      { action: "prove", stage: "preparing" },
    ]);
    expect(
      (
        await app.inject({
          url: "/api/receipts",
          headers: { host: "127.0.0.1:3002" },
        })
      ).json(),
    ).toEqual([]);
  } finally {
    await app.close();
  }
});

import { PublicOperations } from "../src/public-operations.ts";
import { ReceiptVerifier } from "../src/receipt-verifier.ts";
import { JsonRpcProvider } from "near-api-js";
import type { State } from "../src/api.ts";
it("guards every metadata write and persists acknowledgements before the next wallet action", async () => {
  const dir = await mkdtemp(join(tmpdir(), "operation-route-post-"));
  directories.push(dir);
  const journal = await OperationJournal.open(join(dir, "operations.json"), {
    controllerId: "controller.testnet",
  });
  let rpc = 0;
  const provider = new JsonRpcProvider({ url: "https://unused.invalid" });
  provider.sendJsonRpc = async () => {
    rpc++;
    throw Error("credential=https://private.invalid");
  };
  const service = new PublicOperations({
    journal,
    binding: {
      controllerId: "controller.testnet",
      borrowerId: "borrower.testnet",
      lenderId: "lender.testnet",
    },
    verifier: new ReceiptVerifier({
      near: provider,
      ethereum: async () => {
        rpc++;
        throw Error("unexpected");
      },
    }),
    readiness: async () => [],
    state: async () =>
      ({
        ready: true,
        busy: false,
        settlement: { pending: null },
        proofStatus: "Idle",
      }) as State,
    prepare: async () => ({
      steps: [
        {
          chain: "near",
          signerId: "borrower.testnet",
          minimumBlock: "100",
          action: {
            chain: "near",
            receiverId: "controller.testnet",
            methodName: "borrow",
            args: {},
            gas: "300000000000000",
            deposit: "1",
          },
        },
      ],
    }),
  });
  const app = await createApp({
    origin: "http://127.0.0.1:3002",
    publicEngine: {
      deployment: { controllerId: "controller.testnet" },
      operations: service,
      readiness: async () => [],
    } as never,
  });
  try {
    const host = { host: "127.0.0.1:3002" };
    const config = (
      await app.inject({ url: "/api/config", headers: host })
    ).json();
    expect(config.capabilities).toEqual({ operations: true });
    const headers = {
      ...host,
      origin: "http://127.0.0.1:3002",
      "content-type": "application/json",
      "x-proofcredit-csrf": config.csrfToken,
    };
    const id = "12345678-1234-4234-8234-123456789abc",
      payload = { id, action: "borrow", role: "borrower" };
    const post = (url: string, body: unknown, custom = headers) =>
      app.inject({
        method: "POST",
        url,
        headers: custom,
        payload: JSON.stringify(body),
      });
    expect(
      (
        await post("/api/operations", payload, {
          ...headers,
          "x-proofcredit-csrf": "wrong",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await post("/api/operations", { ...payload, amount: "1" })).statusCode,
    ).toBe(400);
    expect(journal.list()).toEqual([]);
    const created = await post("/api/operations", payload);
    expect(created.statusCode).toBe(200);
    expect(created.json().operation.stage).toBe("awaiting-wallet");
    for (const path of [
      `/api/operations/${id}/observe`,
      `/api/operations/${id}/reconcile`,
      `/api/operations/${id}/continue`,
      "/api/operations/import",
    ]) {
      expect(
        (await post(path, {}, { ...headers, "x-proofcredit-csrf": "wrong" }))
          .statusCode,
      ).toBe(400);
      expect((await post(path, { extra: true })).statusCode).toBe(400);
    }
    expect(
      (
        await post(`/api/operations/${id}/observe`, {
          step: 0,
          event: "submission-started",
        })
      ).json(),
    ).toMatchObject({ steps: [{ started: true, status: "needs-check" }] });
    expect((await post("/api/operations", payload)).json()).not.toHaveProperty(
      "walletActions",
    );
    const observed = await post(`/api/operations/${id}/observe`, {
      step: 0,
      event: "hash",
      hash: "11111111111111111111111111111111",
    });
    expect(observed.json()).toMatchObject({ unresolved: true });
    expect(rpc).toBe(1);
    const count = rpc;
    await app.inject({ url: "/api/operations", headers: host });
    await app.inject({ url: "/api/receipts", headers: host });
    expect(rpc).toBe(count);
    const failed = await post(`/api/operations/${id}/observe`, {
      step: 1,
      event: "hash",
      hash: "11111111111111111111111111111111",
    });
    expect(failed.statusCode).toBe(400);
    expect(failed.body).not.toContain("private.invalid");
    expect(
      (await post(`/api/operations/${id}/continue`, {})).json(),
    ).toMatchObject({ continued: true, unresolved: true });
    expect(
      (await post(`/api/operations/${id}/reconcile`, { unexpected: true }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/operations",
          headers,
          payload: " ".repeat(2049),
        })
      ).statusCode,
    ).toBe(413);
    expect(
      (await post("/api/operations/INVALID/reconcile", {})).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});
it("keeps operation capability absent without an initialized public service", async () => {
  const app = await createApp({ origin: "http://127.0.0.1:3002" });
  try {
    const headers = { host: "127.0.0.1:3002" };
    const config = (await app.inject({ url: "/api/config", headers })).json();
    expect(config).not.toHaveProperty("capabilities");
    const result = await app.inject({ url: "/api/operations", headers });
    expect(result.json()).toEqual([]);
  } finally {
    await app.close();
  }
});

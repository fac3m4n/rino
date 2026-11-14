import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/server.ts";
import { readMarketDefinitions } from "../src/markets.ts";
import { PublicOperations } from "../src/public-operations.ts";
import { OperationJournal } from "../src/operations.ts";
import { ReceiptVerifier } from "../src/receipt-verifier.ts";
import { JsonRpcProvider } from "near-api-js";
import type { State } from "../src/api.ts";
import type { PublicCoordinator } from "../src/public.ts";
import type { LocalCoordinator } from "../src/local.ts";
const origin = "http://127.0.0.1:3002",
  host = { host: "127.0.0.1:3002" };
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function engine(controllerId: string) {
  const dir = await mkdtemp(join(tmpdir(), "rino-market-routes-"));
  dirs.push(dir);
  const journal = await OperationJournal.open(join(dir, "operations.json"), {
    controllerId,
  });
  const state = {
    apiVersion: 1,
    ready: true,
    market: null,
    settlement: null,
    proofStatus: "Idle",
    evidence: { controllerId },
    ethereum: null,
    totalSupplyUnits: null,
    nearTimeSeconds: "1",
    busy: false,
    pendingReason: "",
  } satisfies State;
  const service = new PublicOperations({
    journal,
    binding: {
      controllerId,
      borrowerId: "borrower.testnet",
      lenderId: "lender.testnet",
    },
    verifier: new ReceiptVerifier({
      near: new JsonRpcProvider({ url: "https://unused.invalid" }),
      ethereum: async () => {
        throw Error("unexpected network request");
      },
    }),
    readiness: async () => [],
    state: async () => state,
    prepare: async () => ({
      steps: [
        {
          chain: "near" as const,
          signerId: "borrower.testnet",
          minimumBlock: "1",
          action: {
            chain: "near" as const,
            receiverId: controllerId,
            methodName: "borrow",
            args: {},
            gas: "300000000000000",
            deposit: "1",
          },
        },
      ],
    }),
  });
  const action = vi.fn(async () => ({
    ok: true,
    message: controllerId,
    state,
    receiptIds: [],
  }));
  const adapter = {
    deployment: {
      controllerId,
      borrowerId: "borrower.testnet",
      lenderId: "lender.testnet",
    },
    operations: service,
    readiness: async () => [],
    state: async () => state,
    action,
  } as unknown as PublicCoordinator;
  return { adapter, action, journal };
}
const csrf = (token: string) => ({
  ...host,
  origin,
  "content-type": "application/json",
  "x-rino-csrf": token,
});
it("catalog exposes only operator-owned routes and default legacy market", async () => {
  const a = await engine("alpha.testnet"),
    b = await engine("beta.testnet");
  const app = await createApp({
    origin,
    publicEngine: a.adapter,
    markets: [{ id: "reserve", name: "Reserve ETH", publicEngine: b.adapter }],
  } as Parameters<typeof createApp>[0]);
  try {
    const result = await app.inject({ url: "/api/markets", headers: host });
    expect(result.statusCode).toBe(200);
    expect(result.headers["content-type"]).toContain("application/json");
    expect(result.json()).toEqual({
      apiVersion: 1,
      markets: [
        {
          id: "primary",
          name: "ETH market",
          apiBase: "/api",
          controllerId: "alpha.testnet",
          networkId: "testnet",
        },
        {
          id: "reserve",
          name: "Reserve ETH",
          apiBase: "/api/markets/reserve",
          controllerId: "beta.testnet",
          networkId: "testnet",
        },
      ],
    });
    expect(JSON.stringify(result.json())).not.toMatch(
      /csrf|manifest|secret|private|signer/,
    );
  } finally {
    await app.close();
  }
});
it("scoped reads and actions bind distinct engines and per-market CSRF tokens", async () => {
  const a = await engine("alpha.testnet"),
    b = await engine("beta.testnet");
  const app = await createApp({
    origin,
    publicEngine: a.adapter,
    markets: [{ id: "reserve", name: "Reserve", publicEngine: b.adapter }],
  } as Parameters<typeof createApp>[0]);
  try {
    const config = (
      await app.inject({ url: "/api/config", headers: host })
    ).json();
    const reserveResponse = await app.inject({
      url: "/api/markets/reserve/config",
      headers: host,
    });
    expect(reserveResponse.headers["content-type"]).toContain(
      "application/json",
    );
    const reserve = reserveResponse.json();
    expect(reserve.near.controllerId).toBe("beta.testnet");
    expect(reserve.csrfToken).not.toBe(config.csrfToken);
    expect(
      (
        await app.inject({ url: "/api/markets/reserve/state", headers: host })
      ).json().evidence,
    ).toEqual({ controllerId: "beta.testnet" });
    const payload = { action: "borrow", role: "borrower" };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/markets/reserve/actions",
          headers: csrf(config.csrfToken),
          payload,
        })
      ).statusCode,
    ).toBe(400);
    expect(a.action).not.toHaveBeenCalled();
    expect(b.action).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/markets/reserve/actions",
          headers: csrf(reserve.csrfToken),
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(b.action).toHaveBeenCalledExactlyOnceWith(payload);
    expect(a.action).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/actions",
          headers: csrf(config.csrfToken),
          payload,
        })
      ).statusCode,
    ).toBe(200);
    expect(a.action).toHaveBeenCalledExactlyOnceWith(payload);
    for (const headers of [
      { ...csrf(reserve.csrfToken), origin: "https://evil.invalid" },
      { ...csrf(reserve.csrfToken), host: "evil.invalid:3002" },
    ])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/markets/reserve/actions",
            headers,
            payload,
          })
        ).statusCode,
      ).toBe(403);
  } finally {
    await app.close();
  }
});
it("recovery and receipts stay in the selected controller journal", async () => {
  const a = await engine("alpha.testnet"),
    b = await engine("beta.testnet");
  const id = "12345678-1234-4234-8234-123456789abc";
  const app = await createApp({
    origin,
    publicEngine: a.adapter,
    markets: [{ id: "reserve", name: "Reserve", publicEngine: b.adapter }],
  } as Parameters<typeof createApp>[0]);
  try {
    const ca = (await app.inject({ url: "/api/config", headers: host })).json();
    const cbResponse = await app.inject({
      url: "/api/markets/reserve/config",
      headers: host,
    });
    expect(cbResponse.headers["content-type"]).toContain("application/json");
    const cb = cbResponse.json();
    const created = await app.inject({
      method: "POST",
      url: "/api/operations",
      headers: csrf(ca.csrfToken),
      payload: { id, action: "borrow", role: "borrower" },
    });
    expect(created.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          url: "/api/markets/reserve/operations",
          headers: host,
        })
      ).json(),
    ).toEqual([]);
    expect(
      (
        await app.inject({
          url: "/api/markets/reserve/receipts",
          headers: host,
        })
      ).json(),
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/markets/reserve/operations/${id}/observe`,
          headers: csrf(cb.csrfToken),
          payload: { step: 0, event: "submission-started" },
        })
      ).statusCode,
    ).toBe(400);
    expect(b.journal.list()).toEqual([]);
    expect(a.journal.list()).toMatchObject([
      { controllerId: "alpha.testnet", steps: [{ started: false }] },
    ]);
    // The same UUID is legal in another controller namespace, without observing A.
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/markets/reserve/operations",
          headers: csrf(cb.csrfToken),
          payload: { id, action: "borrow", role: "borrower" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/markets/reserve/operations/${id}/observe`,
          headers: csrf(cb.csrfToken),
          payload: { step: 0, event: "submission-started" },
        })
      ).statusCode,
    ).toBe(200);
    expect(b.journal.list()).toMatchObject([
      { controllerId: "beta.testnet", steps: [{ started: true }] },
    ]);
    expect(a.journal.list()).toMatchObject([
      { controllerId: "alpha.testnet", steps: [{ started: false }] },
    ]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/markets/reserve/operations",
          headers: csrf(cb.csrfToken),
          payload: {
            id,
            action: "borrow",
            role: "borrower",
            controllerId: "alpha.testnet",
          },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});
it.each(["missing", "primary", "reserve%2f..%2f.."])(
  "unknown market %s never falls back to default API or landing",
  async (id) => {
    const a = await engine("alpha.testnet"),
      app = await createApp({ origin, publicEngine: a.adapter });
    try {
      const response = await app.inject({
        url: `/api/markets/${id}/state`,
        headers: host,
      });
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(a.action).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);
it("rejects unsafe, duplicate, ambiguous, excessive or mixed-network registry entries", async () => {
  const a = await engine("alpha.testnet"),
    b = await engine("beta.testnet");
  const good = { id: "reserve", name: "Reserve", publicEngine: b.adapter };
  for (const markets of [
    [{ ...good, id: "../actions" }],
    [{ ...good, id: "primary" }],
    [good, good],
    [{ ...good, publicEngine: a.adapter }],
    [{ ...good, name: "\nReserve" }],
    [{ ...good, engine: { manifest: {} } as LocalCoordinator }],
    [
      {
        id: "local",
        name: "Local",
        engine: { manifest: {} } as LocalCoordinator,
      },
    ],
    Array.from({ length: 8 }, (_, i) => ({ ...good, id: `market-${i}` })),
  ]) {
    let rejected = false;
    try {
      const accepted = await createApp({
        origin,
        publicEngine: a.adapter,
        markets,
      } as Parameters<typeof createApp>[0]);
      await accepted.close();
    } catch (error) {
      expect(String(error)).toMatch(/market|controller|network/i);
      rejected = true;
    }
    expect(rejected).toBe(true);
  }
});

it("operator market files resolve relative paths without exposing paths in the catalog", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rino-market-file-"));
  dirs.push(directory);
  const file = join(directory, "markets.json");
  await writeFile(
    file,
    JSON.stringify([
      {
        id: "reserve",
        name: "Reserve",
        manifestPath: "deployments/reserve.json",
      },
    ]),
  );
  expect(await readMarketDefinitions(file, "public")).toEqual([
    {
      id: "reserve",
      name: "Reserve",
      manifestPath: join(directory, "deployments/reserve.json"),
    },
  ]);
  await writeFile(
    file,
    JSON.stringify([
      { id: "reserve", name: "Reserve", sessionPath: "sessions/reserve.json" },
    ]),
  );
  expect(await readMarketDefinitions(file, "local")).toEqual([
    {
      id: "reserve",
      name: "Reserve",
      sessionPath: join(directory, "sessions/reserve.json"),
    },
  ]);
  expect(await readMarketDefinitions(undefined, "public")).toEqual([]);
});
it("operator files reject duplicate namespaced identities before opening engine manifests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rino-market-file-"));
  dirs.push(directory);
  const file = join(directory, "markets.json");
  const entry = { id: "reserve", name: "Reserve", manifestPath: "a.json" };
  for (const raw of [
    [entry, entry],
    [null],
    [true],
    { markets: [entry] },
    [{ ...entry, id: "primary" }],
    [{ ...entry, secret: "should-never-appear" }],
    [{ ...entry, sessionPath: "wrong-mode" }],
    [{ ...entry, manifestPath: "" }],
    [{ ...entry, manifestPath: "path\nline" }],
    Array.from({ length: 8 }, (_, i) => ({ ...entry, id: `reserve-${i}` })),
  ]) {
    await writeFile(file, JSON.stringify(raw));
    await expect(readMarketDefinitions(file, "public")).rejects.toThrow(
      /configured market/i,
    );
  }
  await writeFile(file, " ".repeat(16385));
  await expect(readMarketDefinitions(file, "public")).rejects.toThrow(
    /capacity/,
  );
});

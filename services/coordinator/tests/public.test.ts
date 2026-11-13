import { it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicCoordinator } from "../src/public.ts";
import { REVIEWED_V2_ARTIFACTS as PINS } from "../src/public-artifacts.ts";
import type { State } from "../src/api.ts";
import { createApp } from "../src/server.ts";
beforeEach(() => {
  vi.stubEnv("NEAR_TESTNET_RPC_URL", undefined);
  vi.stubEnv(
    "ALCHEMY_SEPOLIA_RPC_URL",
    "https://eth-sepolia.g.alchemy.com/v2/rino-synthetic-key",
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const deployment = {
  version: 2,
  controllerId: "controller.testnet",
  borrowerId: "borrower.testnet",
  lenderId: "lender.testnet",
  borrowerRecipient: "0x1111111111111111111111111111111111111111",
  lenderRecipient: "0x2222222222222222222222222222222222222222",
  operationDeposit: "7000100000000000000000",
  controllerCodeHash: "11111111111111111111111111111111",
  collateralUrl: "https://published.example/collateral.wasm",
  settlementUrl: "https://published.example/settlement.wasm",
};
async function adapter(extra: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "rino-public-"));
  const p = join(dir, "manifest.json");
  await writeFile(p, JSON.stringify({ ...deployment, ...extra }));
  return PublicCoordinator.fromFile(p);
}
it("sends public NEAR provider queries to the fixed working testnet transport", async () => {
  const a = (await adapter())!;
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    requests.push(String(url));
    const request = JSON.parse(String(init?.body));
    expect(request.method).toBe("status");
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: { chain_id: "testnet" },
      }),
    );
  });
  expect((await a.provider.viewNodeStatus()).chain_id).toBe("testnet");
  expect(requests).toEqual(["https://near-testnet.drpc.org"]);
});
it.each([
  undefined,
  "",
  "https://eth-mainnet.g.alchemy.com/v2/secret-test-key",
  "https://eth-sepolia.g.alchemy.com/v2/bad%20key",
])(
  "rejects absent or invalid runtime credentials before public construction (%s)",
  async (value) => {
    vi.stubEnv("ALCHEMY_SEPOLIA_RPC_URL", value);
    await expect(adapter()).rejects.toThrow("Alchemy");
    await expect(
      PublicCoordinator.fromFile(undefined),
    ).resolves.toBeUndefined();
  },
);
it("keeps local construction and public imports credential-free", async () => {
  vi.stubEnv("ALCHEMY_SEPOLIA_RPC_URL", undefined);
  const { LocalCoordinator } = await import("../src/local.ts");
  expect(LocalCoordinator).toBeDefined();
  await expect(PublicCoordinator.fromFile(undefined)).resolves.toBeUndefined();
});
it("public manifest rejects financial key material and non-testnet identities", async () => {
  await expect(adapter({ signer: "must-never-be-loaded" })).rejects.toThrow(
    "schema",
  );
  await expect(adapter({ borrowerId: "borrower.near" })).rejects.toThrow(
    "testnet",
  );
  await expect(PublicCoordinator.fromFile(undefined)).resolves.toBeUndefined();
});
it("public readiness fails closed on wrong provider network or changed deployed code", async () => {
  vi.useFakeTimers();
  const a = (await adapter())!;
  vi.spyOn(a.provider, "viewNodeStatus").mockResolvedValue({
    chain_id: "testnet",
  } as any);
  vi.spyOn(a.provider, "viewAccount").mockResolvedValue({
    code_hash: deployment.controllerCodeHash,
  } as any);
  vi.spyOn(a, "view").mockImplementation(async (method: string) =>
    method === "get_config"
      ? {
          borrower: deployment.borrowerId,
          executor: "outlayer.testnet",
          mpc: "v1.signer-prod.testnet",
          network: "NearTestnet",
          wasm_url: deployment.collateralUrl,
          wasm_sha256: PINS.collateral,
          operation_deposit: deployment.operationDeposit,
        }
      : {
          lender: deployment.lenderId,
          borrower_recipient: deployment.borrowerRecipient,
          lender_recipient: deployment.lenderRecipient,
          terms: { term_seconds: "86400" },
          settlement_wasm_url: deployment.settlementUrl,
          settlement_wasm_sha256: PINS.settlement,
        },
  );
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xaa36a7" }),
        ),
    );
  expect(await a.readiness()).toEqual([]);
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    "https://ethereum-sepolia-rpc.publicnode.com/",
    "https://eth-sepolia.g.alchemy.com/v2/rino-synthetic-key",
  ]);
  expect(JSON.stringify(a.deployment)).not.toContain("synthetic-key");
  expect(JSON.stringify(a)).not.toContain("synthetic-key");
  fetch.mockImplementation(
    async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" })),
  );
  expect(await a.readiness()).toContain("Wrong public network");
  await vi.advanceTimersByTimeAsync(30000);
  fetch.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xaa36a7" }),
      ),
  );
  vi.mocked(a.provider.viewAccount).mockResolvedValue({
    code_hash: "22222222222222222222222222222222",
  } as any);
  expect((await a.readiness()).join()).toContain("code hash");
});
it("redacts credential-bearing provider exceptions from action and readiness errors", async () => {
  const a = (await adapter())!;
  vi.spyOn(a, "state").mockResolvedValue({
    ready: true,
    market: { vault: "0x3333333333333333333333333333333333333333", terms: {} },
    settlement: {},
  } as unknown as State);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error(
      "transport https://eth-sepolia.g.alchemy.com/v2/rino-synthetic-key",
    ),
  );
  await expect(a.action({ action: "prove", role: "borrower" })).rejects.toThrow(
    "public provider unavailable",
  );
});
it("keeps runtime credentials out of config and unavailable state API responses", async () => {
  const a = (await adapter())!;
  vi.spyOn(a.provider, "viewNodeStatus").mockRejectedValue(
    new Error("https://eth-sepolia.g.alchemy.com/v2/rino-synthetic-key"),
  );
  vi.spyOn(a.provider, "viewAccount").mockRejectedValue(
    new Error("unavailable"),
  );
  vi.spyOn(a, "view").mockRejectedValue(new Error("unavailable"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unavailable"));
  const app = await createApp({
    publicEngine: a,
    origin: "http://127.0.0.1:3000",
  });
  try {
    for (const url of ["/api/config", "/api/state"]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { host: "127.0.0.1:3000" },
      });
      expect(response.json().ready).toBe(false);
      if (url === "/api/config")
        expect(response.json().near.rpcUrl).toBe(
          "https://near-testnet.drpc.org",
        );
      expect(response.body).not.toContain("synthetic-key");
      expect(response.body).not.toContain("alchemy.com");
    }
  } finally {
    await app.close();
  }
});
it("public financial actions require the fixed participant wallet and never send a NEAR transaction", async () => {
  const a = (await adapter())!;
  const fake = {
    market: {
      phase: "Offered",
      borrower: deployment.borrowerId,
      lender: deployment.lenderId,
    },
    settlement: {},
    ready: true,
  } as unknown as State;
  vi.spyOn(a, "state").mockResolvedValue(fake);
  const fetch = vi.spyOn(globalThis, "fetch");
  await expect(a.action({ action: "borrow", role: "lender" })).rejects.toThrow(
    "borrower wallet",
  );
  const result = await a.action({ action: "borrow", role: "borrower" });
  expect(result.walletActions).toEqual([
    {
      chain: "near",
      receiverId: "controller.testnet",
      methodName: "borrow",
      args: {},
      gas: "300000000000000",
      deposit: "1",
    },
  ]);
  expect(fetch).not.toHaveBeenCalled();
  await expect(
    a.action({ action: "advance-maturity", role: "lender" }),
  ).rejects.toThrow("local-only");
});

it.each(["borrower_recipient", "lender_recipient", "operation_deposit"])(
  "public readiness rejects a changed immutable %s",
  async (field) => {
    const a = (await adapter())!;
    const config = {
      borrower: deployment.borrowerId,
      executor: "outlayer.testnet",
      mpc: "v1.signer-prod.testnet",
      network: "NearTestnet",
      wasm_url: deployment.collateralUrl,
      wasm_sha256: PINS.collateral,
      operation_deposit: "7000100000000000000000",
    };
    const market = {
      lender: deployment.lenderId,
      terms: { term_seconds: "86400" },
      borrower_recipient: "0x1111111111111111111111111111111111111111",
      lender_recipient: "0x2222222222222222222222222222222222222222",
      settlement_wasm_url: deployment.settlementUrl,
      settlement_wasm_sha256: PINS.settlement,
    };
    vi.spyOn(a.provider, "viewNodeStatus").mockResolvedValue({
      chain_id: "testnet",
    } as any);
    vi.spyOn(a.provider, "viewAccount").mockResolvedValue({
      code_hash: deployment.controllerCodeHash,
    } as any);
    vi.spyOn(a, "view").mockImplementation(async (method) =>
      method === "get_config" ? config : market,
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ result: "0xaa36a7" })),
    );
    expect(await a.readiness()).toEqual([]);
    if (field === "operation_deposit")
      config.operation_deposit = "7000100000000000000001";
    else
      market[field as "borrower_recipient" | "lender_recipient"] =
        "0x3333333333333333333333333333333333333333";
    expect(await a.readiness()).toContain(
      "Public deployment immutable configuration mismatch",
    );
  },
);

it("requires a complete version 2 public manifest with actionable legacy rejection", async () => {
  await expect(adapter()).resolves.toBeDefined();
  await expect(adapter({ version: 1 })).rejects.toThrow("version 2");
  await expect(
    adapter({
      version: 1,
      borrowerRecipient: undefined,
      lenderRecipient: undefined,
      operationDeposit: undefined,
    }),
  ).rejects.toThrow("version 2");
  await expect(adapter({ borrowerRecipient: undefined })).rejects.toThrow(
    "version 2",
  );
  await expect(adapter({ operationDeposit: undefined })).rejects.toThrow(
    "version 2",
  );
});
it.each([
  "",
  "-1",
  "1.0",
  "01",
  "+1",
  " 1",
  "1e20",
  "50000000000000000000001",
  "340282366920938463463374607431768211456",
  1,
  null,
])(
  "rejects noncanonical or over-cap operation deposit %s",
  async (operationDeposit) => {
    await expect(adapter({ operationDeposit })).rejects.toThrow(
      "operation deposit",
    );
  },
);
it.each(["0", "50000000000000000000000"])(
  "accepts the constructor operation deposit boundary %s",
  async (operationDeposit) => {
    await expect(adapter({ operationDeposit })).resolves.toBeDefined();
  },
);
it.each([
  { borrowerRecipient: "0x1234" },
  { borrowerRecipient: "0x0000000000000000000000000000000000000000" },
  { lenderRecipient: "0xgggggggggggggggggggggggggggggggggggggggg" },
  { lenderRecipient: deployment.borrowerRecipient },
  {
    borrowerRecipient: "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa",
    lenderRecipient: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
])("rejects malformed or equivalent public recipients %j", async (extra) => {
  await expect(adapter(extra)).rejects.toThrow("distinct Sepolia recipients");
});

// These fixtures exercise the real coordinator/cache/API while replacing only chain transports.
async function readableAdapter() {
  const a = (await adapter())!;
  const market = {
    lender: deployment.lenderId,
    borrower_recipient: deployment.borrowerRecipient,
    lender_recipient: deployment.lenderRecipient,
    terms: { term_seconds: "86400" },
    settlement_wasm_url: deployment.settlementUrl,
    settlement_wasm_sha256: PINS.settlement,
    borrower_balance_units: "1000000",
  };
  const status = vi
    .spyOn(a.provider, "viewNodeStatus")
    .mockResolvedValue({ chain_id: "testnet" } as any);
  vi.spyOn(a.provider, "viewAccount").mockResolvedValue({
    code_hash: deployment.controllerCodeHash,
  } as any);
  vi.spyOn(a.provider, "viewBlock").mockResolvedValue({
    header: { timestamp_nanosec: "1000000000" },
  } as any);
  vi.spyOn(a, "view").mockImplementation(async (method) => {
    if (method === "get_config")
      return {
        borrower: deployment.borrowerId,
        executor: "outlayer.testnet",
        mpc: "v1.signer-prod.testnet",
        network: "NearTestnet",
        wasm_url: deployment.collateralUrl,
        wasm_sha256: PINS.collateral,
        operation_deposit: deployment.operationDeposit,
      };
    if (method === "get_market") return { ...market };
    if (method === "get_settlement") return { pending_reason: "" };
    return null;
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(JSON.stringify({ result: "0xaa36a7" })),
  );
  return { a, market, status };
}
it("shares ordinary config/state readiness and caches 15s readiness / 5s state without timers", async () => {
  const { a, status } = await readableAdapter();
  vi.useFakeTimers();
  const app = await createApp({
    publicEngine: a,
    origin: "http://127.0.0.1:3000",
  });
  const get = (url: string) =>
    app.inject({ method: "GET", url, headers: { host: "127.0.0.1:3000" } });
  try {
    await Promise.all([
      get("/api/config"),
      get("/api/state"),
      get("/api/state"),
    ]);
    expect(status).toHaveBeenCalledTimes(1);
    const views = vi.mocked(a.view);
    const nearRequests = () =>
      status.mock.calls.length +
      vi.mocked(a.provider.viewAccount).mock.calls.length +
      vi.mocked(a.provider.viewBlock).mock.calls.length +
      views.mock.calls.length;
    expect(nearRequests()).toBe(10); // Four readiness + six state reads; concurrent consumers share both.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(views.mock.calls.filter(([m]) => m === "get_market")).toHaveLength(
      2,
    );
    await vi.advanceTimersByTimeAsync(4999);
    await get("/api/state");
    expect(views.mock.calls.filter(([m]) => m === "get_market")).toHaveLength(
      2,
    );
    expect(nearRequests()).toBe(10);
    await vi.advanceTimersByTimeAsync(1);
    await get("/api/state");
    expect(nearRequests()).toBe(16);
    expect(views.mock.calls.filter(([m]) => m === "get_market")).toHaveLength(
      3,
    );
    expect(status).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10000);
    await get("/api/config");
    expect(status).toHaveBeenCalledTimes(2);
    expect(nearRequests()).toBe(20);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
  } finally {
    await app.close();
    vi.useRealTimers();
  }
});
it("rejects expired successes and cools concurrent/forced failures for 30s across action invalidation", async () => {
  const { a, status } = await readableAdapter();
  vi.useFakeTimers();
  try {
    await a.state({ fresh: false });
    status.mockRejectedValue(Error("synthetic private transport"));
    await vi.advanceTimersByTimeAsync(15000);
    await expect(a.state({ fresh: false })).rejects.toThrow("unavailable");
    await Promise.all([a.readiness(), a.readiness({ fresh: true })]);
    await expect(
      a.action({ action: "borrow", role: "borrower" }),
    ).rejects.toThrow("unavailable");
    expect(status).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29999);
    await a.readiness();
    expect(status).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await a.readiness();
    expect(status).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});
it("fresh API/direct/action reads observe a changed live market and invalidate display results", async () => {
  const { a, market } = await readableAdapter();
  expect((await a.state({ fresh: false })).market!.borrower_balance_units).toBe(
    "1000000",
  );
  market.borrower_balance_units = "0";
  expect((await a.state({ fresh: false })).market!.borrower_balance_units).toBe(
    "1000000",
  );
  expect((await a.state()).market!.borrower_balance_units).toBe("0");
  market.borrower_balance_units = "2";
  const result = await a.action({ action: "fund", role: "lender" });
  expect(result.walletActions![0].args.amount).toBe("999998");
  market.borrower_balance_units = "3";
  expect((await a.state({ fresh: false })).market!.borrower_balance_units).toBe(
    "3",
  );
  const app = await createApp({
    publicEngine: a,
    origin: "http://127.0.0.1:3000",
  });
  try {
    market.borrower_balance_units = "4";
    const response = await app.inject({
      method: "GET",
      url: "/api/state?fresh=1",
      headers: { host: "127.0.0.1:3000" },
    });
    expect(response.json().market.borrower_balance_units).toBe("4");
  } finally {
    await app.close();
  }
});
it("selects a private runtime NEAR transport without serializing it to provider/config/errors", async () => {
  vi.stubEnv(
    "NEAR_TESTNET_RPC_URL",
    "https://private.example/synthetic-near-key?token=synthetic-token",
  );
  const a = (await adapter())!;
  const urls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    urls.push(String(url));
    const req = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        result: { chain_id: "testnet" },
        id: req.id,
      }),
    );
  });
  expect((await a.provider.viewNodeStatus()).chain_id).toBe("testnet");
  expect(urls).toEqual([
    "https://private.example/synthetic-near-key?token=synthetic-token",
  ]);
  expect(JSON.stringify(a)).not.toContain("synthetic-near-key");
  expect(JSON.stringify(a.provider)).not.toContain("synthetic-near-key");
  vi.mocked(fetch).mockResolvedValue(
    new Response("private synthetic-near-key", { status: 429 }),
  );
  await expect(a.provider.viewNodeStatus()).rejects.toThrow(
    "NEAR provider unavailable",
  );
  expect(urls).toHaveLength(1);
});
it.each([
  "",
  "http://private.example/secret",
  "https://u:p@private.example/secret",
  "https://private.example/#secret",
  "https://private.example:8443/secret",
  "secret-invalid",
])(
  "rejects invalid runtime NEAR endpoint without echoing credentials (%s)",
  async (endpoint) => {
    vi.stubEnv("NEAR_TESTNET_RPC_URL", endpoint);
    await expect(adapter()).rejects.toThrow(
      /^Invalid NEAR testnet RPC endpoint$/,
    );
  },
);
it.each([429, 500, 503])(
  "bounds actual SDK HTTP %s to one attempt and redacts endpoint failures",
  async (status) => {
    vi.stubEnv(
      "NEAR_TESTNET_RPC_URL",
      "https://private.example/synthetic-near-key",
    );
    const a = (await adapter())!;
    let attempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attempts++;
      return new Response("synthetic-near-key", { status });
    });
    vi.useFakeTimers();
    const result = a.provider.viewNodeStatus().then(
      () => undefined,
      (error) => error,
    );
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({
      message: expect.stringContaining("NEAR provider unavailable"),
    });
    expect(attempts).toBe(1);
  },
);
it("redacts private NEAR errors during settlement discovery after fresh state passed", async () => {
  const a = (await adapter())!;
  vi.spyOn(a, "state").mockResolvedValue({
    ready: true,
    market: { vault: "0x3333333333333333333333333333333333333333" },
    settlement: { current_intent: { transfer: {} } },
  } as unknown as State);
  vi.spyOn(a.provider, "callFunction").mockRejectedValue(
    Error("https://private.example/synthetic-near-key"),
  );
  await expect(
    a.action({ action: "settle", role: "borrower" }),
  ).rejects.toThrow(/^NEAR provider unavailable or response rejected$/);
});
it("fresh preflight revalidates readiness instead of joining a display state flight", async () => {
  const { a, market, status } = await readableAdapter();
  await a.readiness({ fresh: false });
  let release!: (value: unknown) => void;
  let started!: () => void;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const original = vi.mocked(a.view).getMockImplementation()!;
  let held = false;
  vi.mocked(a.view).mockImplementation(async (method) => {
    if (method === "get_status" && !held) {
      held = true;
      started();
      return blocked;
    }
    return original(method);
  });
  const display = a.state({ fresh: false });
  await entered;
  market.borrower_balance_units = "7";
  const fresh = a.state({ fresh: true });
  // A display request is held upstream; fresh validation must still start immediately.
  expect(status).toHaveBeenCalledTimes(2);
  expect((await fresh).market!.borrower_balance_units).toBe("7");
  release(null);
  await display;
  expect((await a.state({ fresh: false })).market!.borrower_balance_units).toBe(
    "7",
  );
});

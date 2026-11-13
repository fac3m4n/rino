/** Controlled public RPC fixtures; no public chain execution or proof authentication. */
import { afterEach, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicCoordinator } from "../src/public.ts";
import type { State } from "../src/api.ts";

beforeEach(() =>
  vi.stubEnv(
    "ALCHEMY_SEPOLIA_RPC_URL",
    "https://eth-sepolia.g.alchemy.com/v2/proofcredit-synthetic-key",
  ),
);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
async function fixture(balance = "1") {
  const dir = await mkdtemp(join(tmpdir(), "proofcredit-public-preparation-"));
  const manifest = join(dir, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      version: 2,
      controllerId: `prep-${randomUUID().slice(0, 18)}.testnet`,
      borrowerId: "borrower.testnet",
      lenderId: "lender.testnet",
      borrowerRecipient: "0x1111111111111111111111111111111111111111",
      lenderRecipient: "0x2222222222222222222222222222222222222222",
      operationDeposit: "7000100000000000000000",
      controllerCodeHash: "11111111111111111111111111111111",
      collateralUrl: "https://published.example/collateral.wasm",
      settlementUrl: "https://published.example/settlement.wasm",
    }),
  );
  const adapter = (await PublicCoordinator.fromFile(manifest))!;
  const state = {
    ready: true,
    market: {
      phase: "Offered",
      borrower: "borrower.testnet",
      lender: "lender.testnet",
      vault: "0x3333333333333333333333333333333333333333",
      borrower_balance_units: "0",
      available_liquidity_units: "0",
      terms: {
        principal_units: "100000000",
        fee_units: "1000000",
        reference_units_per_eth: "2000000000",
        max_ltv_bps: "5000",
        term_seconds: "86400",
        fee_cap_wei_per_gas: "100000000000",
      },
    },
    settlement: { retired: false },
    ethereum: { vaultBalanceWei: balance },
  } as unknown as State;
  let latest = [100n, 100n],
    finals = [100n, 100n],
    capturedBalance = balance,
    disagree = false;
  const calls: Array<{ provider: number; method: string; params: any[] }> = [];
  const now = BigInt(Math.floor(Date.now() / 1000));
  const timestamps = new Map<bigint, bigint>();
  const nonces = new Map<bigint, string>();
  let intercept:
    | ((
        call: { provider: number; method: string; params: any[] },
        result: any,
      ) => any)
    | undefined;
  const balances = new Map<bigint, string>([[100n, balance]]);
  vi.spyOn(adapter, "state").mockImplementation(async () => state);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    const q = JSON.parse(String(options?.body));
    const provider = String(url).includes("publicnode") ? 0 : 1;
    expect(String(url)).toBe(
      provider === 0
        ? "https://ethereum-sepolia-rpc.publicnode.com/"
        : "https://eth-sepolia.g.alchemy.com/v2/proofcredit-synthetic-key",
    );
    const call = { provider, method: q.method, params: q.params };
    calls.push(call);
    let result;
    if (q.method === "eth_getBlockByNumber") {
      const number =
        q.params[0] === "latest"
          ? latest[provider]
          : q.params[0] === "finalized"
            ? finals[provider]
            : BigInt(q.params[0]);
      result = {
        number: `0x${number.toString(16)}`,
        hash: `0x${number.toString(16).padStart(64, "0")}`,
        stateRoot: `0x${(number + 1000n).toString(16).padStart(64, "0")}`,
        timestamp: `0x${(timestamps.get(number) ?? now).toString(16)}`,
      };
      if (disagree && provider === 1) result.stateRoot = "0x" + "ee".repeat(32);
    } else if (q.method === "eth_getProof") {
      const number = BigInt(q.params[2]);
      capturedBalance = balances.get(number)!;
      result = {
        balance: `0x${BigInt(capturedBalance).toString(16)}`,
        nonce: nonces.get(number) ?? "0x0",
        accountProof: [`0x${number.toString(16)}`],
      };
    } else throw Error(`unexpected RPC ${q.method}`);
    if (intercept) result = intercept(call, result);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
  });
  return {
    adapter,
    state,
    calls,
    balances,
    timestamps,
    nonces,
    setHeads(l: bigint[], f: bigint[]) {
      latest = l;
      finals = f;
    },
    intercept(fn: typeof intercept) {
      intercept = fn;
    },
    capturedBalance: () => capturedBalance,
    disagree() {
      disagree = true;
    },
    advance(number: bigint, balance: string, finalized: bigint[]) {
      latest = [number, number];
      finals = finalized;
      balances.set(number, balance);
      state.ethereum!.vaultBalanceWei = balance;
    },
    captureFile: join(adapter.directory, "capture-collateral-0.json"),
    prove: () => adapter.action({ action: "prove", role: "borrower" }),
  };
}
// These cases catch latest-first selection, witness-route changes and needless recapture.
it.each([false, true])(
  "uses ready finalized 108 without latest reads (expired cache: %s)",
  async (expired) => {
    const f = await fixture("120000000000000000");
    if (expired) {
      await f.prove();
      const saved = JSON.parse(await readFile(f.captureFile, "utf8"));
      saved.bundle.block_timestamp = String(
        Math.floor(Date.now() / 1000) - 3601,
      );
      await writeFile(f.captureFile, JSON.stringify(saved));
      f.calls.length = 0;
    }
    f.setHeads([120n, 119n], [110n, 108n]);
    f.balances.set(108n, "120000000000000000");
    f.balances.set(119n, "120000000000000000");
    const result = await f.prove();
    const bundle = result.walletActions![0].args.bundle as any;
    expect(bundle.block_number).toBe("108");
    expect(bundle.account_proof).toEqual(["0x6c"]);
    expect(f.calls.some((c) => c.params[0] === "latest")).toBe(false);
    expect(
      f.calls
        .filter((c) => c.method === "eth_getProof")
        .map((c) => [c.provider, c.params[2]]),
    ).toEqual([[1, "0x6c"]]);
    expect(f.calls.length).toBeLessThanOrEqual(9);
    f.calls.length = 0;
    f.setHeads([122n, 121n], [112n, 110n]);
    expect((await f.prove()).walletActions![0].args.bundle as any).toEqual(
      bundle,
    );
    expect(f.calls).toHaveLength(4);
    expect(f.calls.some((c) => c.method === "eth_getProof")).toBe(false);
  },
);
it("uses the financial minimum below the display funding target", async () => {
  const f = await fixture("112600000000000000");
  f.setHeads([120n, 119n], [110n, 108n]);
  f.balances.set(108n, "112600000000000000");
  f.balances.set(119n, "112600000000000000");
  expect(
    ((await f.prove()).walletActions![0].args.bundle as any).block_number,
  ).toBe("108");
  expect(f.calls.some((c) => c.params[0] === "latest")).toBe(false);
});
it("does not promote an underfunded finalized or recent capture while live funding is sufficient", async () => {
  const f = await fixture("120000000000000000");
  f.balances.set(100n, "1");
  f.balances.set(102n, "50000000000000000");
  f.setHeads([103n, 102n], [101n, 100n]);
  await expect(f.prove()).rejects.toThrow("fund");
  expect(f.calls.filter((c) => c.method === "eth_getProof")).toHaveLength(2);
  expect(f.calls.length).toBeLessThanOrEqual(14);
});
it("captures one recent funded target and reuses it through gifts", async () => {
  const f = await fixture("120000000000000000");
  f.balances.set(100n, "1");
  f.balances.set(102n, "120000000000000000");
  f.setHeads([103n, 102n], [101n, 100n]);
  await expect(f.prove()).rejects.toThrow("Captured block 102");
  expect(f.calls.length).toBeLessThanOrEqual(14);
  f.calls.length = 0;
  f.advance(104n, "120000000000000001", [104n, 101n]);
  await expect(f.prove()).rejects.toThrow("Captured block 102");
  expect(f.calls).toHaveLength(2);
  f.calls.length = 0;
  f.advance(105n, "120000000000000002", [105n, 102n]);
  expect(
    ((await f.prove()).walletActions![0].args.bundle as any).account_proof,
  ).toEqual(["0x66"]);
  expect(f.calls).toHaveLength(4);
});
it("skips stale finalized witnesses for a single fresh recent target", async () => {
  const f = await fixture("120000000000000000");
  f.timestamps.set(100n, BigInt(Math.floor(Date.now() / 1000) - 3601));
  f.balances.set(102n, "120000000000000000");
  f.setHeads([102n, 102n], [101n, 100n]);
  await expect(f.prove()).rejects.toThrow("Captured block 102");
  expect(
    f.calls.filter((c) => c.method === "eth_getProof").map((c) => c.params[2]),
  ).toEqual(["0x66"]);
  expect(f.calls.length).toBeLessThanOrEqual(13);
});
it("retains exactly one-hour-old captures but rebuilds legacy applicability once", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
  const f = await fixture("120000000000000000");
  f.timestamps.set(100n, BigInt(Math.floor(Date.now() / 1000) - 3600));
  await f.prove();
  f.calls.length = 0;
  await f.prove();
  expect(f.calls).toHaveLength(4);
  const saved = JSON.parse(await readFile(f.captureFile, "utf8"));
  delete saved.purpose;
  delete saved.expectedNonce;
  await writeFile(f.captureFile, JSON.stringify(saved));
  f.calls.length = 0;
  await f.prove();
  expect(f.calls.filter((c) => c.method === "eth_getProof")).toHaveLength(1);
  f.calls.length = 0;
  await f.prove();
  expect(f.calls).toHaveLength(4);
});
it.each([
  ...["future", "nonce", "proof", "proof-error", "return-age"].map(
    (fault) => [fault, 1] as const,
  ),
  ...[
    "null",
    "number",
    "timestamp",
    "rpc",
    "http",
    "timeout",
    "oversize",
    "canonical",
  ].flatMap((fault) => [0, 1].map((provider) => [fault, provider] as const)),
])(
  "fails closed for %s from provider %s without a wallet request",
  async (fault, provider) => {
    const f = await fixture("120000000000000000");
    if (fault === "future")
      f.timestamps.set(100n, BigInt(Math.floor(Date.now() / 1000) + 10));
    if (fault === "nonce") f.nonces.set(100n, "0x1");
    let numeric = 0;
    f.intercept((c, result) => {
      if (c.method === "eth_getProof" && fault === "proof")
        return { ...result, accountProof: ["not-hex"] };
      if (c.method === "eth_getProof" && fault === "proof-error")
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32000, message: "synthetic rejected witness" },
          }),
        );
      if (c.method === "eth_getBlockByNumber" && c.provider === provider) {
        if (fault === "null") return null;
        if (fault === "rpc")
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32000, message: "synthetic RPC failure" },
            }),
          );
        if (fault === "http")
          return new Response("synthetic HTTP failure", { status: 503 });
        if (fault === "timeout")
          throw new DOMException("synthetic timeout", "TimeoutError");
        if (fault === "oversize")
          return { ...result, junk: "x".repeat(262145) };
        if (c.params[0] !== "latest" && c.params[0] !== "finalized") {
          numeric++;
          if (fault === "number") return { ...result, number: "0x63" };
          if (fault === "timestamp") return { ...result, timestamp: "0x1" };
          if (fault === "canonical" && numeric > 1)
            return { ...result, hash: "0x" + "ee".repeat(32) };
          if (fault === "return-age" && numeric > 1)
            vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3601000);
        }
      }
      return result;
    });
    await expect(f.prove()).rejects.toThrow();
    expect(f.calls.length).toBeLessThanOrEqual(14);
    if (
      [
        "rpc",
        "http",
        "timeout",
        "oversize",
        "null",
        "number",
        "timestamp",
        "proof",
        "proof-error",
        "canonical",
      ].includes(fault)
    )
      expect(f.calls.some((c) => c.params[0] === "latest")).toBe(false);
  },
);
it("rejects PublicNode and Alchemy canonical header disagreement before asking for a wallet job", async () => {
  const f = await fixture();
  f.disagree();
  await expect(f.prove()).rejects.toThrow("public checkpoint quorum mismatch");
});
it("replaces an inadequate collateral capture after partial then sufficient topup and retains its adequate finality target through gifts", async () => {
  const f = await fixture();
  const first = await f.prove();
  expect((first.walletActions![0].args.bundle as any).block_number).toBe("100");
  f.advance(101n, "50000000000000000", [101n, 101n]);
  await f.prove();
  f.advance(102n, "120000000000000000", [102n, 101n]);
  await expect(f.prove()).rejects.toThrow("both fixed providers finalized");
  expect(
    JSON.parse(await readFile(f.captureFile, "utf8")).bundle.block_number,
  ).toBe("102");
  f.advance(103n, "120000000000000001", [103n, 101n]);
  await expect(f.prove()).rejects.toThrow("Captured block 102");
  f.advance(104n, "120000000000000002", [104n, 102n]);
  const proof = await f.prove();
  expect((proof.walletActions![0].args.bundle as any).block_number).toBe("102");
  expect((proof.walletActions![0].args.bundle as any).account_proof).toEqual([
    "0x66",
  ]);
  expect(
    Object.keys(proof.walletActions![0].args.bundle as object).sort(),
  ).toEqual([
    "account_proof",
    "block_hash",
    "block_number",
    "block_timestamp",
    "state_root",
  ]);
  expect(f.capturedBalance()).toBe("120000000000000000");
});
it.each([
  ["0", "1000000"],
  ["1", "999999"],
  ["999999", "1"],
  ["1000000", null],
  ["1000001", null],
])(
  "public fee endowment at %s units transfers only shortfall %s after liquidity funding",
  async (balance, shortfall) => {
    const f = await fixture();
    f.state.market!.borrower_balance_units = balance!;
    f.state.market!.available_liquidity_units = "100000000";
    const result = await f.adapter.action({ action: "fund", role: "lender" });
    expect(result.walletActions).toEqual(
      shortfall
        ? [
            {
              chain: "near",
              receiverId: f.adapter.deployment.controllerId,
              methodName: "ft_transfer",
              args: { receiver_id: "borrower.testnet", amount: shortfall },
              gas: "300000000000000",
              deposit: "1",
            },
          ]
        : [],
    );
  },
);
it("public fresh funding orders the exact fee shortfall before principal liquidity", async () => {
  const f = await fixture();
  f.state.market!.borrower_balance_units = "999999";
  const result = await f.adapter.action({ action: "fund", role: "lender" });
  expect(result.walletActions!.map((a) => [a.methodName, a.args])).toEqual([
    ["ft_transfer", { receiver_id: "borrower.testnet", amount: "1" }],
    ["fund_liquidity", {}],
  ]);
});
it("does not repeat the subsidy after the borrower has received the exact shortfall", async () => {
  const f = await fixture();
  f.state.market!.borrower_balance_units = "1";
  f.state.market!.available_liquidity_units = "100000000";
  expect(
    (await f.adapter.action({ action: "fund", role: "lender" }))
      .walletActions![0].args.amount,
  ).toBe("999999");
  f.state.market!.borrower_balance_units = "1000000";
  expect(
    (await f.adapter.action({ action: "fund", role: "lender" })).walletActions,
  ).toEqual([]);
});

it("retains a cached target when finalized coverage regresses and rejects a later canonical change", async () => {
  const f = await fixture("120000000000000000");
  await f.prove();
  const original = await readFile(f.captureFile, "utf8");
  f.calls.length = 0;
  f.setHeads([120n, 119n], [101n, 99n]);
  await expect(f.prove()).rejects.toThrow("Captured block 100");
  expect(f.calls).toHaveLength(2);
  expect(await readFile(f.captureFile, "utf8")).toBe(original);
  f.calls.length = 0;
  f.setHeads([120n, 119n], [102n, 101n]);
  f.intercept((c, result) =>
    c.method === "eth_getBlockByNumber" && c.params[0] === "0x64"
      ? { ...result, hash: "0x" + "ee".repeat(32) }
      : result,
  );
  await expect(f.prove()).rejects.toThrow("no longer canonical");
  expect(f.calls).toHaveLength(4);
  expect(await readFile(f.captureFile, "utf8")).toBe(original);
});
it("does no capture work while idle and rejects two stale choices without any witness", async () => {
  vi.useFakeTimers();
  const f = await fixture("120000000000000000");
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.calls).toHaveLength(0);
  const old = BigInt(Math.floor(Date.now() / 1000) - 3601);
  f.timestamps.set(100n, old);
  f.timestamps.set(102n, old);
  f.setHeads([103n, 102n], [101n, 100n]);
  await expect(f.prove()).rejects.toThrow("stale");
  expect(f.calls.some((c) => c.method === "eth_getProof")).toBe(false);
  expect(f.calls).toHaveLength(8);
});

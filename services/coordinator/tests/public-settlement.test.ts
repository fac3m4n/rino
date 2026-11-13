/** Controlled RPC/SDK fixtures only; no public deployment or transaction. */
import { it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, parseTransaction, serializeTransaction } from "viem";
import { PublicCoordinator } from "../src/public.ts";
import type { State, SignedTransaction } from "../src/api.ts";

beforeEach(() =>
  vi.stubEnv(
    "ALCHEMY_SEPOLIA_RPC_URL",
    "https://eth-sepolia.g.alchemy.com/v2/proofcredit-synthetic-key",
  ),
);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const recipient = "0x1111111111111111111111111111111111111111" as const;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "proofcredit-public-settlement-"));
  const manifest = join(dir, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      version: 2,
      controllerId: `capture-${randomUUID().slice(0, 18)}.testnet`,
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
  const account = privateKeyToAccount(generatePrivateKey());
  const now = BigInt(Math.floor(Date.now() / 1000));
  let latest = [100n, 100n],
    finalized = [100n, 100n],
    inclusion = 101n;
  let state = {
    ready: true,
    nearTimeSeconds: now.toString(),
    market: {
      phase: "Repaid",
      vault: account.address.toLowerCase(),
      borrower_recipient: recipient,
      lender_recipient: "0x2222222222222222222222222222222222222222",
      terms: { fee_cap_wei_per_gas: "100000000000" },
    },
    settlement: {
      retired: false,
      pending: null,
      branch: "repay",
      expected_nonce: "0",
      remaining_lender_cap_wei: "0",
      current_intent: null,
    },
  } as unknown as State;
  let candidate: SignedTransaction | null = null;
  const nonces = new Map<bigint, bigint>();
  const baseFees = new Map<bigint, bigint>();
  let quoteBaseFees = [1n, 1n];
  let intercept:
    | ((
        call: { provider: number; method: string; params: any[] },
        result: any,
      ) => any)
    | undefined;
  const calls: Array<{ provider: number; method: string; params: any[] }> = [];
  const header = (number: bigint) => ({
    number: `0x${number.toString(16)}`,
    hash: `0x${number.toString(16).padStart(64, "0")}`,
    stateRoot: `0x${(number + 1000n).toString(16).padStart(64, "0")}`,
    timestamp: `0x${(now - 30n).toString(16)}`,
    baseFeePerGas: `0x${(baseFees.get(number) ?? 1n).toString(16)}`,
  });
  vi.spyOn(adapter, "state").mockImplementation(async () => state);
  vi.spyOn(adapter, "view").mockImplementation(async (method: string) => {
    if (method !== "get_signed_transactions")
      throw Error(`unexpected view ${method}`);
    return candidate ? [candidate] : [];
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    const q = JSON.parse(String(options?.body)),
      provider = String(url).includes("publicnode") ? 0 : 1;
    expect(String(url)).toBe(
      provider === 0
        ? "https://ethereum-sepolia-rpc.publicnode.com/"
        : "https://eth-sepolia.g.alchemy.com/v2/proofcredit-synthetic-key",
    );
    calls.push({ provider, method: q.method, params: q.params });
    let result: unknown;
    if (q.method === "eth_getBlockByNumber")
      result = header(
        q.params[0] === "latest"
          ? latest[provider]
          : q.params[0] === "finalized"
            ? finalized[provider]
            : BigInt(q.params[0]),
      );
    else if (q.method === "eth_getProof")
      result = {
        nonce: `0x${(nonces.get(BigInt(q.params[2])) ?? BigInt(state.settlement!.expected_nonce) + (state.settlement!.current_intent && BigInt(q.params[2]) >= inclusion ? 1n : 0n)).toString(16)}`,
        accountProof: [
          `0x${BigInt(q.params[2]).toString(16).padStart(2, "0")}`,
        ],
      };
    else if (q.method === "eth_getTransactionReceipt")
      result = {
        transactionHash: candidate!.hash,
        blockNumber: `0x${inclusion.toString(16)}`,
        blockHash: header(inclusion).hash,
        transactionIndex: "0x0",
      };
    else throw Error(`unexpected public RPC ${q.method}`);
    if (q.method === "eth_getBlockByNumber" && q.params[0] === "latest")
      (result as any).baseFeePerGas =
        `0x${quoteBaseFees[provider].toString(16)}`;
    if (intercept)
      result = intercept(
        { provider, method: q.method, params: q.params },
        result,
      );
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
  });
  async function issue(nonce: number) {
    const tx = {
      type: "eip1559" as const,
      chainId: 11155111,
      nonce,
      to: recipient,
      value: 100n,
      gas: 21000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 2n,
      data: "0x" as const,
      accessList: [],
    };
    const raw = await account.signTransaction(tx),
      parsed = parseTransaction(raw);
    candidate = {
      raw,
      hash: keccak256(raw),
      signing_digest: keccak256(serializeTransaction(tx)),
      r: parsed.r!,
      s: parsed.s!,
      y_parity: String(parsed.yParity),
    };
    state.settlement!.current_intent = {
      transfer: {
        chain_id: "11155111",
        nonce: String(nonce),
        to: recipient,
        value: "100",
        gas_limit: "21000",
        gas_price: "2",
      },
      signing_preimage: serializeTransaction(tx),
      signing_digest: candidate.signing_digest,
      before_balance_wei: "42100",
      minimum_block_number: "100",
    };
  }
  return {
    adapter,
    calls,
    state,
    nonces,
    baseFees,
    setQuoteBaseFees: (fees: bigint[]) => {
      quoteBaseFees = fees;
    },
    intercept: (fn: typeof intercept) => {
      intercept = fn;
    },
    issue,
    setHeads: (l: bigint[], f: bigint[]) => {
      latest = l;
      finalized = f;
    },
    setInclusion: (n: bigint) => {
      inclusion = n;
    },
    resetIntent: (nonce: string) => {
      state.settlement!.expected_nonce = nonce;
      state.settlement!.current_intent = null;
      candidate = null;
    },
    cache: (nonce: string) =>
      join(adapter.directory, `capture-${recipient}-${nonce}.json`),
  };
}
it("public confirmation replaces pre-inclusion preparation capture and waits for BOTH finalized providers", async () => {
  const f = await fixture();
  const prepare = await f.adapter.action({
    action: "settle",
    role: "borrower",
  });
  expect((prepare.walletActions![0].args.bundle as any).block_number).toBe(
    "100",
  );
  await f.issue(0);
  f.setHeads([102n, 102n], [102n, 100n]);
  await expect(
    f.adapter.action({ action: "settle", role: "borrower" }),
  ).rejects.toThrow("both fixed providers finalized");
  expect(
    JSON.parse(await readFile(f.cache("0"), "utf8")).bundle.block_number,
  ).toBe("102");
  f.setHeads([103n, 102n], [102n, 102n]);
  const confirm = await f.adapter.action({
    action: "settle",
    role: "borrower",
  });
  expect(confirm.walletActions![0].methodName).toBe("confirm_settlement");
  const checkpoint = (confirm.walletActions![0].args.bundle as any).checkpoint;
  expect(checkpoint.block_number).toBe("102");
  expect(checkpoint.vault_account_proof).toEqual(["0x66"]);
  expect(
    f.calls
      .filter(
        (c) =>
          c.method === "eth_getBlockByNumber" && c.params[0] === "finalized",
      )
      .map((c) => c.provider),
  ).toEqual(expect.arrayContaining([0, 1]));
});
it("public second-leg confirmation uses its actual nonzero intent nonce and inclusion floor", async () => {
  const f = await fixture();
  await f.adapter.action({ action: "settle", role: "borrower" });
  f.resetIntent("1");
  f.setHeads([105n, 105n], [105n, 105n]);
  await f.adapter.action({ action: "settle", role: "borrower" });
  await f.issue(1);
  f.setInclusion(106n);
  f.setHeads([107n, 107n], [107n, 107n]);
  const confirm = await f.adapter.action({
    action: "settle",
    role: "borrower",
  });
  expect(
    (confirm.walletActions![0].args.bundle as any).checkpoint.block_number,
  ).toBe("107");
  expect(
    JSON.parse(await readFile(f.cache("1"), "utf8")).bundle.block_number,
  ).toBe("107");
  expect(
    JSON.parse(await readFile(f.cache("0"), "utf8")).bundle.block_number,
  ).toBe("100");
});
it("public heads below receipt inclusion fail closed without creating a below-floor capture", async () => {
  const f = await fixture();
  await f.issue(0);
  f.setHeads([100n, 103n], [100n, 103n]);
  await expect(
    f.adapter.action({ action: "settle", role: "borrower" }),
  ).rejects.toThrow("inclusion");
  expect(f.calls.some((c) => c.method === "eth_getProof")).toBe(false);
  expect(
    (await readdir(f.adapter.directory)).some((p) => p.startsWith("capture-")),
  ).toBe(false);
});

// Choosing latest here would force an avoidable finality wait above the receipt.
it("confirms immediately at common finalized inclusion with exact Alchemy proof bytes", async () => {
  const f = await fixture();
  await f.adapter.action({ action: "settle", role: "borrower" });
  await f.issue(0);
  f.calls.length = 0;
  f.setHeads([110n, 109n], [102n, 101n]);
  const result = await f.adapter.action({ action: "settle", role: "borrower" });
  const bundle = (result.walletActions![0].args.bundle as any).checkpoint;
  expect(bundle.block_number).toBe("101");
  expect(bundle.vault_account_proof).toEqual(["0x65"]);
  expect(bundle.beneficiary_account_proof).toEqual(["0x65"]);
  const captureCalls = f.calls.filter(
    (c) => c.method !== "eth_getTransactionReceipt",
  );
  expect(captureCalls).toHaveLength(10);
  expect(captureCalls.some((c) => c.params[0] === "latest")).toBe(false);
  expect(
    captureCalls
      .filter((c) => c.method === "eth_getProof")
      .map((c) => c.provider),
  ).toEqual([1, 1]);
  f.calls.length = 0;
  await f.adapter.action({ action: "settle", role: "borrower" });
  expect(
    f.calls.filter((c) => c.method !== "eth_getTransactionReceipt"),
  ).toHaveLength(4);
});
it("preparation respects accepted checkpoint and nonce after the first settlement leg", async () => {
  const f = await fixture();
  await f.adapter.action({ action: "settle", role: "borrower" });
  f.resetIntent("1");
  f.state.settlement!.checkpoint_block_number = "105";
  f.nonces.set(100n, 0n);
  f.nonces.set(106n, 1n);
  f.setHeads([107n, 106n], [102n, 100n]);
  f.calls.length = 0;
  await expect(
    f.adapter.action({ action: "settle", role: "borrower" }),
  ).rejects.toThrow("Captured block 106");
  expect(
    f.calls.filter((c) => c.method === "eth_getProof").map((c) => c.params[2]),
  ).toEqual(["0x6a", "0x6a"]);
  expect(
    JSON.parse(await readFile(f.cache("0"), "utf8")).bundle.block_number,
  ).toBe("100");
  f.setHeads([110n, 109n], [107n, 106n]);
  f.calls.length = 0;
  const result = await f.adapter.action({ action: "settle", role: "borrower" });
  expect((result.walletActions![0].args.bundle as any).block_number).toBe(
    "106",
  );
  expect(f.calls.filter((c) => c.method === "eth_getProof")).toHaveLength(0);
});
it("wrong finalized preparation nonce uses one recent target without fetching disqualified beneficiary proof", async () => {
  const f = await fixture();
  f.resetIntent("1");
  f.nonces.set(100n, 0n);
  f.nonces.set(102n, 1n);
  f.setHeads([103n, 102n], [101n, 100n]);
  await expect(
    f.adapter.action({ action: "settle", role: "borrower" }),
  ).rejects.toThrow("Captured block 102");
  const proofs = f.calls.filter((c) => c.method === "eth_getProof");
  expect(proofs.map((c) => [c.params[0], c.params[2]])).toEqual([
    [f.state.market!.vault, "0x64"],
    [f.state.market!.vault, "0x66"],
    [recipient, "0x66"],
  ]);
  // The initial two latest reads calculate the unchanged action-local fee.
  expect(f.calls.length - 2).toBeLessThanOrEqual(15);
});
it("confirmation refuses both finalized and latest state with a pre-transaction nonce", async () => {
  const f = await fixture();
  await f.issue(0);
  f.nonces.set(101n, 0n);
  f.nonces.set(103n, 0n);
  f.setHeads([104n, 103n], [102n, 101n]);
  await expect(
    f.adapter.action({ action: "settle", role: "borrower" }),
  ).rejects.toThrow("nonce");
  expect(f.calls.filter((c) => c.method === "eth_getProof")).toHaveLength(2);
});

// These cases catch preparations that the controller would reject because the
// authenticated checkpoint base fee exceeds the independently quoted gas price.
it("skips finalized base fee 100 under quote 2 and retains the affordable recent checkpoint", async () => {
  const f = await fixture();
  f.baseFees.set(100n, 100n);
  f.setHeads([103n, 102n], [101n, 100n]);
  await expect(
    f.adapter.action({ action: "settle", role: "borrower" }),
  ).rejects.toThrow("Captured block 102");
  expect(
    f.calls.filter((c) => c.method === "eth_getProof").map((c) => c.params[2]),
  ).toEqual(["0x66", "0x66"]);
  expect(f.calls.length - 2).toBeLessThanOrEqual(15);
  f.calls.length = 0;
  f.setHeads([110n, 109n], [104n, 102n]);
  f.setQuoteBaseFees([2n, 1n]);
  const result = await f.adapter.action({ action: "settle", role: "borrower" });
  expect(result.walletActions![0].args.gas_price).toBe("4");
  expect((result.walletActions![0].args.bundle as any).block_number).toBe(
    "102",
  );
  expect(f.calls.length - 2).toBe(4);
  expect(f.calls.some((c) => c.method === "eth_getProof")).toBe(false);
});
it("invalidates a previously affordable cached fee floor when the quote falls", async () => {
  const f = await fixture();
  f.baseFees.set(100n, 100n);
  f.setQuoteBaseFees([100n, 100n]);
  const first = await f.adapter.action({ action: "settle", role: "borrower" });
  expect(first.walletActions![0].args.gas_price).toBe("200");
  expect((first.walletActions![0].args.bundle as any).block_number).toBe("100");
  f.setQuoteBaseFees([1n, 1n]);
  f.setHeads([103n, 102n], [101n, 100n]);
  f.calls.length = 0;
  await expect(
    f.adapter.action({ action: "settle", role: "borrower" }),
  ).rejects.toThrow("Captured block 102");
  expect(
    JSON.parse(await readFile(f.cache("0"), "utf8")).bundle.block_number,
  ).toBe("102");
  expect(
    f.calls.filter((c) => c.method === "eth_getProof").map((c) => c.params[2]),
  ).toEqual(["0x66", "0x66"]);
});
it("accepts checkpoint base fee equal to the quote without leaking fee metadata into the bundle", async () => {
  const f = await fixture();
  f.baseFees.set(100n, 2n);
  const result = await f.adapter.action({ action: "settle", role: "borrower" });
  expect(result.walletActions![0].args.gas_price).toBe("2");
  expect(
    Object.keys(result.walletActions![0].args.bundle as object).sort(),
  ).toEqual([
    "beneficiary_account_proof",
    "block_hash",
    "block_number",
    "block_timestamp",
    "state_root",
    "vault_account_proof",
  ]);
  expect(f.calls.length - 2).toBe(10);
});
it("rejects finalized and recent checkpoints above quote without witnesses or unsuitable cache", async () => {
  const f = await fixture();
  f.baseFees.set(100n, 100n);
  f.baseFees.set(102n, 3n);
  f.setHeads([103n, 102n], [101n, 100n]);
  await expect(
    f.adapter.action({ action: "settle", role: "borrower" }),
  ).rejects.toThrow("base fee");
  expect(f.calls.some((c) => c.method === "eth_getProof")).toBe(false);
  expect(
    (await readdir(f.adapter.directory)).some((p) => p.startsWith("capture-")),
  ).toBe(false);
  expect(f.calls.length - 2).toBe(8);
});
it("rebuilds unknown legacy preparation fee metadata once", async () => {
  const f = await fixture();
  await f.adapter.action({ action: "settle", role: "borrower" });
  const old = JSON.parse(await readFile(f.cache("0"), "utf8"));
  delete old.checkpointBaseFeeWei;
  await writeFile(f.cache("0"), JSON.stringify(old));
  f.calls.length = 0;
  await f.adapter.action({ action: "settle", role: "borrower" });
  expect(f.calls.filter((c) => c.method === "eth_getProof")).toHaveLength(2);
  f.calls.length = 0;
  await f.adapter.action({ action: "settle", role: "borrower" });
  expect(f.calls.length - 2).toBe(4);
});
it.each([
  "missing",
  "malformed",
  "disagree",
  "recheck-missing",
  "recheck-disagree",
  "recheck-changed",
])(
  "rejects %s canonical preparation fees without a selection retry",
  async (fault) => {
    const f = await fixture();
    let numeric = 0;
    f.intercept((call, result) => {
      if (call.method !== "eth_getBlockByNumber" || call.params[0] !== "0x64")
        return result;
      numeric++;
      const recheck = fault.startsWith("recheck-");
      if (recheck && numeric <= 2) return result;
      if (fault === "recheck-changed")
        return { ...result, baseFeePerGas: "0x2" };
      if (call.provider === 0) return result;
      if (fault.endsWith("missing")) {
        const { baseFeePerGas, ...rest } = result;
        return rest;
      }
      if (fault === "malformed") return { ...result, baseFeePerGas: "0xno" };
      return { ...result, baseFeePerGas: "0x2" };
    });
    await expect(
      f.adapter.action({ action: "settle", role: "borrower" }),
    ).rejects.toThrow();
    expect(
      f.calls.filter(
        (c) => c.method === "eth_getBlockByNumber" && c.params[0] === "latest",
      ),
    ).toHaveLength(2);
    expect(f.calls.length - 2).toBeLessThanOrEqual(10);
  },
);
it("preserves twice the maximum latest base fee and the immutable quote cap", async () => {
  const f = await fixture();
  f.setQuoteBaseFees([3n, 7n]);
  const result = await f.adapter.action({ action: "settle", role: "borrower" });
  expect(result.walletActions![0].args.gas_price).toBe("14");
  f.calls.length = 0;
  f.state.market!.terms.fee_cap_wei_per_gas = "13";
  await expect(
    f.adapter.action({ action: "settle", role: "borrower" }),
  ).rejects.toThrow("immutable cap");
  expect(f.calls).toHaveLength(2);
});

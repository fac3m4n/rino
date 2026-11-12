/** Controlled RPC/SDK fixtures only; no public deployment or transaction. */
import { it, expect, vi, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, parseTransaction, serializeTransaction } from "viem";
import { PublicCoordinator } from "../src/public.ts";
import type { State, SignedTransaction } from "../src/api.ts";

afterEach(() => vi.restoreAllMocks());
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
  const calls: Array<{ provider: number; method: string; params: any[] }> = [];
  const header = (number: bigint) => ({
    number: `0x${number.toString(16)}`,
    hash: `0x${number.toString(16).padStart(64, "0")}`,
    stateRoot: `0x${(number + 1000n).toString(16).padStart(64, "0")}`,
    timestamp: `0x${(now - 30n).toString(16)}`,
    baseFeePerGas: "0x1",
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
        nonce: `0x${(BigInt(state.settlement!.expected_nonce) + (BigInt(q.params[2]) >= inclusion ? 1n : 0n)).toString(16)}`,
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
  f.setHeads([102n, 102n], [102n, 101n]);
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

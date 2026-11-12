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
  let latest = 100n,
    finals = [100n, 100n],
    capturedBalance = balance,
    disagree = false;
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
    let result;
    if (q.method === "eth_getBlockByNumber") {
      const number =
        q.params[0] === "latest"
          ? latest
          : q.params[0] === "finalized"
            ? finals[provider]
            : BigInt(q.params[0]);
      result = {
        number: `0x${number.toString(16)}`,
        hash: `0x${number.toString(16).padStart(64, "0")}`,
        stateRoot: `0x${(number + 1000n).toString(16).padStart(64, "0")}`,
        timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
      };
      if (disagree && provider === 1) result.stateRoot = "0x" + "ee".repeat(32);
    } else if (q.method === "eth_getProof") {
      const number = BigInt(q.params[2]);
      capturedBalance = balances.get(number)!;
      result = {
        balance: `0x${BigInt(capturedBalance).toString(16)}`,
        nonce: "0x0",
        accountProof: [`0x${number.toString(16)}`],
      };
    } else throw Error(`unexpected RPC ${q.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
  });
  return {
    adapter,
    state,
    capturedBalance: () => capturedBalance,
    disagree() {
      disagree = true;
    },
    advance(number: bigint, balance: string, finalized: bigint[]) {
      latest = number;
      finals = finalized;
      balances.set(number, balance);
      state.ethereum!.vaultBalanceWei = balance;
    },
    captureFile: join(adapter.directory, "capture-collateral-0.json"),
    prove: () => adapter.action({ action: "prove", role: "borrower" }),
  };
}
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

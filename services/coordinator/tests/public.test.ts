import { it, expect, vi, afterEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicCoordinator } from "../src/public.ts";
import { PINS } from "../src/local.ts";
import type { State } from "../src/api.ts";
afterEach(() => vi.restoreAllMocks());
const deployment = {
  version: 1,
  controllerId: "controller.testnet",
  borrowerId: "borrower.testnet",
  lenderId: "lender.testnet",
  controllerCodeHash: "11111111111111111111111111111111",
  collateralUrl: "https://published.example/collateral.wasm",
  settlementUrl: "https://published.example/settlement.wasm",
};
async function adapter(extra: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "proofcredit-public-"));
  const p = join(dir, "manifest.json");
  await writeFile(p, JSON.stringify({ ...deployment, ...extra }));
  return PublicCoordinator.fromFile(p);
}
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
        }
      : {
          lender: deployment.lenderId,
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
  fetch.mockImplementation(
    async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" })),
  );
  expect(await a.readiness()).toContain("Wrong public network");
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

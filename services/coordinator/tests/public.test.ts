import { it, expect, vi, afterEach } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicCoordinator } from "../src/public.ts";
import { PINS } from "../src/local.ts";
import type { State } from "../src/api.ts";
afterEach(() => vi.restoreAllMocks());
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

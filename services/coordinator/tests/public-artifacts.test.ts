/** Public deployment compatibility uses synthetic manifests and controlled RPC only. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PublicCoordinator } from "../src/public.ts";
import type { LocalCoordinator } from "../src/local.ts";
import { createApp } from "../src/server.ts";
import { ROOT } from "../src/processes.ts";
import { HASH_DETAILS, OperationJournal } from "../src/operations.ts";
import type { Config, WalletAction } from "../src/api.ts";

// Simulate a rebuilt local toolchain without changing any deployed artifacts.
vi.mock("../src/local.ts", async (original) => ({
  ...(await original<typeof import("../src/local.ts")>()),
  PINS: {
    collateral: "aa".repeat(32),
    settlement: "bb".repeat(32),
    controller: "cc".repeat(32),
  },
}));

const reviewedV2 = {
  collateral:
    "fbd5e0664aa18b3fe11f07d383cfbb73ef9eeff9d7747f623b33f09c4570f96e",
  settlement:
    "a0efb7959a1f227d7e81579820bf3b3cec9804d94e5095fa6a90b301052e19c7",
  controller:
    "f46bb1dedeca51f8f7820d5c74e30e0484421299adb3d6715545741ad1115497",
};
const selectedV3 = {
  collateral: "12".repeat(32),
  settlement: "34".repeat(32),
  controller: "00".repeat(32),
};
const directories: string[] = [];
beforeEach(() => {
  vi.stubEnv("NEAR_TESTNET_RPC_URL", undefined);
  vi.stubEnv(
    "ALCHEMY_SEPOLIA_RPC_URL",
    "https://eth-sepolia.g.alchemy.com/v2/rino-artifact-synthetic-key",
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function manifest(extra: Record<string, unknown> = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "rino-artifacts-"));
  directories.push(temporary);
  const data = {
    version: 2,
    controllerId: `artifacts-${randomUUID().slice(0, 16)}.testnet`,
    borrowerId: "borrower.testnet",
    lenderId: "lender.testnet",
    borrowerRecipient: `0x${"11".repeat(20)}`,
    lenderRecipient: `0x${"22".repeat(20)}`,
    operationDeposit: "7000100000000000000000",
    controllerCodeHash: "1".repeat(32),
    collateralUrl: "https://published.example/rino-collateral.wasm",
    settlementUrl: "https://published.example/rino-settlement.wasm",
    ...extra,
  };
  const bytes = JSON.stringify(data);
  const path = join(temporary, "manifest.json");
  await writeFile(path, bytes);
  const directory = resolve(
    ROOT,
    ".cache/public-coordinator",
    createHash("sha256").update(bytes).digest("hex"),
  );
  directories.push(directory);
  return { path, data, bytes, directory };
}
function deployed(adapter: PublicCoordinator, pins: Config["artifactHashes"]) {
  const config = {
    borrower: adapter.deployment.borrowerId,
    executor: "outlayer.testnet",
    mpc: "v1.signer-prod.testnet",
    network: "NearTestnet",
    wasm_url: adapter.deployment.collateralUrl,
    wasm_sha256: pins.collateral,
    operation_deposit: adapter.deployment.operationDeposit,
  };
  const market = {
    lender: adapter.deployment.lenderId,
    borrower_recipient: adapter.deployment.borrowerRecipient,
    lender_recipient: adapter.deployment.lenderRecipient,
    terms: { term_seconds: "86400" },
    settlement_wasm_url: adapter.deployment.settlementUrl,
    settlement_wasm_sha256: pins.settlement,
  };
  vi.spyOn(adapter.provider, "viewNodeStatus").mockResolvedValue({
    chain_id: "testnet",
  } as any);
  vi.spyOn(adapter.provider, "viewAccount").mockResolvedValue({
    code_hash: adapter.deployment.controllerCodeHash,
  } as any);
  vi.spyOn(adapter, "view").mockImplementation(async (method) =>
    method === "get_config" ? config : market,
  );
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(JSON.stringify({ result: "0xaa36a7" })),
  );
  return { config, market };
}
it("accepts version 3 deployed artifacts independently of local rebuild pins and rejects wrong chain artifacts", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const fixture = await manifest({ version: 3, artifacts: selectedV3 });
  const adapter = (await PublicCoordinator.fromFile(fixture.path))!;
  const actual = deployed(adapter, selectedV3);
  expect(await adapter.readiness({ fresh: true })).toEqual([]);
  expect(adapter.artifactHashes).toEqual(selectedV3);
  for (const field of ["collateral", "settlement"] as const) {
    actual.config.wasm_sha256 = selectedV3.collateral;
    actual.market.settlement_wasm_sha256 = selectedV3.settlement;
    if (field === "collateral") actual.config.wasm_sha256 = "ff".repeat(32);
    else actual.market.settlement_wasm_sha256 = "ff".repeat(32);
    expect(await adapter.readiness({ fresh: true })).toContain(
      "Public deployment immutable configuration mismatch",
    );
    vi.setSystemTime(Date.now() + 30000);
  }
  vi.mocked(adapter.provider.viewAccount).mockResolvedValue({
    code_hash: "2".repeat(32),
  } as any);
  expect((await adapter.readiness({ fresh: true })).join()).toContain(
    "code hash",
  );
});
it.each([
  undefined,
  null,
  [],
  { ...selectedV3, collateral: "AA".repeat(32) },
  { ...selectedV3, collateral: "0x" + selectedV3.collateral },
  { ...selectedV3, collateral: "12".repeat(31) },
  { ...selectedV3, settlement: 1 },
  { ...selectedV3, controller: "gg".repeat(32) },
  { collateral: selectedV3.collateral, settlement: selectedV3.settlement },
  { ...selectedV3, signer: "forbidden" },
])(
  "rejects malformed version 3 artifact bindings before RPC (%j)",
  async (artifacts) => {
    const fixture = await manifest({ version: 3, artifacts });
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(PublicCoordinator.fromFile(fixture.path)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  },
);
it("rejects a version 3 controller artifact inconsistent with its NEAR code hash", async () => {
  const fixture = await manifest({
    version: 3,
    artifacts: { ...selectedV3, controller: "ff".repeat(32) },
  });
  await expect(PublicCoordinator.fromFile(fixture.path)).rejects.toThrow(
    "controller artifact",
  );
});
it("accepts a nonzero version 3 controller hash in NEAR base58 form", async () => {
  const artifacts = { ...selectedV3, controller: "00".repeat(31) + "ff" };
  const fixture = await manifest({
    version: 3,
    artifacts,
    controllerCodeHash: "1".repeat(31) + "5Q",
  });
  const adapter = (await PublicCoordinator.fromFile(fixture.path))!;
  deployed(adapter, artifacts);
  expect(await adapter.readiness({ fresh: true })).toEqual([]);
  expect(adapter.artifactHashes.controller).toBe(artifacts.controller);
});
it.each([
  { network: "mainnet" },
  { borrowerId: "borrower.near" },
  { collateralUrl: "http://published.example/collateral.wasm" },
])(
  "version 3 keeps strict schema, testnet and HTTPS boundaries (%j)",
  async (extra) => {
    const fixture = await manifest({
      version: 3,
      artifacts: selectedV3,
      ...extra,
    });
    await expect(PublicCoordinator.fromFile(fixture.path)).rejects.toThrow();
  },
);
it("does not permit artifact overrides in the version 2 schema", async () => {
  const fixture = await manifest({ artifacts: selectedV3 });
  await expect(PublicCoordinator.fromFile(fixture.path)).rejects.toThrow(
    "schema",
  );
});
it("keeps version 2 readiness, exact journal directory, history and a no-hash claim across local rebuilds", async () => {
  const fixture = await manifest();
  const first = (await PublicCoordinator.fromFile(fixture.path))!;
  expect(first.directory).toBe(fixture.directory);
  const journal = await OperationJournal.open(
    join(first.directory, "operations.json"),
    {
      controllerId: first.deployment.controllerId,
    },
  );
  const claimId = "f0578640-2bf8-4187-b4e1-b80c0d0e5e11";
  const claim = {
    id: claimId,
    action: "claim" as const,
    role: "lender" as const,
  };
  for (let index = 0; index < 11; index++) {
    const request =
      index === 10
        ? claim
        : {
            id: randomUUID(),
            action: "borrow" as const,
            role: "borrower" as const,
          };
    const action: WalletAction = {
      chain: "near",
      receiverId: first.deployment.controllerId,
      methodName: index === 10 ? "claim_credit" : "borrow",
      args: {},
      gas: "300000000000000",
      deposit: "1",
    };
    await journal.start(request);
    await journal.update(request.id, (record) => {
      record.preparation = { phase: "prepared", detail: "prepared" };
      record.steps = [
        {
          expected: {
            chain: "near",
            action,
            signerId: index === 10 ? "lender.testnet" : "borrower.testnet",
            minimumBlock: "100",
          },
          started: true,
          observation: "submission-started",
          hashes:
            index === 10
              ? []
              : [
                  {
                    hash: "1".repeat(31) + "23456789AB"[index],
                    status: "succeeded",
                    detail: HASH_DETAILS.succeeded,
                  },
                ],
        },
      ];
      record.prepared = { walletActions: [action] };
    });
  }
  const journalBytes = await readFile(journal.path, "utf8");
  const fetch = vi.spyOn(globalThis, "fetch");
  const reopened = (await PublicCoordinator.fromFile(fixture.path))!;
  expect(reopened.directory).toBe(fixture.directory);
  expect(JSON.stringify(reopened.deployment)).toBe(fixture.bytes);
  expect(reopened.operations.list()).toHaveLength(11);
  expect(reopened.operations.receipts()).toHaveLength(10);
  const result = await reopened.operations.create(claim);
  expect(result.walletActions).toBeUndefined();
  expect(result.operation).toMatchObject({
    id: claimId,
    stage: "needs-check",
    unresolved: true,
    continued: false,
    steps: [{ started: true, hashes: [] }],
  });
  expect(await reopened.operations.reconcile(claimId)).toEqual(
    result.operation,
  );
  await expect(
    reopened.operations.create({ ...claim, id: randomUUID() }),
  ).rejects.toThrow("unresolved");
  expect(await readFile(journal.path, "utf8")).toBe(journalBytes);
  expect(fetch).not.toHaveBeenCalled();
  deployed(reopened, reviewedV2);
  expect(await reopened.readiness({ fresh: true })).toEqual([]);
  expect(reopened.artifactHashes).toEqual(reviewedV2);
});
it.each([2, 3])(
  "public config reports selected version %i artifact bindings",
  async (version) => {
    const fixture = await manifest(
      version === 3 ? { version, artifacts: selectedV3 } : {},
    );
    const adapter = (await PublicCoordinator.fromFile(fixture.path))!;
    vi.spyOn(adapter, "readiness").mockResolvedValue([]);
    const app = await createApp({
      publicEngine: adapter,
      origin: "http://127.0.0.1:3002",
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/config",
        headers: { host: "127.0.0.1:3002" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().artifactHashes).toEqual(
        version === 3 ? selectedV3 : reviewedV2,
      );
    } finally {
      await app.close();
    }
  },
);
it("local config continues to report the rebuilt local artifacts", async () => {
  const app = await createApp({
    origin: "http://127.0.0.1:3002",
    engine: {
      manifest: {
        nearUrl: "http://127.0.0.1:54321",
        anvilUrl: "http://127.0.0.1:54322",
      },
    } as unknown as LocalCoordinator,
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/config",
      headers: { host: "127.0.0.1:3002" },
    });
    expect(response.json().artifactHashes).toEqual({
      collateral: "aa".repeat(32),
      settlement: "bb".repeat(32),
      controller: "cc".repeat(32),
    });
  } finally {
    await app.close();
  }
});

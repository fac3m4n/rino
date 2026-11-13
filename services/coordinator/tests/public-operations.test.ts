/** Real durable store and verifier, with controlled SDK/RPC boundaries; no network or signing. */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider } from "near-api-js";
import {
  PublicOperations,
  type OperationPreparation,
} from "../src/public-operations.ts";
import {
  OperationJournal,
  HASH_DETAILS,
  type ExpectedStep,
} from "../src/operations.ts";
import { ReceiptVerifier } from "../src/receipt-verifier.ts";
import type { OperationRequest } from "../src/operations-api.ts";
import type { State } from "../src/api.ts";
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const ID = "12345678-1234-4234-8234-123456789abc",
  ID2 = "22345678-1234-4234-8234-123456789abc";
const H = "11111111111111111111111111111111",
  B = "11111111111111111111111111111112",
  R = "11111111111111111111111111111113";
const binding = {
  controllerId: "controller.testnet",
  borrowerId: "borrower.testnet",
  lenderId: "lender.testnet",
};
const request: OperationRequest = { id: ID, action: "prove", role: "borrower" };
function expected(
  methodName = "request_proof",
  signerId = "borrower.testnet",
): ExpectedStep {
  return {
    chain: "near",
    signerId,
    minimumBlock: "100",
    action: {
      chain: "near",
      receiverId: "controller.testnet",
      methodName,
      args: methodName === "request_proof" ? { bundle: { height: "7" } } : {},
      gas: "300000000000000",
      deposit: "0",
    },
  };
}
function outcome(
  id: string,
  executor: string,
  status: unknown,
  children: string[] = [],
) {
  return {
    id,
    block_hash: B,
    proof: [],
    outcome: {
      executor_id: executor,
      status,
      receipt_ids: children,
      logs: [],
      gas_burnt: 100,
      tokens_burnt: "500",
      metadata: { version: 1, gas_profile: null },
    },
  };
}
function transaction(
  hash = H,
  method = "request_proof",
  accepted = true,
  signer = "borrower.testnet",
) {
  const call = {
    method_name: method,
    args:
      method === "request_proof"
        ? "eyJidW5kbGUiOnsiaGVpZ2h0IjoiNyJ9fQ=="
        : "e30=",
    gas: 300000000000000,
    deposit: "0",
  };
  const value =
    method === "request_proof" ? (accepted ? "dHJ1ZQ==" : "ZmFsc2U=") : "";
  return {
    final_execution_status: "FINAL",
    transaction: {
      hash,
      signer_id: signer,
      receiver_id: "controller.testnet",
      nonce: 7,
      priority_fee: 0,
      public_key: `ed25519:${H}`,
      signature: `ed25519:${H}`,
      actions: [{ FunctionCall: call }],
    },
    transaction_outcome: outcome(hash, signer, { SuccessReceiptId: R }, [R]),
    receipts_outcome: [
      outcome(R, "controller.testnet", { SuccessValue: value }),
    ],
    receipts: [
      {
        predecessor_id: signer,
        receiver_id: "controller.testnet",
        receipt_id: R,
        priority: 0,
        receipt: {
          Action: {
            signer_id: signer,
            signer_public_key: `ed25519:${H}`,
            gas_price: "5",
            output_data_receivers: [],
            input_data_ids: [],
            actions: [{ FunctionCall: call }],
          },
        },
      },
    ],
    status: { SuccessValue: value },
  };
}
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "public-operations-"));
  dirs.push(dir);
  const path = join(dir, "operations.json");
  let journal = await OperationJournal.open(path, binding);
  let now = 100000,
    mode: "success" | "false" | "pending" | "missing" | "wrong" = "success";
  const calls: Array<[string, unknown]> = [];
  let prepared = 0,
    ready = 0;
  let ethereumCalls = 0;
  let height = 101;
  let changeTransaction:
    ((tx: ReturnType<typeof transaction>) => void) | undefined;
  let readinessErrors: string[] = [];
  let prepare: (
    request: OperationRequest,
    beforeRelay: (e: ExpectedStep) => Promise<void>,
  ) => Promise<OperationPreparation> = async () => {
    prepared++;
    expect(
      JSON.parse(await readFile(path, "utf8")).operations[0].preparation.phase,
    ).toBe("preparing");
    return {
      steps: [expected()],
      walletActions: [
        (expected() as Extract<ExpectedStep, { chain: "near" }>).action,
      ],
    };
  };
  let state = {
    ready: true,
    busy: false,
    settlement: { pending: null },
    proofStatus: "Idle",
  } as unknown as State;
  const provider = new JsonRpcProvider({ url: "https://unused.invalid" });
  provider.sendJsonRpc = (async (method: string, params: any) => {
    calls.push([method, params]);
    if (method === "block") return { header: { hash: B, height } };
    if (method !== "EXPERIMENTAL_tx_status") throw Error("unexpected read");
    if (mode === "missing") throw Error("https://secret.invalid/credential");
    const tx = transaction(
      params.tx_hash,
      "request_proof",
      mode !== "false",
      mode === "wrong" ? "intruder.testnet" : "borrower.testnet",
    );
    if (mode === "pending") tx.final_execution_status = "EXECUTED_OPTIMISTIC";
    changeTransaction?.(tx);
    return tx;
  }) as typeof provider.sendJsonRpc;
  const verifier = new ReceiptVerifier({
    near: provider,
    ethereum: async () => {
      ethereumCalls++;
      throw Error("unexpected Ethereum");
    },
  });
  const construct = () =>
    new PublicOperations({
      journal,
      verifier,
      binding,
      prepare: (r, b) => prepare(r, b),
      readiness: async () => {
        ready++;
        return readinessErrors;
      },
      state: async () => state,
      now: () => now,
    });
  let service = construct();
  return {
    path,
    calls,
    get journal() {
      return journal;
    },
    get service() {
      return service;
    },
    get prepared() {
      return prepared;
    },
    get ready() {
      return ready;
    },
    get ethereumCalls() {
      return ethereumCalls;
    },
    mutateTransaction: (change: typeof changeTransaction) => {
      changeTransaction = change;
    },
    setHeight: (value: number) => {
      height = value;
    },
    setReadiness: (errors: string[]) => {
      readinessErrors = errors;
    },
    setMode: (value: typeof mode) => {
      mode = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    setPrepare: (value: typeof prepare) => {
      prepare = value;
    },
    setState: (value: State) => {
      state = value;
    },
    async reload() {
      journal = await OperationJournal.open(path, binding);
      service = construct();
    },
  };
}
const waitingMessage = (block: string) =>
  `Captured block ${block}; awaiting both fixed providers finalized coverage before wallet request`;
const finalityDetail =
  "Preparation stopped while awaiting an eligible finalized checkpoint on both fixed providers. No wallet request was made. Refresh chain state and try again when finality has advanced.";
const genericPreparationDetail =
  "Preparation failed. No wallet request was made. Refresh chain state and review operation history before trying again.";

it.each(["0", "12125413", "9".repeat(78)])(
  "persists only safe finality-wait feedback for exact coordinator block %s and never prepares again on reopen",
  async (block) => {
    const f = await fixture();
    let preparations = 0;
    f.setPrepare(async () => {
      preparations++;
      throw new Error(waitingMessage(block), {
        cause: new Error("https://rpc.invalid/?key=synthetic-secret"),
      });
    });
    const first = await f.service.create({ ...request, action: "settle" });
    expect(first).toEqual({
      operation: expect.objectContaining({
        stage: "failed",
        unresolved: false,
        detail: finalityDetail,
        steps: [],
      }),
    });
    const disk = await readFile(f.path, "utf8");
    expect(JSON.parse(disk).operations[0].preparation).toEqual({
      phase: "failed",
      detail: "awaiting-finality",
    });
    expect(disk).not.toContain("synthetic-secret");
    expect(disk).not.toContain("Captured block");
    expect(JSON.stringify(first)).not.toContain("rpc.invalid");
    await f.reload();
    expect(f.service.list()[0].detail).toBe(finalityDetail);
    expect(await f.service.create({ ...request, action: "settle" })).toEqual(
      first,
    );
    expect(preparations).toBe(1);
    expect(f.calls).toEqual([]);
    expect(f.ethereumCalls).toBe(0);
  },
);

const throwingMessage = Object.defineProperty(new Error(), "message", {
  get() {
    throw new Error("synthetic-secret accessor");
  },
});
const throwingDescriptor = new Proxy(new Error(), {
  getOwnPropertyDescriptor() {
    throw new Error("synthetic-secret descriptor");
  },
});
const throwingPrototype = new Proxy(new Error(), {
  getPrototypeOf() {
    throw new Error("synthetic-secret prototype");
  },
});
it.each([
  ["throwing message accessor", throwingMessage],
  ["throwing descriptor proxy", throwingDescriptor],
  ["throwing prototype proxy", throwingPrototype],
  ["URL and key", new Error("https://rpc.invalid/?key=synthetic-secret")],
  ["prefix", new Error(`synthetic-secret: ${waitingMessage("42")}`)],
  ["suffix", new Error(`${waitingMessage("42")} synthetic-secret`)],
  ["trailing newline", new Error(`${waitingMessage("42")}\n`)],
  ["leading zero", new Error(waitingMessage("042"))],
  ["negative block", new Error(waitingMessage("-1"))],
  ["noninteger block", new Error(waitingMessage("42.5"))],
  ["overlong block", new Error(waitingMessage("9".repeat(79)))],
  [
    "different provider wording",
    new Error(waitingMessage("42").replace("both fixed", "one fixed")),
  ],
  ["string exception", waitingMessage("42")],
  [
    "arbitrary object",
    { message: waitingMessage("42"), key: "synthetic-secret" },
  ],
  [
    "nested cause",
    new Error("synthetic-secret", { cause: new Error(waitingMessage("42")) }),
  ],
])(
  "keeps unrecognized preparation error (%s) generic without exposing raw exception data",
  async (_label, error) => {
    const f = await fixture();
    f.setPrepare(async () => {
      throw error;
    });
    const result = await f.service.create(request);
    expect(result).toEqual({
      operation: expect.objectContaining({
        stage: "failed",
        unresolved: false,
        detail: genericPreparationDetail,
        steps: [],
      }),
    });
    const disk = await readFile(f.path, "utf8");
    expect(JSON.parse(disk).operations[0].preparation).toEqual({
      phase: "failed",
      detail: "failed",
    });
    expect(disk).not.toContain("synthetic-secret");
    expect(disk).not.toContain("rpc.invalid");
    expect(disk).not.toContain("Captured block");
    await f.reload();
    expect(f.service.list()[0].detail).toBe(genericPreparationDetail);
    expect(f.calls).toEqual([]);
  },
);

it("persists before preparation and returns the same frozen actions after a lost response/restart", async () => {
  const f = await fixture();
  const first = await f.service.create(request);
  expect(first.walletActions?.[0].args).toEqual({ bundle: { height: "7" } });
  expect(
    JSON.parse(await readFile(f.path, "utf8")).operations[0].steps[0].expected
      .minimumBlock,
  ).toBe("100");
  await f.reload();
  expect(await f.service.create(request)).toEqual(first);
  expect(f.prepared).toBe(1);
  await f.service.observe(ID, { step: 0, event: "submission-started" });
  await f.reload();
  expect(await f.service.create(request)).not.toHaveProperty("walletActions");
  expect(f.prepared).toBe(1);
  expect(f.service.list()[0].unresolved).toBe(true);
});
it("stores safe wallet observations through reload without treating rejection as a chain verdict", async () => {
  const f = await fixture();
  await f.service.create(request);
  await f.service.observe(ID, { step: 0, event: "submission-started" });
  await f.service.observe(ID, {
    step: 0,
    event: "wallet-unknown",
    diagnostic: { category: "timeout", name: "TimeoutError", code: "TIMEOUT" },
  });
  await f.reload();
  expect(f.service.list()[0]).toMatchObject({
    stage: "needs-check",
    steps: [
      {
        diagnostic: {
          category: "timeout",
          name: "TimeoutError",
          code: "TIMEOUT",
        },
      },
    ],
  });
  expect(f.calls).toEqual([]);
  expect(() =>
    f.service.observe(ID, {
      step: 0,
      event: "wallet-unknown",
      diagnostic: { category: "unknown", name: "https://secret.invalid" },
    }),
  ).toThrow();
});
it("rejects a known wrong hash before storing it, preserving the slot for a correctly bound transaction", async () => {
  const f = await fixture();
  await f.service.create(request);
  f.setMode("wrong");
  await expect(
    f.service.observe(ID, { step: 0, event: "hash", hash: H }),
  ).rejects.toThrow("match");
  expect(f.journal.get(ID)?.steps[0].hashes).toEqual([]);
  f.setMode("success");
  const view = await f.service.observe(ID, { step: 0, event: "hash", hash: B });
  expect(view.stage).toBe("succeeded");
  expect(view.steps[0].hashes[0]).toMatchObject({
    hash: B,
    status: "succeeded",
    blockNumber: "101",
  });
});
it("preserves unknown evidence, refuses replacement and never prepares during reconciliation", async () => {
  const f = await fixture();
  await f.service.create(request);
  f.setMode("missing");
  const view = await f.service.observe(ID, { step: 0, event: "hash", hash: H });
  expect(view.stage).toBe("needs-check");
  await expect(
    f.service.observe(ID, { step: 0, event: "hash", hash: B }),
  ).rejects.toThrow("capacity");
  await f.reload();
  expect((await f.service.reconcile(ID)).steps[0].hashes).toHaveLength(1);
  expect(f.prepared).toBe(1);
  expect(JSON.stringify(f.service.list())).not.toContain("secret.invalid");
});
it("reuses terminal verdicts and rejects callback false as acceptance failure", async () => {
  const f = await fixture();
  await f.service.create(request);
  f.setMode("false");
  expect(
    (await f.service.observe(ID, { step: 0, event: "hash", hash: H })).steps[0]
      .hashes[0],
  ).toMatchObject({ status: "failed", detail: HASH_DETAILS.acceptanceFailed });
  const count = f.calls.length;
  f.advance(60000);
  expect((await f.service.reconcile(ID)).stage).toBe("failed");
  expect(f.calls).toHaveLength(count);
});
it("coalesces concurrent reconciliation, honors 5s TTL and 30s unavailable cooldown", async () => {
  const f = await fixture();
  await f.service.create(request);
  f.setMode("pending");
  await f.service.observe(ID, { step: 0, event: "hash", hash: H });
  f.advance(5000);
  const count = f.calls.length;
  const values = await Promise.all(
    Array.from({ length: 8 }, () => f.service.reconcile(ID)),
  );
  expect(values.every((v) => v.stage === "processing")).toBe(true);
  expect(f.calls.length - count).toBe(2);
  await f.service.reconcile(ID);
  expect(f.calls.length - count).toBe(2);
  f.advance(5000);
  f.setMode("missing");
  await f.service.reconcile(ID);
  const failedCount = f.calls.length;
  f.advance(29999);
  await f.service.reconcile(ID);
  expect(f.calls).toHaveLength(failedCount);
  f.advance(1);
  await f.service.reconcile(ID);
  expect(f.calls).toHaveLength(failedCount + 1);
});
it("requires a fresh ready idle state for continuation and preserves original evidence", async () => {
  const f = await fixture();
  await f.service.create(request);
  await f.service.observe(ID, { step: 0, event: "wallet-unknown" });
  await expect(f.service.create({ ...request, id: ID2 })).rejects.toThrow(
    "unresolved",
  );
  for (const change of [
    { ready: false },
    { busy: true },
    { settlement: { pending: { id: "7" } } },
    { proofStatus: "Deriving" },
    { proofStatus: "ProofPending" },
  ]) {
    f.setState({
      ready: true,
      busy: false,
      settlement: { pending: null },
      proofStatus: "Idle",
      ...change,
    } as unknown as State);
    await expect(f.service.continue(ID)).rejects.toThrow("idle");
  }
  f.setState({
    ready: true,
    busy: false,
    settlement: { pending: null },
    proofStatus: "Idle",
  } as unknown as State);
  expect(await f.service.continue(ID)).toMatchObject({
    continued: true,
    unresolved: true,
    stage: "needs-check",
  });
  expect((await f.service.create({ ...request, id: ID2 })).operation.id).toBe(
    ID2,
  );
  expect(f.journal.get(ID)?.steps[0].started).toBe(true);
});
it("imports historical receipts separately without preparation or clearing a paused operation", async () => {
  const f = await fixture();
  await f.service.create(request);
  await f.service.observe(ID, { step: 0, event: "wallet-unknown" });
  const historical = await f.service.import({ ...request, id: ID2, hash: H });
  expect(historical).toMatchObject({ historical: true, stage: "succeeded" });
  expect(f.prepared).toBe(1);
  expect(f.calls).toHaveLength(2);
  expect(f.service.list()[0]).toMatchObject({
    id: ID,
    unresolved: true,
    continued: false,
  });
});
it("caches failed historical checks by hash/context across changed operation IDs", async () => {
  const f = await fixture();
  f.setMode("missing");
  await expect(f.service.import({ ...request, hash: H })).rejects.toThrow();
  const count = f.calls.length;
  await expect(
    f.service.import({ ...request, id: ID2, hash: H }),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(count);
  expect(f.service.list()).toEqual([]);
});
it.each(["lost response with credentials", waitingMessage("12125413")])(
  "preserves a server relay before a thrown response (%s) and never invokes preparation again after restart",
  async (message) => {
    const f = await fixture();
    let broadcasts = 0;
    f.setPrepare(async (_r, beforeRelay) => {
      await beforeRelay({
        chain: "ethereum",
        kind: "relay",
        intent: {
          chainId: "11155111",
          from: `0x${"11".repeat(20)}`,
          to: `0x${"22".repeat(20)}`,
          valueWei: "42",
          data: "0x",
        },
        nonce: "7",
        candidateHash: `0x${"33".repeat(32)}`,
      });
      expect(
        JSON.parse(await readFile(f.path, "utf8")).operations[0].steps[0]
          .hashes[0].hash,
      ).toBe(`0x${"33".repeat(32)}`);
      broadcasts++;
      throw Error(message);
    });
    expect(
      (await f.service.create({ ...request, action: "settle" })).operation,
    ).toMatchObject({
      stage: "needs-check",
      unresolved: true,
      detail: "Submission is unresolved; check known evidence.",
      steps: [{ started: true, hashes: [{ hash: `0x${"33".repeat(32)}` }] }],
    });
    expect(f.journal.get(ID)!.preparation).toEqual({
      phase: "interrupted",
      detail: "interrupted",
    });
    await f.reload();
    expect(
      await f.service.create({ ...request, action: "settle" }),
    ).not.toHaveProperty("walletActions");
    expect(broadcasts).toBe(1);
  },
);
it("keeps partial batch success separate from a later unknown step", async () => {
  const f = await fixture();
  f.setPrepare(async () => ({ steps: [expected(), expected("borrow")] }));
  await f.service.create(request);
  await f.service.observe(ID, { step: 0, event: "hash", hash: H });
  await f.service.observe(ID, { step: 1, event: "wallet-unknown" });
  await f.reload();
  expect(f.service.list()[0]).toMatchObject({
    stage: "partial",
    unresolved: true,
    steps: [{ status: "succeeded" }, { status: "needs-check" }],
  });
});
it("limits queued requests to four while preparation is blocked", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setPrepare(async () => {
    await gate;
    return { steps: [expected()] };
  });
  const first = f.service.create(request);
  const queued = [
    f.service.create(request),
    f.service.create(request),
    f.service.create(request),
  ];
  await expect(f.service.create(request)).rejects.toThrow("queue full");
  release();
  await Promise.all([first, ...queued]);
  expect(f.service.list()).toHaveLength(1);
});

it("finishes interrupted relay preparation only after its exact candidate is independently finalized", async () => {
  const f = await fixture();
  const journal = f.journal;
  await journal.start(request);
  await journal.update(ID, (r) => {
    r.preparation = { phase: "interrupted", detail: "interrupted" };
    r.steps = [
      {
        expected: expected(),
        started: true,
        hashes: [{ hash: H, status: "hint", detail: HASH_DETAILS.recorded }],
      },
    ];
  });
  const view = await f.service.reconcile(ID);
  expect(view).toMatchObject({ stage: "succeeded", unresolved: false });
});

it("records a hash as unresolved when deployment readiness is unavailable, without transaction RPC", async () => {
  const f = await fixture();
  await f.service.create(request);
  f.setReadiness(["wrong binding"]);
  expect(
    await f.service.observe(ID, { step: 0, event: "hash", hash: H }),
  ).toMatchObject({
    stage: "needs-check",
    steps: [
      {
        hashes: [{ hash: H, status: "hint", detail: HASH_DETAILS.unavailable }],
      },
    ],
  });
  await f.service.reconcile(ID);
  expect(f.calls).toEqual([]);
});

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, parseTransaction, serializeTransaction } from "viem";
import { PublicCoordinator } from "../src/public.ts";
import { PINS } from "../src/local.ts";
/** Throwaway synthetic key only, never funded and never sent to a network. */
async function adapterFixture() {
  vi.stubEnv("NEAR_TESTNET_RPC_URL", undefined);
  vi.stubEnv(
    "ALCHEMY_SEPOLIA_RPC_URL",
    "https://eth-sepolia.g.alchemy.com/v2/operation-synthetic-key",
  );
  const dir = await mkdtemp(join(tmpdir(), "operation-adapter-"));
  dirs.push(dir);
  const deployment = {
    version: 2,
    controllerId: `ops-${randomUUID().slice(0, 18)}.testnet`,
    borrowerId: "borrower.testnet",
    lenderId: "lender.testnet",
    borrowerRecipient: `0x${"11".repeat(20)}`,
    lenderRecipient: `0x${"22".repeat(20)}`,
    operationDeposit: "7000100000000000000000",
    controllerCodeHash: H,
    collateralUrl: "https://published.example/collateral.wasm",
    settlementUrl: "https://published.example/settlement.wasm",
  };
  const manifest = join(dir, "manifest.json");
  await writeFile(manifest, JSON.stringify(deployment));
  const account = privateKeyToAccount(generatePrivateKey());
  const packet = {
    type: "eip1559" as const,
    chainId: 11155111,
    nonce: 7,
    to: deployment.borrowerRecipient as `0x${string}`,
    value: 42n,
    gas: 21000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 2n,
    data: "0x" as const,
    accessList: [],
  };
  const raw = await account.signTransaction(packet),
    parsed = parseTransaction(raw),
    candidate = {
      raw,
      hash: keccak256(raw),
      signing_digest: keccak256(serializeTransaction(packet)),
      r: parsed.r!,
      s: parsed.s!,
      y_parity: String(parsed.yParity),
    };
  const market = {
    phase: "Offered",
    borrower: deployment.borrowerId,
    lender: deployment.lenderId,
    vault: account.address.toLowerCase(),
    borrower_recipient: deployment.borrowerRecipient,
    lender_recipient: deployment.lenderRecipient,
    settlement_wasm_url: deployment.settlementUrl,
    settlement_wasm_sha256: PINS.settlement,
    terms: {
      version: "1",
      principal_units: "100000000",
      fee_units: "1000000",
      debt_units: "101000000",
      reference_units_per_eth: "2000000000",
      max_ltv_bps: "5000",
      term_seconds: "86400",
      fee_cap_wei_per_gas: "100000000000",
      gas_limit: "21000",
      initial_fee_budget_wei: "12600000000000000",
    },
    available_liquidity_units: "0",
    lender_claim_units: "0",
    debt_units: "0",
    borrowed_at: null,
    maturity: null,
    borrower_balance_units: "0",
    lender_balance_units: "1000000000",
    escrow_balance_units: "0",
    proof_timestamp: null,
    proof_fresh: false,
    pending_reason: "",
  };
  const settlement = {
    stage: "Idle",
    branch: null,
    expected_nonce: "7",
    balance_wei: "0",
    accounted_balance_wei: "0",
    unallocated_incoming_wei: "0",
    remaining_fee_budget_wei: "0",
    fees_paid_wei: "0",
    lender_cap_wei: "0",
    lender_paid_wei: "0",
    remaining_lender_cap_wei: "0",
    recovered_credit_units: "0",
    shortfall_credit_units: "0",
    borrower_surplus_wei: "0",
    checkpoint_block_number: null,
    current_intent: null,
    candidate_count: 0,
    last_confirmation: null,
    pending: null,
    pending_reason: "",
    retired: false,
  } as unknown as NonNullable<State["settlement"]>;
  let balance = "0x16345785d8a0000",
    receiptVisible = false,
    loseBroadcast = false,
    providerDown = false;
  const latest = ["0x64", "0x66"];
  const transactions = new Map<string, unknown>();
  const receipts = new Map<string, unknown>();
  let ethereumMutation:
    | ((provider: number, method: string, params: any, result: any) => unknown)
    | undefined;
  const calls: Array<{ provider: number; method: string; params: any }> = [];
  let adapter = (await PublicCoordinator.fromFile(manifest))!;
  dirs.push(adapter.directory);
  const opPath = join(adapter.directory, "operations.json");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const q = JSON.parse(String(init?.body));
    const near = String(url).includes("drpc");
    const provider = near ? 2 : String(url).includes("publicnode") ? 0 : 1;
    calls.push({ provider, method: q.method, params: q.params });
    let result: unknown;
    if (near) {
      if (q.method === "EXPERIMENTAL_tx_status") {
        const tx = transaction(
          q.params.tx_hash,
          "ft_transfer",
          true,
          "lender.testnet",
        );
        tx.transaction.receiver_id = deployment.controllerId;
        const args = Buffer.from(
          JSON.stringify({
            receiver_id: "borrower.testnet",
            amount: "1000000",
          }),
        ).toString("base64");
        tx.transaction.actions[0].FunctionCall.args = args;
        tx.transaction.actions[0].FunctionCall.deposit = "1";
        tx.receipts_outcome[0].outcome.executor_id = deployment.controllerId;
        tx.receipts[0].receiver_id = deployment.controllerId;
        tx.receipts[0].receipt.Action.actions[0].FunctionCall.args = args;
        tx.receipts[0].receipt.Action.actions[0].FunctionCall.deposit = "1";
        result = tx;
      } else if (q.method === "status")
        result = {
          version: {
            version: "synthetic",
            build: "synthetic",
            rustc_version: "synthetic",
          },
          chain_id: "testnet",
          protocol_version: 84,
          latest_protocol_version: 84,
          rpc_addr: "0.0.0.0:3030",
          validators: [],
          sync_info: {
            latest_block_hash: B,
            latest_block_height: 200,
            latest_state_root: B,
            latest_block_time: "2026-11-13T00:00:00Z",
            syncing: false,
          },
          validator_account_id: null,
        };
      else if (q.method === "block")
        result = {
          author: "validator.testnet",
          header: {
            hash: B,
            height: q.params.block_id ? 201 : 200,
            timestamp_nanosec: "1794528000000000000",
          },
          chunks: [],
        };
      else if (q.method === "query" && q.params.request_type === "view_account")
        result = {
          amount: "1",
          locked: "0",
          code_hash: H,
          storage_usage: 1000,
          storage_paid_at: 0,
          block_height: 200,
          block_hash: B,
        };
      else if (
        q.method === "query" &&
        q.params.request_type === "call_function"
      ) {
        const values: Record<string, unknown> = {
          get_config: {
            borrower: deployment.borrowerId,
            executor: "outlayer.testnet",
            mpc: "v1.signer-prod.testnet",
            wasm_url: deployment.collateralUrl,
            wasm_sha256: PINS.collateral,
            network: "NearTestnet",
            operation_deposit: deployment.operationDeposit,
          },
          get_market: market,
          get_settlement: settlement,
          get_status: "Idle",
          get_evidence: null,
          ft_total_supply: "1000000000",
          get_signed_transactions: [candidate],
        };
        if (!(q.params.method_name in values))
          throw Error("unexpected NEAR method");
        result = {
          result: Array.from(
            Buffer.from(JSON.stringify(values[q.params.method_name])),
          ),
          logs: [],
          block_height: 200,
          block_hash: B,
        };
      } else throw Error(`unexpected NEAR RPC ${q.method}`);
    } else {
      if (providerDown) throw Error("synthetic credential=never-public");
      if (q.method === "eth_chainId") result = "0xaa36a7";
      else if (q.method === "eth_getBalance") result = balance;
      else if (q.method === "eth_getTransactionCount") result = "0x7";
      else if (q.method === "eth_getTransactionReceipt")
        result = receipts.has(q.params[0])
          ? receipts.get(q.params[0])
          : receiptVisible
            ? {
                transactionHash: candidate.hash,
                transactionIndex: "0x0",
                blockHash: `0x${"aa".repeat(32)}`,
                blockNumber: "0x64",
                from: market.vault,
                to: deployment.borrowerRecipient,
                cumulativeGasUsed: "0x5208",
                gasUsed: "0x5208",
                effectiveGasPrice: "0x2",
                contractAddress: null,
                logs: [],
                logsBloom: `0x${"00".repeat(256)}`,
                status: "0x1",
                type: "0x2",
              }
            : null;
      else if (q.method === "eth_getTransactionByHash")
        result = transactions.has(q.params[0])
          ? transactions.get(q.params[0])
          : {
              hash: candidate.hash,
              chainId: "0xaa36a7",
              from: market.vault,
              to: deployment.borrowerRecipient,
              value: "0x2a",
              input: "0x",
              nonce: "0x7",
              blockNumber: "0x64",
              blockHash: `0x${"aa".repeat(32)}`,
              transactionIndex: "0x0",
              type: "0x2",
              gas: "0x5208",
              maxFeePerGas: "0x2",
              maxPriorityFeePerGas: "0x2",
              v: "0x1",
              r: parsed.r,
              s: parsed.s,
            };
      else if (q.method === "eth_getBlockByNumber")
        result = {
          number:
            q.params[0] === "latest"
              ? latest[provider]
              : q.params[0] === "finalized"
                ? "0x70"
                : q.params[0],
          hash: ["0x64", "0x67"].includes(q.params[0])
            ? `0x${"aa".repeat(32)}`
            : `0x${"bb".repeat(32)}`,
          stateRoot: `0x${"cc".repeat(32)}`,
          timestamp: "0x6a000000",
          baseFeePerGas: "0x1",
        };
      else if (q.method === "eth_sendRawTransaction") {
        const stored = JSON.parse(await readFile(opPath, "utf8"));
        expect(stored.operations[0].steps[0]).toMatchObject({
          started: true,
          expected: {
            chain: "ethereum",
            kind: "relay",
            nonce: "7",
            candidateHash: candidate.hash,
          },
          hashes: [{ hash: candidate.hash, status: "hint" }],
        });
        expect(q.params).toEqual([raw]);
        if (loseBroadcast) throw Error("response lost after broadcast");
        result = candidate.hash;
      } else throw Error(`unexpected ETH RPC ${q.method}`);
    }
    if (!near && ethereumMutation)
      result = ethereumMutation(
        provider,
        q.method,
        q.params,
        structuredClone(result),
      );
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
  });
  return {
    get adapter() {
      return adapter;
    },
    calls,
    market,
    settlement,
    latest,
    transactions,
    receipts,
    setEthereumMutation: (change: typeof ethereumMutation) => {
      ethereumMutation = change;
    },
    candidate,
    opPath,
    setBalance: (v: string) => {
      balance = v;
    },
    setReceipt: () => {
      receiptVisible = true;
    },
    setLoseResponse: () => {
      loseBroadcast = true;
    },
    setProviderDown: () => {
      providerDown = true;
    },
    async reload() {
      adapter = (await PublicCoordinator.fromFile(manifest))!;
    },
    prepareRelay() {
      market.phase = "Repaid";
      settlement.current_intent = {
        transfer: {
          chain_id: "11155111",
          nonce: "7",
          to: deployment.borrowerRecipient,
          value: "42",
          gas_limit: "21000",
          gas_price: "2",
        },
        signing_preimage: serializeTransaction(packet),
        signing_digest: candidate.signing_digest,
        before_balance_wei: "42042",
        minimum_block_number: "100",
      };
    },
  };
}
it("derives borrower funding from the live vault shortfall and maximum two-provider head", async () => {
  const f = await adapterFixture();
  const from = `0x${"44".repeat(20)}`;
  const result = await f.adapter.operations.create({
    id: ID,
    action: "fund",
    role: "borrower",
    evmSender: from,
  });
  expect(result.funding).toEqual({
    chainId: "11155111",
    from,
    to: f.market.vault,
    valueWei: "20000000000000000",
    data: "0x",
  });
  expect(
    JSON.parse(await readFile(f.opPath, "utf8")).operations[0].steps[0].expected
      .minimumBlock,
  ).toBe("102");
  expect(
    f.calls.filter(
      (c) => c.method === "eth_getBlockByNumber" && c.params[0] === "latest",
    ),
  ).toHaveLength(2);
  await f.reload();
  expect(
    (
      await f.adapter.operations.create({
        id: ID,
        action: "fund",
        role: "borrower",
        evmSender: from,
      })
    ).funding,
  ).toEqual(result.funding);
});
for (const loseResponse of [false, true])
  it(`recovers actual server relay ${loseResponse ? "lost response" : "before action throws"} without rebroadcasting`, async () => {
    const f = await adapterFixture();
    f.prepareRelay();
    if (loseResponse) f.setLoseResponse();
    expect(
      (
        await f.adapter.operations.create({
          id: ID,
          action: "settle",
          role: "borrower",
        })
      ).operation,
    ).toMatchObject({
      stage: "needs-check",
      unresolved: true,
      steps: [
        {
          method: "relay",
          hashes: [{ hash: f.candidate.hash, status: "hint" }],
        },
      ],
    });
    expect(
      f.calls.filter((c) => c.method === "eth_sendRawTransaction"),
    ).toHaveLength(1);
    await f.reload();
    await f.adapter.operations.create({
      id: ID,
      action: "settle",
      role: "borrower",
    });
    expect(
      f.calls.filter((c) => c.method === "eth_sendRawTransaction"),
    ).toHaveLength(1);
    f.setReceipt();
    const before = f.calls.length;
    const view = await f.adapter.operations.reconcile(ID);
    expect(view).toMatchObject({
      stage: "succeeded",
      unresolved: false,
      steps: [
        {
          hashes: [
            {
              hash: f.candidate.hash,
              status: "succeeded",
              blockNumber: "100",
              gasUsed: "21000",
              feeWei: "42000",
            },
          ],
        },
      ],
    });
    const reads = f.calls.slice(before);
    expect(reads.filter((c) => c.provider === 2)).toHaveLength(4);
    expect(reads.filter((c) => c.method === "eth_chainId")).toHaveLength(2);
    expect(
      reads.filter((c) => c.provider !== 2 && c.method !== "eth_chainId"),
    ).toHaveLength(8);
    const count = f.calls.length;
    await f.adapter.operations.reconcile(ID);
    expect(f.calls).toHaveLength(count);
  });
it("persists exact multi-action NEAR preparation and optimistic floor before exposing wallet actions", async () => {
  const f = await adapterFixture();
  const view = await f.adapter.operations.create({
    id: ID,
    action: "fund",
    role: "lender",
  });
  expect(view.walletActions).toMatchObject([
    {
      methodName: "ft_transfer",
      args: { receiver_id: "borrower.testnet", amount: "1000000" },
      deposit: "1",
    },
    { methodName: "fund_liquidity", deposit: "1" },
  ]);
  const stored = JSON.parse(await readFile(f.opPath, "utf8")).operations[0];
  expect(stored.steps.map((s: any) => s.expected.minimumBlock)).toEqual([
    "200",
    "200",
  ]);
  expect(f.calls[0]).toMatchObject({
    method: "block",
    params: { finality: "optimistic" },
  });
});

for (const fault of [
  "receiver",
  "method",
  "args",
  "gas",
  "deposit",
  "historical-floor",
] as const)
  it(`rejects known NEAR ${fault} mismatch without changing the paused operation`, async () => {
    const f = await fixture();
    await f.service.create(request);
    await f.service.observe(ID, { step: 0, event: "submission-started" });
    if (fault === "historical-floor") f.setHeight(100);
    else
      f.mutateTransaction((tx) => {
        const call = tx.transaction.actions[0].FunctionCall;
        if (fault === "receiver") tx.transaction.receiver_id = "other.testnet";
        if (fault === "method") call.method_name = "borrow";
        if (fault === "args") call.args = "e30=";
        if (fault === "gas") call.gas = 1;
        if (fault === "deposit") call.deposit = "1";
      });
    await expect(
      f.service.observe(ID, { step: 0, event: "hash", hash: H }),
    ).rejects.toThrow("match");
    expect(f.service.list()[0]).toMatchObject({
      unresolved: true,
      steps: [{ hashes: [] }],
    });
  });
it("does not rewrite unchanged pending evidence on each reconciliation cycle", async () => {
  const f = await fixture();
  await f.service.create(request);
  f.setMode("pending");
  await f.service.observe(ID, { step: 0, event: "hash", hash: H });
  const before = await readFile(f.path, "utf8");
  f.advance(5000);
  await f.service.reconcile(ID);
  expect(await readFile(f.path, "utf8")).toBe(before);
});
it("does not resume preparation interrupted before immutable context was captured", async () => {
  const f = await fixture();
  await f.journal.start(request);
  await f.reload();
  expect(await f.service.create(request)).toMatchObject({
    operation: { stage: "needs-check", unresolved: true, steps: [] },
  });
  expect(f.prepared).toBe(0);
  expect(f.calls).toEqual([]);
});
it("refuses a broadcast when its durable relay context cannot be written", async () => {
  const f = await fixture();
  let broadcast = 0;
  f.setPrepare(async (_request, beforeRelay) => {
    await beforeRelay({
      chain: "ethereum",
      kind: "relay",
      intent: {
        chainId: "11155111",
        from: `0x${"11".repeat(20)}`,
        to: `0x${"22".repeat(20)}`,
        valueWei: "42",
        data: "0x",
      },
      nonce: "7",
      candidateHash: `0x${"33".repeat(32)}`,
    });
    broadcast++;
    throw Error("relay returned");
  });
  vi.spyOn(f.journal, "update").mockRejectedValueOnce(
    Error("disk unavailable"),
  );
  expect(
    (await f.service.create({ ...request, action: "settle" })).operation.stage,
  ).toBe("failed");
  expect(broadcast).toBe(0);
  expect(f.journal.get(ID)?.steps).toEqual([]);
});
it("serializes duplicate create requests without preparing twice", async () => {
  const f = await fixture();
  const values = await Promise.all([
    f.service.create(request),
    f.service.create(request),
  ]);
  expect(values[0]).toEqual(values[1]);
  expect(f.prepared).toBe(1);
});
it("preserves actual lender first-step success while the later funding wallet result remains unknown", async () => {
  const f = await adapterFixture();
  await f.adapter.operations.create({ id: ID, action: "fund", role: "lender" });
  const before = f.calls.length;
  expect(
    (
      await f.adapter.operations.observe(ID, {
        step: 0,
        event: "hash",
        hash: H,
      })
    ).steps[0],
  ).toMatchObject({
    status: "succeeded",
    hashes: [{ status: "succeeded", blockNumber: "201" }],
  });
  expect(f.calls.length - before).toBe(8); // readiness: 4 NEAR + 2 ETH; verdict: 2 NEAR
  await f.adapter.operations.observe(ID, {
    step: 1,
    event: "submission-started",
  });
  await f.adapter.operations.observe(ID, {
    step: 1,
    event: "wallet-unknown",
    diagnostic: { category: "timeout", code: "TIMEOUT" },
  });
  await f.reload();
  const count = f.calls.length;
  expect(f.adapter.operations.list()[0]).toMatchObject({
    stage: "partial",
    unresolved: true,
    steps: [
      { status: "succeeded" },
      {
        status: "needs-check",
        diagnostic: { category: "timeout", code: "TIMEOUT" },
      },
    ],
  });
  expect(f.adapter.operations.receipts()).toHaveLength(1);
  expect(f.calls).toHaveLength(count);
});

it("retains operation provider-failure cooldown when another funding hash is observed", async () => {
  const f = await fixture();
  f.setPrepare(async () => ({
    steps: [
      {
        chain: "ethereum",
        kind: "funding",
        intent: {
          chainId: "11155111",
          from: `0x${"11".repeat(20)}`,
          to: `0x${"22".repeat(20)}`,
          valueWei: "42",
          data: "0x",
        },
        minimumBlock: "100",
      },
    ],
  }));
  await f.service.create({
    ...request,
    action: "fund",
    evmSender: `0x${"11".repeat(20)}`,
  });
  await f.service.observe(ID, {
    step: 0,
    event: "hash",
    hash: `0x${"33".repeat(32)}`,
  });
  const count = f.ethereumCalls;
  expect(count).toBe(4);
  await expect(
    f.service.observe(ID, {
      step: 0,
      event: "hash",
      hash: `0x${"44".repeat(32)}`,
    }),
  ).rejects.toThrow("nonce");
  await f.service.reconcile(ID);
  expect(f.ethereumCalls).toBe(count);
});
it("does not extend provider cooldown by serving a cached unavailable result", async () => {
  const f = await fixture();
  await f.service.create(request);
  f.setMode("missing");
  await f.service.observe(ID, { step: 0, event: "hash", hash: H });
  const count = f.calls.length;
  f.advance(29000);
  await f.service.reconcile(ID);
  expect(f.calls).toHaveLength(count);
  f.advance(1000);
  await f.service.reconcile(ID);
  expect(f.calls).toHaveLength(count + 1);
});
const ORIGINAL = `0x${"88".repeat(32)}`,
  REPLACEMENT = `0x${"99".repeat(32)}`;
async function fundingReplacementFixture(nonce = "0x7") {
  vi.useFakeTimers();
  const f = await adapterFixture();
  const sender = `0x${"44".repeat(20)}`;
  await f.adapter.operations.create({
    id: ID,
    action: "fund",
    role: "borrower",
    evmSender: sender,
  });
  f.transactions.set(ORIGINAL, {
    hash: ORIGINAL,
    chainId: "0xaa36a7",
    from: sender,
    nonce: "0x7",
    to: f.market.vault,
    value: "0x470de4df820000",
    input: "0x",
    blockNumber: null,
    blockHash: null,
    transactionIndex: null,
    type: "0x2",
    gas: "0x5208",
    maxFeePerGas: "0x2",
    maxPriorityFeePerGas: "0x2",
    v: "0x1",
    r: `0x${"55".repeat(32)}`,
    s: `0x${"66".repeat(32)}`,
  });
  f.receipts.set(ORIGINAL, null);
  await f.adapter.operations.observe(ID, {
    step: 0,
    event: "hash",
    hash: ORIGINAL,
  });
  await vi.advanceTimersByTimeAsync(30000);
  f.transactions.set(REPLACEMENT, {
    hash: REPLACEMENT,
    chainId: "0xaa36a7",
    from: sender,
    nonce,
    to: f.market.vault,
    value: "0x470de4df820000",
    input: "0x",
    blockNumber: "0x67",
    blockHash: `0x${"aa".repeat(32)}`,
    transactionIndex: "0x0",
    type: "0x2",
    gas: "0x5208",
    maxFeePerGas: "0x2",
    maxPriorityFeePerGas: "0x2",
    v: "0x1",
    r: `0x${"55".repeat(32)}`,
    s: `0x${"66".repeat(32)}`,
  });
  f.receipts.set(REPLACEMENT, {
    transactionHash: REPLACEMENT,
    transactionIndex: "0x0",
    blockHash: `0x${"aa".repeat(32)}`,
    blockNumber: "0x67",
    from: sender,
    to: f.market.vault,
    cumulativeGasUsed: "0x5208",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x2",
    contractAddress: null,
    logs: [],
    logsBloom: `0x${"00".repeat(256)}`,
    status: "0x1",
    type: "0x2",
  });
  return f;
}
it("refuses an identical funding transfer at a different nonce without clearing the original uncertainty", async () => {
  const f = await fundingReplacementFixture("0x8");
  await expect(
    f.adapter.operations.observe(ID, {
      step: 0,
      event: "hash",
      hash: REPLACEMENT,
    }),
  ).rejects.toThrow("nonce");
  expect(f.adapter.operations.list()[0]).toMatchObject({
    unresolved: true,
    steps: [{ hashes: [{ hash: ORIGINAL }] }],
  });
});
it("accepts an exact same-nonce funding speedup using four extra pair reads and the normal eight-read verdict", async () => {
  const f = await fundingReplacementFixture();
  const before = f.calls.length;
  const result = await f.adapter.operations.observe(ID, {
    step: 0,
    event: "hash",
    hash: REPLACEMENT,
  });
  expect(result).toMatchObject({
    stage: "succeeded",
    unresolved: false,
    steps: [
      {
        hashes: [
          { hash: ORIGINAL, status: "hint" },
          { hash: REPLACEMENT, status: "succeeded", blockNumber: "103" },
        ],
      },
    ],
  });
  const reads = f.calls.slice(before);
  expect(reads.filter((c) => c.provider === 2)).toHaveLength(4);
  expect(reads.filter((c) => c.method === "eth_chainId")).toHaveLength(2);
  expect(
    reads.filter((c) => c.provider !== 2 && c.method !== "eth_chainId"),
  ).toHaveLength(12);
  expect(
    reads.filter(
      (c) =>
        c.method === "eth_getTransactionByHash" && c.params[0] === ORIGINAL,
    ),
  ).toHaveLength(2);
  await f.reload();
  const count = f.calls.length;
  expect(f.adapter.operations.list()[0]).toMatchObject({
    stage: "succeeded",
    unresolved: false,
  });
  await f.adapter.operations.reconcile(ID);
  expect(f.calls).toHaveLength(count);
});
it("refuses a replacement while the original nonce is unavailable and retains its pair-check cooldown", async () => {
  const f = await fundingReplacementFixture();
  f.transactions.set(ORIGINAL, null);
  const before = f.calls.length;
  await expect(
    f.adapter.operations.observe(ID, {
      step: 0,
      event: "hash",
      hash: REPLACEMENT,
    }),
  ).rejects.toThrow("nonce");
  expect(f.calls.length - before).toBe(10); // 6 readiness + 4 nonce-pair reads
  const count = f.calls.length;
  await expect(
    f.adapter.operations.observe(ID, {
      step: 0,
      event: "hash",
      hash: REPLACEMENT,
    }),
  ).rejects.toThrow("nonce");
  expect(f.calls).toHaveLength(count);
  expect(f.adapter.operations.list()[0]).toMatchObject({
    unresolved: true,
    steps: [{ hashes: [{ hash: ORIGINAL }] }],
  });
});
it("checks replacement payload independently after a same-nonce association", async () => {
  const f = await fundingReplacementFixture();
  const tx = f.transactions.get(REPLACEMENT) as any;
  tx.to = `0x${"55".repeat(20)}`;
  const receipt = f.receipts.get(REPLACEMENT) as any;
  receipt.to = tx.to;
  await expect(
    f.adapter.operations.observe(ID, {
      step: 0,
      event: "hash",
      hash: REPLACEMENT,
    }),
  ).rejects.toThrow("match");
  expect(f.adapter.operations.list()[0]).toMatchObject({
    unresolved: true,
    steps: [{ hashes: [{ hash: ORIGINAL }] }],
  });
});
it("refuses provider-disagreed replacement nonces with a 30-second failure cooldown", async () => {
  const f = await fundingReplacementFixture();
  f.setEthereumMutation((provider, method, params, result) => {
    if (
      provider === 1 &&
      method === "eth_getTransactionByHash" &&
      params[0] === ORIGINAL
    )
      result.nonce = "0x8";
    return result;
  });
  await expect(
    f.adapter.operations.observe(ID, {
      step: 0,
      event: "hash",
      hash: REPLACEMENT,
    }),
  ).rejects.toThrow("nonce");
  const count = f.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  await expect(
    f.adapter.operations.observe(ID, {
      step: 0,
      event: "hash",
      hash: REPLACEMENT,
    }),
  ).rejects.toThrow("nonce");
  expect(f.calls).toHaveLength(count);
  expect(f.adapter.operations.list()[0]).toMatchObject({
    unresolved: true,
    steps: [{ hashes: [{ hash: ORIGINAL }] }],
  });
});
it("resolves a reverted finalized same-nonce speedup as failure because its nonce was consumed", async () => {
  const f = await fundingReplacementFixture();
  (f.receipts.get(REPLACEMENT) as any).status = "0x0";
  const result = await f.adapter.operations.observe(ID, {
    step: 0,
    event: "hash",
    hash: REPLACEMENT,
  });
  expect(result).toMatchObject({
    stage: "failed",
    unresolved: false,
    steps: [
      {
        hashes: [
          {
            hash: ORIGINAL,
            status: "failed",
            detail:
              "Another transaction with the same nonce finalized; this hash was not included.",
          },
          { hash: REPLACEMENT, status: "failed", detail: HASH_DETAILS.failed },
        ],
      },
    ],
  });
  await f.reload();
  const count = f.calls.length;
  expect((await f.adapter.operations.reconcile(ID)).stage).toBe("failed");
  expect(f.calls).toHaveLength(count);
});
it("checks a known successor after an unavailable original in the same bounded reconciliation", async () => {
  const f = await fundingReplacementFixture();
  const receipt = f.receipts.get(REPLACEMENT) as any;
  f.receipts.set(REPLACEMENT, null);
  await f.adapter.operations.observe(ID, {
    step: 0,
    event: "hash",
    hash: REPLACEMENT,
  });
  receipt.status = "0x0";
  f.receipts.set(REPLACEMENT, receipt);
  await vi.advanceTimersByTimeAsync(30000);
  const before = f.calls.length;
  expect(await f.adapter.operations.reconcile(ID)).toMatchObject({
    stage: "failed",
    unresolved: false,
  });
  expect(f.calls.length - before).toBe(18); // readiness6 + original4 + successor8
});
it("discards old nonfinal inclusion fields when canonical nonce consumption excludes that alias", async () => {
  const f = await fundingReplacementFixture();
  const journal = await OperationJournal.open(f.opPath, {
    controllerId: f.adapter.deployment.controllerId,
  });
  await journal.update(ID, (r) => {
    Object.assign(r.steps[0].hashes[0], {
      status: "pending",
      detail: HASH_DETAILS.notFinal,
      blockNumber: "102",
    });
  });
  await f.reload();
  (f.receipts.get(REPLACEMENT) as any).status = "0x0";
  const view = await f.adapter.operations.observe(ID, {
    step: 0,
    event: "hash",
    hash: REPLACEMENT,
  });
  expect(view.steps[0].hashes[0].status).toBe("failed");
  expect(view.steps[0].hashes[0]).not.toHaveProperty("blockNumber");
});
it("caps funding aliases at four hashes without extra provider work for the fifth", async () => {
  const f = await fundingReplacementFixture();
  for (const digit of ["a", "b", "c"]) {
    const hash = `0x${digit.repeat(64)}`;
    f.transactions.set(hash, {
      ...(f.transactions.get(REPLACEMENT) as object),
      hash,
      blockNumber: null,
      blockHash: null,
      transactionIndex: null,
    });
    f.receipts.set(hash, null);
    await f.adapter.operations.observe(ID, { step: 0, event: "hash", hash });
    await vi.advanceTimersByTimeAsync(30000);
  }
  const before = f.calls.length;
  await expect(
    f.adapter.operations.observe(ID, {
      step: 0,
      event: "hash",
      hash: `0x${"d".repeat(64)}`,
    }),
  ).rejects.toThrow("capacity");
  expect(f.calls).toHaveLength(before);
  expect(f.adapter.operations.list()[0].steps[0].hashes).toHaveLength(4);
});

import { describe, it, expect } from "vitest";
import { JsonRpcProvider } from "near-api-js";
import { ReceiptVerifier } from "../src/receipt-verifier.ts";
import { HASH_DETAILS, type ExpectedStep } from "../src/operations.ts";
const H = "11111111111111111111111111111111";
const B = "11111111111111111111111111111112";
const R = "11111111111111111111111111111113";
const EH = `0x${"11".repeat(32)}`;
const EB = `0x${"22".repeat(32)}`;
const FROM = `0x${"33".repeat(20)}`;
const TO = `0x${"44".repeat(20)}`;
function nearStep(
  methodName = "request_proof",
  args: Record<string, unknown> = { bundle: { height: "7" } },
): ExpectedStep {
  return {
    chain: "near",
    signerId: "borrower.testnet",
    minimumBlock: "100",
    action: {
      chain: "near",
      receiverId: "controller.testnet",
      methodName,
      args,
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
function nearTx() {
  return {
    final_execution_status: "FINAL",
    transaction: {
      hash: H,
      signer_id: "borrower.testnet",
      receiver_id: "controller.testnet",
      nonce: 7,
      priority_fee: 0,
      public_key: `ed25519:${H}`,
      signature: `ed25519:${H}`,
      actions: [
        {
          FunctionCall: {
            method_name: "request_proof",
            args: "eyJidW5kbGUiOnsiaGVpZ2h0IjoiNyJ9fQ==",
            gas: 300000000000000,
            deposit: "0",
          },
        },
      ],
    },
    transaction_outcome: outcome(
      H,
      "borrower.testnet",
      { SuccessReceiptId: R },
      [R],
    ),
    receipts_outcome: [
      outcome(R, "controller.testnet", { SuccessValue: "dHJ1ZQ==" }),
    ],
    receipts: [
      {
        predecessor_id: "borrower.testnet",
        receiver_id: "controller.testnet",
        receipt_id: R,
        priority: 0,
        receipt: {
          Action: {
            signer_id: "borrower.testnet",
            signer_public_key: `ed25519:${H}`,
            gas_price: "5",
            output_data_receivers: [],
            input_data_ids: [],
            actions: [
              {
                FunctionCall: {
                  method_name: "request_proof",
                  args: "eyJidW5kbGUiOnsiaGVpZ2h0IjoiNyJ9fQ==",
                  gas: 300000000000000,
                  deposit: "0",
                },
              },
            ],
          },
        },
      },
    ],
    status: { SuccessValue: "dHJ1ZQ==" },
  };
}
function harness(tx: any = nearTx(), height: any = 101) {
  const calls: any[] = [];
  const p = new JsonRpcProvider({ url: "https://unused.invalid" });
  p.sendJsonRpc = (async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === "EXPERIMENTAL_tx_status") return structuredClone(tx);
    if (method === "block") return { header: { hash: B, height } };
    throw Error("unexpected read");
  }) as typeof p.sendJsonRpc;
  return {
    v: new ReceiptVerifier({
      near: p,
      ethereum: async () => {
        throw Error("no ethereum reads");
      },
    }),
    calls,
  };
}
function ethStep(kind: "funding" | "relay" = "funding"): ExpectedStep {
  const intent = {
    chainId: "11155111" as const,
    from: FROM,
    to: TO,
    valueWei: "42",
    data: "0x" as const,
  };
  return kind === "funding"
    ? { chain: "ethereum", kind, intent, minimumBlock: "100" }
    : { chain: "ethereum", kind, intent, nonce: "7", candidateHash: EH };
}
function ethFixture() {
  return {
    tx: {
      hash: EH,
      chainId: "0xaa36a7",
      from: FROM,
      to: TO,
      value: "0x2a",
      input: "0x",
      nonce: "0x7",
      blockNumber: "0x65",
      blockHash: EB,
      transactionIndex: "0x0",
      type: "0x2",
      gas: "0x5208",
      maxFeePerGas: "0xa",
      maxPriorityFeePerGas: "0x1",
      v: "0x1",
      r: `0x${"55".repeat(32)}`,
      s: `0x${"66".repeat(32)}`,
    },
    receipt: {
      transactionHash: EH,
      transactionIndex: "0x0",
      blockHash: EB,
      blockNumber: "0x65",
      from: FROM,
      to: TO,
      cumulativeGasUsed: "0x5208",
      gasUsed: "0x5208",
      effectiveGasPrice: "0x5",
      contractAddress: null,
      logs: [],
      logsBloom: `0x${"00".repeat(256)}`,
      status: "0x1",
      type: "0x2",
    },
    head: { number: "0x66", hash: `0x${"77".repeat(32)}` },
    canonical: { number: "0x65", hash: EB },
  };
}
function ethHarness(
  change?: (f: ReturnType<typeof ethFixture>, p: number) => void,
) {
  const calls: any[] = [];
  const f = [ethFixture(), ethFixture()];
  f.forEach((x, p) => change?.(x, p));
  return {
    calls,
    v: new ReceiptVerifier({
      near: new JsonRpcProvider({ url: "https://unused.invalid" }),
      ethereum: async (p, method, params) => {
        calls.push([p, method, params]);
        const x = f[p];
        if (method === "eth_getTransactionByHash") return x.tx;
        if (method === "eth_getTransactionReceipt") return x.receipt;
        if (method === "eth_getBlockByNumber")
          return params[0] === "finalized" ? x.head : x.canonical;
        throw Error("unexpected method");
      },
    }),
  };
}
describe("independent NEAR receipt binding", () => {
  for (const accepted of [true, false]) {
    it(`omits Ethereum fee units from NEAR ${accepted ? "success" : "failed acceptance"}`, async () => {
      const t = nearTx();
      t.transaction_outcome.outcome.tokens_burnt = "1000000000000000000000";
      const result = accepted ? "dHJ1ZQ==" : "ZmFsc2U=";
      t.status = { SuccessValue: result };
      t.receipts_outcome[0].outcome.status = { SuccessValue: result };
      const verified = await harness(t).v.verify(nearStep(), H);
      expect(verified).toMatchObject({
        status: accepted ? "succeeded" : "failed",
        blockNumber: "101",
        gasUsed: "200",
      });
      expect(verified).not.toHaveProperty("feeWei");
    });
  }
  it("accepts exact final callback and uses NONE plus one inclusion read", async () => {
    const { v, calls } = harness();
    expect(await v.verify(nearStep(), H)).toMatchObject({
      status: "succeeded",
      blockNumber: "101",
      gasUsed: "200",
    });
    expect(calls).toEqual([
      {
        method: "EXPERIMENTAL_tx_status",
        params: {
          tx_hash: H,
          sender_account_id: "borrower.testnet",
          wait_until: "NONE",
        },
      },
      { method: "block", params: { block_id: B } },
    ]);
  });
  for (const [name, mutate] of [
    ["signer", (t: any) => (t.transaction.signer_id = "other.testnet")],
    ["controller", (t: any) => (t.transaction.receiver_id = "other.testnet")],
    ["hash", (t: any) => (t.transaction.hash = R)],
    [
      "method",
      (t: any) =>
        (t.transaction.actions[0].FunctionCall.method_name = "borrow"),
    ],
    ["gas", (t: any) => (t.transaction.actions[0].FunctionCall.gas = 1)],
    [
      "deposit",
      (t: any) => (t.transaction.actions[0].FunctionCall.deposit = "1"),
    ],
    [
      "serialized args",
      (t: any) =>
        (t.transaction.actions[0].FunctionCall.args =
          "eyJidW5kbGUiOiB7ImhlaWdodCI6IjcifX0="),
    ],
    [
      "extra action",
      (t: any) => t.transaction.actions.push({ Transfer: { deposit: "1" } }),
    ],
  ] as const)
    it(`keeps ${name} mismatch as a hint`, async () => {
      const t = nearTx();
      mutate(t);
      expect(await harness(t).v.verify(nearStep(), H)).toMatchObject({
        status: "hint",
        detail: HASH_DETAILS.mismatch,
      });
    });
  it("rejects inclusion at exclusive floor", async () => {
    expect(await harness(nearTx(), 100).v.verify(nearStep(), H)).toMatchObject({
      status: "hint",
      detail: HASH_DETAILS.mismatch,
    });
  });
  for (const [name, value, status, detail] of [
    ["false", "ZmFsc2U=", "failed", HASH_DETAILS.acceptanceFailed],
    ["null", "bnVsbA==", "failed", HASH_DETAILS.acceptanceFailed],
    ["empty", "", "failed", HASH_DETAILS.acceptanceFailed],
    ["invalid base64", "!!!", "hint", HASH_DETAILS.unavailable],
  ] as const)
    it(`handles ${name} callback result`, async () => {
      const t = nearTx();
      t.status = { SuccessValue: value };
      t.receipts_outcome[0].outcome.status = { SuccessValue: value };
      expect(await harness(t).v.verify(nearStep(), H)).toMatchObject({
        status,
        detail,
      });
    });
  it("accepts empty unit result only", async () => {
    const t = nearTx();
    t.transaction.actions[0].FunctionCall.method_name = "cancel";
    t.transaction.actions[0].FunctionCall.args = "e30=";
    t.status = { SuccessValue: "" };
    t.receipts_outcome[0].outcome.status = { SuccessValue: "" };
    expect(await harness(t).v.verify(nearStep("cancel", {}), H)).toMatchObject({
      status: "succeeded",
    });
    t.status = { SuccessValue: "dHJ1ZQ==" };
    t.receipts_outcome[0].outcome.status = { SuccessValue: "dHJ1ZQ==" };
    expect(await harness(t).v.verify(nearStep("cancel", {}), H)).toMatchObject({
      status: "failed",
    });
  });
  for (const milestone of ["NONE", "EXECUTED", "EXECUTED_OPTIMISTIC"])
    it(`does not finalize ${milestone}`, async () => {
      const t: any = nearTx();
      t.final_execution_status = milestone;
      expect(await harness(t).v.verify(nearStep(), H)).toMatchObject({
        status: "pending",
      });
    });
  for (const missing of [
    "receipts",
    "receipts_outcome",
    "status",
    "transaction_outcome",
  ])
    it(`does not succeed without ${missing}`, async () => {
      const t: any = nearTx();
      delete t[missing];
      expect(await harness(t).v.verify(nearStep(), H)).toMatchObject({
        status: "hint",
        detail: HASH_DETAILS.unavailable,
      });
    });
  it("retains failed receipt even when final return is true", async () => {
    const t: any = nearTx();
    t.receipts_outcome[0].outcome.status = {
      Failure: {
        ActionError: {
          index: 0,
          kind: { FunctionCallError: { ExecutionError: "private upstream" } },
        },
      },
    };
    expect(await harness(t).v.verify(nearStep(), H)).toMatchObject({
      status: "failed",
      detail: HASH_DETAILS.failed,
    });
  });
  it("rejects missing receipt graph node", async () => {
    const t = nearTx();
    t.receipts_outcome[0].outcome.receipt_ids = [B];
    expect(await harness(t).v.verify(nearStep(), H)).toMatchObject({
      status: "hint",
      detail: HASH_DETAILS.unavailable,
    });
  });
  it("imports historical context with the first query reused", async () => {
    const { v, calls } = harness();
    const x = await v.importNear(H, "prove", "borrower", {
      controllerId: "controller.testnet",
      borrowerId: "borrower.testnet",
      lenderId: "lender.testnet",
    });
    expect(x.expected).toEqual(nearStep());
    expect(x.verification.status).toBe("succeeded");
    expect(calls).toHaveLength(2);
  });
  it("accepts JSON boolean true with JSON whitespace", async () => {
    const t = nearTx();
    t.status = { SuccessValue: "IHRydWUg" };
    t.receipts_outcome[0].outcome.status = { SuccessValue: "IHRydWUg" };
    expect(await harness(t).v.verify(nearStep(), H)).toMatchObject({
      status: "succeeded",
    });
  });
  it("accepts data receipts without inventing execution outcomes for them", async () => {
    const t: any = nearTx();
    t.receipts_outcome[0].outcome.receipt_ids = [B];
    t.receipts.push({
      predecessor_id: "controller.testnet",
      receiver_id: "borrower.testnet",
      receipt_id: B,
      receipt: { Data: { data_id: B, data: null } },
    });
    expect(await harness(t).v.verify(nearStep(), H)).toMatchObject({
      status: "succeeded",
    });
  });
  it("retains final transaction failure before any receipt is created", async () => {
    const t: any = nearTx();
    t.status = {
      Failure: {
        ActionError: {
          index: 0,
          kind: { InvalidSignerId: { account_id: "borrower.testnet" } },
        },
      },
    };
    t.transaction_outcome.outcome.status = t.status;
    t.transaction_outcome.outcome.receipt_ids = [];
    t.receipts = [];
    t.receipts_outcome = [];
    expect(await harness(t).v.verify(nearStep(), H)).toMatchObject({
      status: "failed",
      detail: HASH_DETAILS.failed,
    });
  });
  it("does not treat an upstream error message as a binding verdict", async () => {
    const p = new JsonRpcProvider({ url: "https://unused.invalid" });
    p.sendJsonRpc = (async () => {
      throw Error("mismatch");
    }) as typeof p.sendJsonRpc;
    const v = new ReceiptVerifier({
      near: p,
      ethereum: async () => {
        throw Error("unexpected");
      },
    });
    expect(await v.verify(nearStep(), H)).toEqual({
      hash: H,
      status: "hint",
      detail: HASH_DETAILS.unavailable,
    });
  });
  for (const [name, change] of [
    ["receipt identity", (t: any) => (t.receipts[0].receipt_id = B)],
    ["duplicate receipt", (t: any) => t.receipts.push(t.receipts[0])],
    [
      "invalid outcome gas",
      (t: any) =>
        (t.receipts_outcome[0].outcome.gas_burnt = Number.MAX_SAFE_INTEGER + 1),
    ],
    [
      "inconsistent final result",
      (t: any) =>
        (t.receipts_outcome[0].outcome.status = { SuccessValue: "ZmFsc2U=" }),
    ],
    [
      "receipt status",
      (t: any) =>
        (t.receipts_outcome[0].outcome.status = { Unknown: "anything" }),
    ],
    ["cycle", (t: any) => (t.receipts_outcome[0].outcome.receipt_ids = [H])],
    ["proof node", (t: any) => (t.receipts_outcome[0].proof = [null])],
    [
      "receipt input data id",
      (t: any) => (t.receipts[0].receipt.Action.input_data_ids = ["garbage"]),
    ],
    [
      "receipt action",
      (t: any) => (t.receipts[0].receipt.Action.actions = [null]),
    ],
    [
      "metadata version",
      (t: any) => (t.receipts_outcome[0].outcome.metadata.version = "bad"),
    ],
    ["missing final state", (t: any) => delete t.final_execution_status],
  ] as const)
    it(`keeps malformed ${name} unresolved`, async () => {
      const t: any = nearTx();
      change(t);
      expect(await harness(t).v.verify(nearStep(), H)).toMatchObject({
        status: "hint",
        detail: HASH_DETAILS.unavailable,
      });
    });
  for (const method of [
    "initialize_vault",
    "request_proof",
    "prepare_settlement",
    "request_signature",
    "confirm_settlement",
  ])
    it(`requires true for ${method}`, async () => {
      const t = nearTx();
      t.transaction.actions[0].FunctionCall.method_name = method;
      t.status = { SuccessValue: "ZmFsc2U=" };
      t.receipts_outcome[0].outcome.status = { SuccessValue: "ZmFsc2U=" };
      expect(await harness(t).v.verify(nearStep(method), H)).toMatchObject({
        status: "failed",
        detail: HASH_DETAILS.acceptanceFailed,
      });
    });
  for (const method of [
    "ft_transfer",
    "fund_liquidity",
    "borrow",
    "repay",
    "claim_credit",
    "declare_default",
    "cancel",
    "expire_pending",
  ])
    it(`accepts empty only for ${method}`, async () => {
      const t = nearTx();
      t.transaction.actions[0].FunctionCall.method_name = method;
      t.status = { SuccessValue: "" };
      t.receipts_outcome[0].outcome.status = { SuccessValue: "" };
      expect(await harness(t).v.verify(nearStep(method), H)).toMatchObject({
        status: "succeeded",
      });
    });
  for (const [name, change] of [
    [
      "wrong deposit",
      (t: any) => (t.transaction.actions[0].FunctionCall.deposit = "1"),
    ],
    [
      "wrong gas",
      (t: any) => (t.transaction.actions[0].FunctionCall.gas = 30000000000000),
    ],
    [
      "unbounded arguments",
      (t: any) =>
        (t.transaction.actions[0].FunctionCall.args = Buffer.from(
          JSON.stringify({ bundle: { data: "x".repeat(65536) } }),
        ).toString("base64")),
    ],
    [
      "unrelated arguments",
      (t: any) => (t.transaction.actions[0].FunctionCall.args = "e30="),
    ],
  ] as const)
    it(`rejects historical ${name}`, async () => {
      const t = nearTx();
      change(t);
      await expect(
        harness(t).v.importNear(H, "prove", "borrower", {
          controllerId: "controller.testnet",
          borrowerId: "borrower.testnet",
          lenderId: "lender.testnet",
        }),
      ).rejects.toThrow(/^Historical transaction could not be verified$/);
    });
  it("does not emit accounting fields outside the journal decimal bound", async () => {
    const t = nearTx();
    t.transaction_outcome.outcome.tokens_burnt = "9".repeat(78);
    t.receipts_outcome[0].outcome.tokens_burnt = "9".repeat(78);
    expect(await harness(t).v.verify(nearStep(), H)).toMatchObject({
      status: "hint",
      detail: HASH_DETAILS.unavailable,
    });
  });
  it("rejects historical wrong role without making an operation", async () => {
    await expect(
      harness().v.importNear(H, "prove", "lender", {
        controllerId: "controller.testnet",
        borrowerId: "borrower.testnet",
        lenderId: "lender.testnet",
      }),
    ).rejects.toThrow("Historical transaction could not be verified");
  });
});
describe("independent Ethereum receipt binding", () => {
  it("requires eight fixed-provider reads and independently derives fee", async () => {
    const { v, calls } = ethHarness();
    expect(await v.verify(ethStep(), EH)).toEqual({
      hash: EH,
      status: "succeeded",
      detail: HASH_DETAILS.succeeded,
      blockNumber: "101",
      gasUsed: "21000",
      feeWei: "105000",
    });
    expect(calls).toHaveLength(8);
    expect(
      calls.filter(
        (c) => c[1] === "eth_getBlockByNumber" && c[2][0] === "0x65",
      ),
    ).toHaveLength(2);
  });
  for (const [name, change, status, detail] of [
    [
      "wrong chain",
      (f: any) => (f.tx.chainId = "0x1"),
      "hint",
      HASH_DETAILS.mismatch,
    ],
    [
      "wrong sender",
      (f: any) => {
        f.tx.from = TO;
        f.receipt.from = TO;
      },
      "hint",
      HASH_DETAILS.mismatch,
    ],
    [
      "wrong value",
      (f: any) => (f.tx.value = "0x29"),
      "hint",
      HASH_DETAILS.mismatch,
    ],
    [
      "cancellation",
      (f: any) => {
        f.tx.to = FROM;
        f.receipt.to = FROM;
      },
      "hint",
      HASH_DETAILS.mismatch,
    ],
    [
      "nonempty data",
      (f: any) => (f.tx.input = "0x00"),
      "hint",
      HASH_DETAILS.mismatch,
    ],
    [
      "provider disagreement",
      (f: any, p: number) => {
        if (p === 1) f.receipt.blockHash = EH;
      },
      "hint",
      HASH_DETAILS.unavailable,
    ],
    ["missing tx", (f: any) => (f.tx = null), "hint", HASH_DETAILS.unavailable],
    [
      "not final",
      (f: any) => (f.head.number = "0x64"),
      "pending",
      HASH_DETAILS.notFinal,
    ],
    [
      "noncanonical",
      (f: any) => (f.canonical.hash = EH),
      "hint",
      HASH_DETAILS.unavailable,
    ],
    [
      "revert",
      (f: any) => (f.receipt.status = "0x0"),
      "failed",
      HASH_DETAILS.failed,
    ],
    [
      "missing status",
      (f: any) => delete f.receipt.status,
      "hint",
      HASH_DETAILS.unavailable,
    ],
  ] as const)
    it(`handles ${name}`, async () => {
      expect(await ethHarness(change).v.verify(ethStep(), EH)).toMatchObject({
        status,
        detail,
      });
    });
  it("rejects old funding transfer", async () => {
    const s = ethStep();
    if (s.chain === "ethereum" && s.kind === "funding") s.minimumBlock = "101";
    expect(await ethHarness().v.verify(s, EH)).toMatchObject({
      status: "hint",
      detail: HASH_DETAILS.mismatch,
    });
  });
  it("recovers relay without funding floor but requires candidate and nonce", async () => {
    expect(await ethHarness().v.verify(ethStep("relay"), EH)).toMatchObject({
      status: "succeeded",
    });
    expect(
      await ethHarness((f) => {
        f.tx.nonce = "0x8";
      }).v.verify(ethStep("relay"), EH),
    ).toMatchObject({ status: "hint", detail: HASH_DETAILS.mismatch });
    expect(await ethHarness().v.verify(ethStep("relay"), EB)).toMatchObject({
      status: "hint",
      detail: HASH_DETAILS.mismatch,
    });
  });
  it("does not emit an oversized computed fee", async () => {
    expect(
      await ethHarness((f) => {
        f.receipt.gasUsed = `0x${"f".repeat(64)}`;
        f.receipt.effectiveGasPrice = `0x${"f".repeat(64)}`;
      }).v.verify(ethStep(), EH),
    ).toMatchObject({ status: "hint", detail: HASH_DETAILS.unavailable });
  });
  it("coalesces inclusion reads and reuses only jointly finalized headers", async () => {
    const calls: any[] = [];
    const f = ethFixture();
    const v = new ReceiptVerifier({
      near: new JsonRpcProvider({ url: "https://unused.invalid" }),
      ethereum: async (p, method, params) => {
        calls.push([p, method, params]);
        if (method === "eth_getTransactionByHash")
          return { ...f.tx, hash: params[0] };
        if (method === "eth_getTransactionReceipt")
          return { ...f.receipt, transactionHash: params[0] };
        if (method === "eth_getBlockByNumber")
          return params[0] === "finalized" ? f.head : f.canonical;
        throw Error("unexpected");
      },
    });
    expect(
      (
        await Promise.all([v.verify(ethStep(), EH), v.verify(ethStep(), EB)])
      ).map((x) => x.status),
    ).toEqual(["succeeded", "succeeded"]);
    expect(calls).toHaveLength(12);
    expect((await v.verify(ethStep(), EH)).status).toBe("succeeded");
    expect(calls).toHaveLength(16);
    const changed = ethStep();
    if (changed.chain === "ethereum") changed.intent.valueWei = "43";
    expect(await v.verify(changed, EH)).toMatchObject({
      status: "hint",
      detail: HASH_DETAILS.mismatch,
    });
    expect(calls).toHaveLength(20);
  });
  it("rejects a finalized head contradicting its same-height canonical header", async () => {
    expect(
      await ethHarness((f) => {
        f.head.number = "0x65";
      }).v.verify(ethStep(), EH),
    ).toMatchObject({ status: "hint", detail: HASH_DETAILS.unavailable });
  });
  it("never caches not-final inclusion headers", async () => {
    let final = false;
    const calls: any[] = [];
    const f = ethFixture();
    const v = new ReceiptVerifier({
      near: new JsonRpcProvider({ url: "https://unused.invalid" }),
      ethereum: async (p, m, params) => {
        calls.push([p, m, params]);
        if (m === "eth_getTransactionByHash") return f.tx;
        if (m === "eth_getTransactionReceipt") return f.receipt;
        return params[0] === "finalized"
          ? { ...f.head, number: final ? "0x66" : "0x64" }
          : f.canonical;
      },
    });
    expect((await v.verify(ethStep(), EH)).status).toBe("pending");
    final = true;
    expect((await v.verify(ethStep(), EH)).status).toBe("succeeded");
    expect(calls).toHaveLength(16);
  });
  for (const mode of ["noncanonical", "disagreeing receipts"] as const) {
    it(`does not cache ${mode} evidence`, async () => {
      let broken = true;
      let headers = 0;
      const f = ethFixture();
      const v = new ReceiptVerifier({
        near: new JsonRpcProvider({ url: "https://unused.invalid" }),
        ethereum: async (p, m, params) => {
          if (m === "eth_getTransactionByHash") return f.tx;
          if (m === "eth_getTransactionReceipt")
            return broken && mode === "disagreeing receipts" && p === 1
              ? { ...f.receipt, blockHash: EH }
              : f.receipt;
          headers++;
          return params[0] === "finalized"
            ? f.head
            : broken && mode === "noncanonical"
              ? { ...f.canonical, hash: EH }
              : f.canonical;
        },
      });
      expect(await v.verify(ethStep(), EH)).toMatchObject({
        status: "hint",
        detail: HASH_DETAILS.unavailable,
      });
      const firstHeaders = headers;
      broken = false;
      expect((await v.verify(ethStep(), EH)).status).toBe("succeeded");
      expect(headers - firstHeaders).toBe(4);
    });
  }
  it("evicts the oldest immutable header after sixty-four entries", async () => {
    let height = 101;
    let headers = 0;
    const f = ethFixture();
    const v = new ReceiptVerifier({
      near: new JsonRpcProvider({ url: "https://unused.invalid" }),
      ethereum: async (_p, m, params) => {
        const number = `0x${height.toString(16)}`;
        if (m === "eth_getTransactionByHash")
          return { ...f.tx, blockNumber: number };
        if (m === "eth_getTransactionReceipt")
          return { ...f.receipt, blockNumber: number };
        headers++;
        return params[0] === "finalized"
          ? { ...f.head, number: `0x${(height + 1).toString(16)}` }
          : { ...f.canonical, number };
      },
    });
    for (height = 101; height <= 165; height++)
      expect((await v.verify(ethStep(), EH)).status).toBe("succeeded");
    expect(headers).toBe(260);
    height = 101;
    expect((await v.verify(ethStep(), EH)).status).toBe("succeeded");
    expect(headers).toBe(264);
  });
  it("redacts unavailable dependency errors", async () => {
    const v = new ReceiptVerifier({
      near: new JsonRpcProvider({ url: "https://unused.invalid" }),
      ethereum: async () => {
        throw Error("https://secret:credential@rpc.invalid/token");
      },
    });
    expect(await v.verify(ethStep(), EH)).toEqual({
      hash: EH,
      status: "hint",
      detail: HASH_DETAILS.unavailable,
    });
  });
});

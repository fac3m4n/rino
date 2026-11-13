import type { JsonRpcProvider } from "near-api-js";
import type { ActionName, Role } from "./api.ts";
import { HASH_DETAILS, type ExpectedStep } from "./operations.ts";
import type { OperationHashView } from "./operations-api.ts";

type ObjectValue = Record<string, any>;
class ContextMismatch extends Error {}
type NearStep = Extract<ExpectedStep, { chain: "near" }>;
type EthereumStep = Extract<ExpectedStep, { chain: "ethereum" }>;
const CALLBACKS = new Set([
  "initialize_vault",
  "request_proof",
  "prepare_settlement",
  "request_signature",
  "confirm_settlement",
]);
const UNITS = new Set([
  "ft_transfer",
  "fund_liquidity",
  "borrow",
  "repay",
  "claim_credit",
  "declare_default",
  "cancel",
  "expire_pending",
]);
const quantity = (v: unknown): bigint => {
  if (typeof v !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(v))
    throw Error("malformed");
  return BigInt(v);
};
const decimal = (v: unknown): bigint => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
    return BigInt(v);
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(v))
    throw Error("malformed");
  return BigInt(v);
};
const object = (v: unknown): ObjectValue => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("malformed");
  return v as ObjectValue;
};
const hash32 = (v: unknown): v is string =>
  typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
const account = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length >= 2 &&
  v.length <= 64 &&
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(v);
function nearHash(v: unknown): v is string {
  if (typeof v !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v))
    return false;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of v) n = n * 58n + BigInt(alphabet.indexOf(c));
  let bytes = 0;
  while (n > 0n) {
    bytes++;
    n >>= 8n;
  }
  return bytes + (v.match(/^1*/)?.[0].length ?? 0) === 32;
}
function bounded(value: unknown, limit = 262144): void {
  const visit = (v: unknown, depth: number): void => {
    if (depth > 32) throw Error("malformed");
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || !v) throw Error("malformed");
    for (const key of Object.keys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d || !("value" in d)) throw Error("malformed");
      visit(d.value, depth + 1);
    }
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > limit)
    throw Error("malformed");
}
function base64(v: unknown, maximum = 65536): Buffer {
  if (
    typeof v !== "string" ||
    v.length > Math.ceil(maximum / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)
  )
    throw Error("malformed");
  const result = Buffer.from(v, "base64");
  if (result.length > maximum || result.toString("base64") !== v)
    throw Error("malformed");
  return result;
}
function view(
  hash: string,
  status: OperationHashView["status"],
  detail: string,
  extra: Partial<OperationHashView> = {},
): OperationHashView {
  return { hash, status, detail, ...extra };
}
const unavailable = (hash: string) =>
  view(hash, "hint", HASH_DETAILS.unavailable);
const mismatch = (hash: string) => view(hash, "hint", HASH_DETAILS.mismatch);
function functionCall(tx: ObjectValue): ObjectValue {
  if (!Array.isArray(tx.actions) || tx.actions.length !== 1)
    throw new ContextMismatch();
  const action = object(tx.actions[0]);
  if (
    Object.keys(action).length !== 1 ||
    !Object.hasOwn(action, "FunctionCall")
  )
    throw new ContextMismatch();
  const call = object(action.FunctionCall);
  if (Object.keys(call).sort().join(",") !== "args,deposit,gas,method_name")
    throw Error("malformed");
  base64(call.args);
  decimal(call.gas);
  decimal(call.deposit);
  if (typeof call.method_name !== "string") throw Error("malformed");
  return call;
}
function executionStatus(value: unknown): ObjectValue {
  const s = object(value);
  const keys = Object.keys(s);
  if (keys.length !== 1) throw Error("malformed");
  if (keys[0] === "SuccessValue") base64(s.SuccessValue);
  else if (keys[0] === "SuccessReceiptId") {
    if (!nearHash(s.SuccessReceiptId)) throw Error("malformed");
  } else if (keys[0] === "Failure") {
    if (!Object.keys(object(s.Failure)).length) throw Error("malformed");
  } else throw Error("malformed");
  return s;
}
/** Complete bounded execution graph, including all failures, before any terminal verdict. */
function execution(
  result: ObjectValue,
  hash: string,
): { failed: boolean; value: Buffer; gas: bigint; fee: bigint } {
  if (
    !Array.isArray(result.receipts_outcome) ||
    result.receipts_outcome.length > 128 ||
    !Array.isArray(result.receipts) ||
    result.receipts.length > 128
  )
    throw Error("malformed");
  const all = [
    object(result.transaction_outcome),
    ...result.receipts_outcome.map(object),
  ];
  if (all[0].id !== hash) throw Error("malformed");
  const ids = new Map<string, ObjectValue>();
  let gas = 0n,
    fee = 0n,
    failed = false;
  for (const entry of all) {
    if (
      !nearHash(entry.id) ||
      !nearHash(entry.block_hash) ||
      ids.has(entry.id) ||
      !Array.isArray(entry.proof) ||
      entry.proof.length > 64
    )
      throw Error("malformed");
    const o = object(entry.outcome);
    if (
      !account(o.executor_id) ||
      !Array.isArray(o.logs) ||
      o.logs.length > 128 ||
      o.logs.some(
        (s: unknown) => typeof s !== "string" || Buffer.byteLength(s) > 16384,
      ) ||
      !Array.isArray(o.receipt_ids) ||
      o.receipt_ids.length > 128 ||
      o.receipt_ids.some((id: unknown) => !nearHash(id))
    )
      throw Error("malformed");
    for (const raw of entry.proof) {
      const node = object(raw);
      if (!nearHash(node.hash) || !["Left", "Right"].includes(node.direction))
        throw Error("malformed");
    }
    if (o.metadata !== undefined) {
      const metadata = object(o.metadata);
      if (!Number.isSafeInteger(metadata.version) || metadata.version < 0)
        throw Error("malformed");
      if (
        metadata.gas_profile !== undefined &&
        metadata.gas_profile !== null &&
        !Array.isArray(metadata.gas_profile)
      )
        throw Error("malformed");
    }
    const status = executionStatus(o.status);
    gas += decimal(o.gas_burnt);
    fee += decimal(o.tokens_burnt);
    decimal(gas.toString());
    decimal(fee.toString());
    failed ||= Object.hasOwn(status, "Failure");
    ids.set(entry.id, o);
  }
  const receipts = new Map<string, "Action" | "Data">();
  for (const raw of result.receipts) {
    const r = object(raw);
    if (
      !nearHash(r.receipt_id) ||
      r.receipt_id === hash ||
      receipts.has(r.receipt_id) ||
      !account(r.predecessor_id) ||
      !account(r.receiver_id)
    )
      throw Error("malformed");
    const body = object(r.receipt);
    if (Object.keys(body).length !== 1 || !("Action" in body || "Data" in body))
      throw Error("malformed");
    if ("Action" in body) {
      if (!ids.has(r.receipt_id)) throw Error("malformed");
      const a = object(body.Action);
      if (
        !account(a.signer_id) ||
        typeof a.signer_public_key !== "string" ||
        !Array.isArray(a.actions) ||
        a.actions.length > 64 ||
        !Array.isArray(a.input_data_ids) ||
        !Array.isArray(a.output_data_receivers)
      )
        throw Error("malformed");
      decimal(a.gas_price);
      if (a.input_data_ids.some((id: unknown) => !nearHash(id)))
        throw Error("malformed");
      for (const raw of a.output_data_receivers) {
        const d = object(raw);
        if (!nearHash(d.data_id) || !account(d.receiver_id))
          throw Error("malformed");
      }
      for (const raw of a.actions) {
        if (raw === "CreateAccount") continue;
        const action = object(raw),
          names = Object.keys(action);
        if (names.length !== 1) throw Error("malformed");
        const data = object(action[names[0]]);
        if (names[0] === "FunctionCall") functionCall({ actions: [action] });
        else if (names[0] === "Transfer") decimal(data.deposit);
        else if (
          ![
            "DeployContract",
            "Stake",
            "AddKey",
            "DeleteKey",
            "DeleteAccount",
            "Delegate",
            "DelegateV2",
            "DeployGlobalContract",
            "DeployGlobalContractByAccountId",
            "UseGlobalContract",
            "UseGlobalContractByAccountId",
            "DeterministicStateInit",
            "TransferToGasKey",
            "WithdrawFromGasKey",
            "UniversalStateInit",
          ].includes(names[0])
        )
          throw Error("malformed");
      }
    } else {
      const d = object(body.Data);
      if (
        !nearHash(d.data_id) ||
        (d.data !== undefined && d.data !== null && typeof d.data !== "string")
      )
        throw Error("malformed");
    }
    receipts.set(r.receipt_id, "Action" in body ? "Action" : "Data");
  }
  for (const id of ids.keys())
    if (id !== hash && !receipts.has(id)) throw Error("malformed");
  const reachable = new Set<string>();
  const visit = (id: string, ancestors: Set<string>): void => {
    if (ancestors.has(id)) throw Error("malformed");
    if (reachable.has(id)) return;
    const o = ids.get(id);
    if (!o) {
      if (receipts.get(id) === "Data") return;
      throw Error("malformed");
    }
    reachable.add(id);
    const next = new Set(ancestors);
    next.add(id);
    for (const child of o.receipt_ids) visit(child, next);
    if (
      o.status.SuccessReceiptId &&
      !o.receipt_ids.includes(o.status.SuccessReceiptId)
    )
      throw Error("malformed");
  };
  visit(hash, new Set());
  // Data receipts have no execution outcome; validate every returned outcome without
  // claiming the RPC response is an independently authenticated execution proof.
  for (const id of ids.keys()) if (!reachable.has(id)) visit(id, new Set());
  const final = executionStatus(result.status);
  failed ||= Object.hasOwn(final, "Failure");
  let finalOutcome = ids.get(hash)!;
  const linked = new Set<string>();
  while (finalOutcome.status.SuccessReceiptId) {
    const id = finalOutcome.status.SuccessReceiptId;
    if (linked.has(id)) throw Error("malformed");
    linked.add(id);
    finalOutcome = ids.get(id)!;
  }
  // A failure anywhere is retained even when another successful branch returned a value.
  if (
    !failed &&
    (final.SuccessValue === undefined ||
      finalOutcome.status.SuccessValue !== final.SuccessValue)
  )
    throw Error("malformed");
  return {
    failed,
    value:
      final.SuccessValue === undefined
        ? Buffer.alloc(0)
        : base64(final.SuccessValue),
    gas,
    fee,
  };
}
export class ReceiptVerifier {
  readonly #near: JsonRpcProvider;
  readonly #finalized = new Set<string>();
  readonly #finalizing = new Map<string, Promise<boolean>>();
  readonly #ethereum: (
    provider: 0 | 1,
    method: string,
    params: unknown[],
  ) => Promise<unknown>;
  constructor(dependencies: {
    near: JsonRpcProvider;
    ethereum: (
      provider: 0 | 1,
      method: string,
      params: unknown[],
    ) => Promise<unknown>;
  }) {
    this.#near = dependencies.near;
    this.#ethereum = dependencies.ethereum;
  }
  async verify(step: ExpectedStep, hash: string): Promise<OperationHashView> {
    try {
      if (step.chain === "near") {
        if (!nearHash(hash)) return mismatch(hash);
        const tx = await this.#near.viewTransactionStatusWithReceipts({
          txHash: hash,
          accountId: step.signerId,
          waitUntil: "NONE",
        });
        return await this.#verifyNear(step, hash, tx);
      }
      return await this.#verifyEthereum(step, hash);
    } catch (error) {
      return error instanceof ContextMismatch
        ? mismatch(hash)
        : unavailable(hash);
    }
  }
  async #verifyNear(
    step: NearStep,
    hash: string,
    value: unknown,
  ): Promise<OperationHashView> {
    bounded(value);
    const result = object(value),
      tx = object(result.transaction),
      call = functionCall(tx);
    if (
      tx.hash !== hash ||
      tx.signer_id !== step.signerId ||
      tx.receiver_id !== step.action.receiverId ||
      call.method_name !== step.action.methodName ||
      decimal(call.gas).toString() !== step.action.gas ||
      decimal(call.deposit).toString() !== step.action.deposit ||
      !base64(call.args).equals(Buffer.from(JSON.stringify(step.action.args)))
    )
      return mismatch(hash);
    const inclusion = object(result.transaction_outcome);
    if (!nearHash(inclusion.block_hash)) throw Error("malformed");
    const block = object(
      await this.#near.viewBlock({ blockId: inclusion.block_hash }),
    );
    const header = object(block.header),
      height = decimal(header.height);
    if (header.hash !== inclusion.block_hash) throw Error("malformed");
    if (height <= decimal(step.minimumBlock)) return mismatch(hash);
    if (
      ![
        "NONE",
        "INCLUDED",
        "EXECUTED_OPTIMISTIC",
        "INCLUDED_FINAL",
        "EXECUTED",
        "FINAL",
      ].includes(result.final_execution_status)
    )
      throw Error("malformed");
    if (result.final_execution_status !== "FINAL")
      return view(hash, "pending", HASH_DETAILS.notFinal, {
        blockNumber: height.toString(),
      });
    const e = execution(result, hash);
    const extra = {
      blockNumber: height.toString(),
      gasUsed: e.gas.toString(),
    };
    if (e.failed) return view(hash, "failed", HASH_DETAILS.failed, extra);
    if (!CALLBACKS.has(call.method_name) && !UNITS.has(call.method_name))
      return mismatch(hash);
    let callbackTrue = false;
    if (CALLBACKS.has(call.method_name)) {
      try {
        callbackTrue =
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(e.value),
          ) === true;
      } catch {
        /* A successful receipt can still decline callback acceptance. */
      }
    }
    const accepted = CALLBACKS.has(call.method_name)
      ? callbackTrue
      : e.value.length === 0;
    return view(
      hash,
      accepted ? "succeeded" : "failed",
      accepted ? HASH_DETAILS.succeeded : HASH_DETAILS.acceptanceFailed,
      extra,
    );
  }
  async #verifyEthereum(
    step: EthereumStep,
    hash: string,
  ): Promise<OperationHashView> {
    if (
      !hash32(hash) ||
      (step.kind === "relay" &&
        hash.toLowerCase() !== step.candidateHash.toLowerCase())
    )
      return mismatch(hash);
    const observed = await Promise.all(
      ([0, 1] as const).map(async (p) => {
        const [tx, receipt] = await Promise.all([
          this.#ethereum(p, "eth_getTransactionByHash", [hash]),
          this.#ethereum(p, "eth_getTransactionReceipt", [hash]),
        ]);
        return { tx, receipt };
      }),
    );
    if (observed.some((x) => x.tx === null || x.receipt === null))
      return unavailable(hash);
    const normalized = observed.map(({ tx: rawTx, receipt: rawReceipt }) => {
      bounded(rawTx);
      bounded(rawReceipt);
      const tx = object(rawTx),
        r = object(rawReceipt);
      if (
        !hash32(tx.hash) ||
        !hash32(r.transactionHash) ||
        !hash32(tx.blockHash) ||
        !hash32(r.blockHash)
      )
        throw Error("malformed");
      for (const address of [tx.from, tx.to, r.from, r.to])
        if (typeof address !== "string" || !/^0x[0-9a-f]{40}$/i.test(address))
          throw Error("malformed");
      const number = quantity(tx.blockNumber),
        receiptNumber = quantity(r.blockNumber);
      const nonce = quantity(tx.nonce),
        chain = quantity(tx.chainId),
        amount = quantity(tx.value),
        status = quantity(r.status),
        gas = quantity(r.gasUsed),
        price = quantity(r.effectiveGasPrice);
      if (status !== 0n && status !== 1n) throw Error("malformed");
      if (
        tx.hash.toLowerCase() !== hash.toLowerCase() ||
        r.transactionHash.toLowerCase() !== hash.toLowerCase() ||
        tx.blockHash.toLowerCase() !== r.blockHash.toLowerCase() ||
        number !== receiptNumber ||
        tx.from.toLowerCase() !== r.from.toLowerCase() ||
        tx.to.toLowerCase() !== r.to.toLowerCase() ||
        quantity(tx.transactionIndex) !== quantity(r.transactionIndex)
      )
        throw Error("malformed");
      const matches =
        chain === 11155111n &&
        step.intent.chainId === "11155111" &&
        tx.from.toLowerCase() === step.intent.from.toLowerCase() &&
        tx.to.toLowerCase() === step.intent.to.toLowerCase() &&
        amount === decimal(step.intent.valueWei) &&
        tx.input === "0x" &&
        step.intent.data === "0x" &&
        (step.kind === "funding"
          ? number > decimal(step.minimumBlock)
          : nonce === decimal(step.nonce));
      return {
        matches,
        number,
        hash: tx.blockHash.toLowerCase(),
        nonce,
        from: tx.from.toLowerCase(),
        to: tx.to.toLowerCase(),
        amount,
        chain,
        input: tx.input,
        index: quantity(tx.transactionIndex),
        status,
        gas,
        price,
      };
    });
    const [a, b] = normalized;
    // Provider disagreement is unavailable evidence, even if one provider alone reports a mismatch.
    if (
      Object.keys(a).some(
        (k) => a[k as keyof typeof a] !== b[k as keyof typeof b],
      )
    )
      return unavailable(hash);
    if (!a.matches) return mismatch(hash);
    if (!(await this.#inclusionFinal(a.number, a.hash)))
      return view(hash, "pending", HASH_DETAILS.notFinal);
    decimal((a.gas * a.price).toString());
    return view(
      hash,
      a.status === 1n ? "succeeded" : "failed",
      a.status === 1n ? HASH_DETAILS.succeeded : HASH_DETAILS.failed,
      {
        blockNumber: a.number.toString(),
        gasUsed: a.gas.toString(),
        feeWei: (a.gas * a.price).toString(),
      },
    );
  }
  async #inclusionFinal(number: bigint, hash: string): Promise<boolean> {
    const key = `${number}:${hash}`;
    if (this.#finalized.has(key)) return true;
    const running = this.#finalizing.get(key);
    if (running) return running;
    const request = (async () => {
      const heads = await Promise.all(
        ([0, 1] as const).map(async (p) => {
          const [head, canonical] = await Promise.all([
            this.#ethereum(p, "eth_getBlockByNumber", ["finalized", false]),
            this.#ethereum(p, "eth_getBlockByNumber", [
              `0x${number.toString(16)}`,
              false,
            ]),
          ]);
          bounded(head);
          bounded(canonical);
          const h = object(head),
            c = object(canonical);
          if (
            !hash32(h.hash) ||
            !hash32(c.hash) ||
            quantity(c.number) !== number ||
            c.hash.toLowerCase() !== hash
          )
            throw Error("malformed");
          const finalizedHeight = quantity(h.number);
          if (finalizedHeight === number && h.hash.toLowerCase() !== hash)
            throw Error("malformed");
          return finalizedHeight;
        }),
      );
      if (heads.some((h) => h < number)) return false;
      // Both fixed providers covered this exact canonical inclusion with finalized heads.
      // Only that immutable observation is reusable; each hash's tx/receipt is checked anew.
      this.#finalized.add(key);
      if (this.#finalized.size > 64)
        this.#finalized.delete(this.#finalized.values().next().value!);
      return true;
    })();
    this.#finalizing.set(key, request);
    try {
      return await request;
    } finally {
      this.#finalizing.delete(key);
    }
  }
  async importNear(
    hash: string,
    action: ActionName,
    role: Role,
    binding: { controllerId: string; borrowerId: string; lenderId: string },
  ): Promise<{ expected: ExpectedStep; verification: OperationHashView }> {
    try {
      if (!nearHash(hash)) throw Error("malformed");
      const signerId =
        role === "borrower" ? binding.borrowerId : binding.lenderId;
      const value = await this.#near.viewTransactionStatusWithReceipts({
        txHash: hash,
        accountId: signerId,
        waitUntil: "NONE",
      });
      bounded(value);
      const result = object(value),
        tx = object(result.transaction),
        call = functionCall(tx);
      const methods: Partial<Record<ActionName, string[]>> = {
        initialize: ["initialize_vault"],
        fund: role === "lender" ? ["ft_transfer", "fund_liquidity"] : [],
        prove: ["request_proof"],
        borrow: ["borrow"],
        repay: ["repay"],
        default: ["declare_default"],
        cancel: ["cancel"],
        claim: ["claim_credit"],
        settle: [
          "prepare_settlement",
          "request_signature",
          "confirm_settlement",
          "expire_pending",
        ],
        recover: [
          "prepare_settlement",
          "request_signature",
          "confirm_settlement",
          "expire_pending",
        ],
      };
      const borrowerOnly = ["initialize", "prove", "borrow", "repay", "cancel"];
      const lenderOnly = ["fund", "default", "claim"];
      if (
        (borrowerOnly.includes(action) && role !== "borrower") ||
        (lenderOnly.includes(action) && role !== "lender") ||
        !methods[action]?.includes(call.method_name) ||
        tx.signer_id !== signerId ||
        tx.receiver_id !== binding.controllerId ||
        tx.hash !== hash ||
        decimal(call.gas) !== 300000000000000n
      )
        throw Error("malformed");
      const oneYocto = new Set([
        "ft_transfer",
        "fund_liquidity",
        "borrow",
        "repay",
        "claim_credit",
      ]);
      if (decimal(call.deposit) !== (oneYocto.has(call.method_name) ? 1n : 0n))
        throw Error("malformed");
      const bytes = base64(call.args),
        args = object(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
      bounded(args, 65536);
      // The historical wallet serializer is JSON.stringify; do not silently normalize a different payload.
      if (!Buffer.from(JSON.stringify(args)).equals(bytes))
        throw Error("malformed");
      const keys = Object.keys(args).sort().join(",");
      if (call.method_name === "request_proof") {
        if (keys !== "bundle") throw Error("malformed");
        object(args.bundle);
      } else if (call.method_name === "prepare_settlement") {
        if (keys !== "bundle,gas_price") throw Error("malformed");
        object(args.bundle);
        decimal(args.gas_price);
      } else if (call.method_name === "confirm_settlement") {
        if (keys !== "bundle,candidate_hash" || !hash32(args.candidate_hash))
          throw Error("malformed");
        object(args.bundle);
      } else if (call.method_name === "ft_transfer") {
        if (
          keys !== "amount,receiver_id" ||
          args.receiver_id !== binding.borrowerId ||
          decimal(args.amount) === 0n
        )
          throw Error("malformed");
      } else if (keys !== "") throw Error("malformed");
      const expected: NearStep = {
        chain: "near",
        signerId,
        minimumBlock: "0",
        action: {
          chain: "near",
          receiverId: binding.controllerId,
          methodName: call.method_name,
          args,
          gas: decimal(call.gas).toString(),
          deposit: decimal(call.deposit).toString(),
        },
      };
      // Capture an exclusive historical floor from the same inclusion read, without a second status query.
      const verification = await this.#verifyNear(expected, hash, value);
      if (verification.status === "hint") throw Error("malformed");
      if (verification.blockNumber !== undefined)
        expected.minimumBlock = (
          BigInt(verification.blockNumber) - 1n
        ).toString();
      return { expected, verification };
    } catch {
      throw Error("Historical transaction could not be verified");
    }
  }
}

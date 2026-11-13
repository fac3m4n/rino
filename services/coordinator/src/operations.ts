import type { WalletAction, Receipt } from "./api.ts";
import type {
  OperationRequest,
  OperationDiagnostic,
  OperationObservation,
  OperationHashView,
  OperationView,
  FundingIntent,
  OperationResult,
} from "./operations-api.ts";
export type ExpectedStep =
  | {
      chain: "near";
      action: WalletAction;
      signerId: string;
      minimumBlock: string;
    }
  | {
      chain: "ethereum";
      kind: "funding";
      intent: FundingIntent;
      minimumBlock: string;
    }
  | {
      chain: "ethereum";
      kind: "relay";
      intent: FundingIntent;
      nonce: string;
      candidateHash: string;
    };
export interface StoredStep {
  expected: ExpectedStep;
  started: boolean;
  hashes: OperationHashView[];
  observation?: OperationObservation["event"];
  diagnostic?: OperationDiagnostic;
}
export interface StoredOperation {
  request: OperationRequest;
  controllerId: string;
  createdAt: string;
  updatedAt: string;
  historical: boolean;
  preparation: {
    phase: "preparing" | "prepared" | "interrupted" | "failed";
    detail: "preparing" | "prepared" | "interrupted" | "failed";
  };
  steps: StoredStep[];
  continued: boolean;
  prepared?: Pick<OperationResult, "walletActions" | "funding">;
}

export const HASH_DETAILS = {
  recorded: "Transaction hash recorded.",
  pending: "Transaction pending verification.",
  succeeded: "Transaction verified successfully.",
  failed: "Transaction execution failed.",
  replaced:
    "Another transaction with the same nonce finalized; this hash was not included.",
  mismatch: "Transaction did not match the prepared action.",
  unavailable: "Provider unavailable; check again.",
  acceptanceFailed: "Callback did not accept the operation.",
  noResult: "External execution returned no result.",
  notFinal: "Transaction is not finalized.",
} as const;
import { DIAGNOSTIC_NAMES, DIAGNOSTIC_CODES } from "./operations-api.ts";
export { DIAGNOSTIC_NAMES, DIAGNOSTIC_CODES } from "./operations-api.ts";
const MAX_FILE = 8 * 1024 * 1024;
const MAX_OPERATION = 96 * 1024;
const decimal = (v: unknown): v is string =>
  typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v);
const account = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length >= 2 &&
  v.length <= 64 &&
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(v);
const address = (v: unknown): v is string =>
  typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const ethHash = (v: unknown): v is string =>
  typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);
const nearHash = (v: unknown): v is string => {
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
};
function fail(): never {
  throw Error("invalid operation data");
}
function json(value: unknown, limit: number): string {
  const seen = new Set<object>();
  const visit = (v: unknown, depth = 0): void => {
    if (depth > 24) fail();
    if (v === null || typeof v === "boolean" || typeof v === "string") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) fail();
      return;
    }
    if (typeof v !== "object" || seen.has(v)) fail();
    seen.add(v);
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      fail();
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key !== "string") fail();
      if (Array.isArray(v) && key === "length") continue;
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (
        !d.enumerable ||
        !("value" in d) ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        fail();
      visit(d.value, depth + 1);
    }
    seen.delete(v);
  };
  visit(value);
  const result = JSON.stringify(value);
  if (Buffer.byteLength(result) > limit) fail();
  return result;
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail();
  return v as Record<string, unknown>;
}
function keys(
  v: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): void {
  if (
    required.some((k) => !Object.hasOwn(v, k)) ||
    Object.keys(v).some((k) => ![...required, ...optional].includes(k))
  )
    fail();
}
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
export function parseOperationRequest(body: unknown): OperationRequest {
  json(body, 2048);
  const b = object(body);
  keys(b, ["id", "action", "role"], ["evmSender"]);
  if (
    typeof b.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      b.id,
    )
  )
    fail();
  parseAction({ action: b.action, role: b.role });
  if (
    b.evmSender !== undefined &&
    (b.action !== "fund" || b.role !== "borrower" || !address(b.evmSender))
  )
    fail();
  return {
    id: b.id,
    action: b.action as OperationRequest["action"],
    role: b.role as OperationRequest["role"],
    ...(b.evmSender !== undefined ? { evmSender: b.evmSender as string } : {}),
  };
}
function validateDiagnostic(value: unknown): void {
  const d = object(value);
  keys(d, ["category"], ["name", "code"]);
  if (
    !["wallet-closed", "timeout", "rejected", "transport", "unknown"].includes(
      d.category as string,
    )
  )
    fail();
  if (
    d.name !== undefined &&
    !DIAGNOSTIC_NAMES.includes(d.name as (typeof DIAGNOSTIC_NAMES)[number])
  )
    fail();
  if (
    d.code !== undefined &&
    !DIAGNOSTIC_CODES.includes(d.code as (typeof DIAGNOSTIC_CODES)[number])
  )
    fail();
}
export function parseOperationObservation(body: unknown): OperationObservation {
  json(body, 2048);
  const b = object(body);
  keys(b, ["step", "event"], ["hash", "diagnostic"]);
  if (
    !Number.isInteger(b.step) ||
    (b.step !== 0 && b.step !== 1) ||
    ![
      "submission-started",
      "hash",
      "wallet-rejected",
      "wallet-unknown",
    ].includes(b.event as string)
  )
    fail();
  if (b.event === "hash") {
    if (!nearHash(b.hash) && !ethHash(b.hash)) fail();
  } else if (b.hash !== undefined) fail();
  if (b.diagnostic !== undefined) {
    if (b.event !== "wallet-rejected" && b.event !== "wallet-unknown") fail();
    validateDiagnostic(b.diagnostic);
  }
  return clone(b) as unknown as OperationObservation;
}
export function parseOperationImport(
  body: unknown,
): OperationRequest & { hash: string } {
  json(body, 2048);
  const b = object(body);
  keys(b, ["id", "action", "role", "hash"]);
  const request = parseOperationRequest({
    id: b.id,
    action: b.action,
    role: b.role,
  });
  if (!nearHash(b.hash)) fail();
  return { ...request, hash: b.hash };
}
export function parseEmptyObject(body: unknown): Record<string, never> {
  json(body, 2048);
  keys(object(body), []);
  return {};
}
const METHODS = [
  "initialize_vault",
  "request_proof",
  "prepare_settlement",
  "request_signature",
  "confirm_settlement",
  "ft_transfer",
  "fund_liquidity",
  "borrow",
  "repay",
  "claim_credit",
  "declare_default",
  "cancel",
  "expire_pending",
];
function wallet(value: unknown): void {
  const a = object(value);
  keys(a, ["chain", "receiverId", "methodName", "args", "gas", "deposit"]);
  if (
    a.chain !== "near" ||
    !account(a.receiverId) ||
    !METHODS.includes(a.methodName as string) ||
    !decimal(a.gas) ||
    BigInt(a.gas) === 0n ||
    BigInt(a.gas) > 300000000000000n ||
    !decimal(a.deposit)
  )
    fail();
  object(a.args);
  json(a.args, 64 * 1024);
}
function funding(value: unknown): void {
  const f = object(value);
  keys(f, ["chainId", "from", "to", "valueWei", "data"]);
  if (
    f.chainId !== "11155111" ||
    !address(f.from) ||
    !address(f.to) ||
    !decimal(f.valueWei) ||
    f.data !== "0x"
  )
    fail();
}
function expected(value: unknown): void {
  const e = object(value);
  if (e.chain === "near") {
    keys(e, ["chain", "action", "signerId", "minimumBlock"]);
    wallet(e.action);
    if (!account(e.signerId) || !decimal(e.minimumBlock)) fail();
  } else if (e.chain === "ethereum") {
    if (e.kind === "funding") {
      keys(e, ["chain", "kind", "intent", "minimumBlock"]);
      if (!decimal(e.minimumBlock)) fail();
    } else if (e.kind === "relay") {
      keys(e, ["chain", "kind", "intent", "nonce", "candidateHash"]);
      if (!decimal(e.nonce) || !ethHash(e.candidateHash)) fail();
    } else fail();
    funding(e.intent);
  } else fail();
}
function validateHash(v: unknown, chain: "near" | "ethereum"): void {
  const h = object(v);
  keys(h, ["hash", "status", "detail"], ["blockNumber", "gasUsed", "feeWei"]);
  if (
    !(chain === "near" ? nearHash(h.hash) : ethHash(h.hash)) ||
    !["hint", "pending", "succeeded", "failed"].includes(h.status as string) ||
    !Object.values(HASH_DETAILS).includes(
      h.detail as (typeof HASH_DETAILS)[keyof typeof HASH_DETAILS],
    )
  )
    fail();
  for (const key of ["blockNumber", "gasUsed", "feeWei"])
    if (h[key] !== undefined && !decimal(h[key])) fail();
}
function validateRecord(
  v: unknown,
  binding: { controllerId: string },
): asserts v is StoredOperation {
  json(v, MAX_OPERATION);
  const r = object(v);
  keys(
    r,
    [
      "request",
      "controllerId",
      "createdAt",
      "updatedAt",
      "historical",
      "preparation",
      "steps",
      "continued",
    ],
    ["prepared"],
  );
  parseOperationRequest(r.request);
  if (
    r.controllerId !== binding.controllerId ||
    !decimal(r.createdAt) ||
    !decimal(r.updatedAt) ||
    BigInt(r.updatedAt) < BigInt(r.createdAt) ||
    typeof r.historical !== "boolean" ||
    typeof r.continued !== "boolean"
  )
    fail();
  const p = object(r.preparation);
  keys(p, ["phase", "detail"]);
  if (
    !["preparing", "prepared", "interrupted", "failed"].includes(
      p.phase as string,
    ) ||
    p.detail !== p.phase
  )
    fail();
  if (!Array.isArray(r.steps) || r.steps.length > 2) fail();
  for (const value of r.steps) {
    const s = object(value);
    keys(s, ["expected", "started", "hashes"], ["observation", "diagnostic"]);
    expected(s.expected);
    const e = s.expected as ExpectedStep;
    if (
      typeof s.started !== "boolean" ||
      !Array.isArray(s.hashes) ||
      s.hashes.length > (e.chain === "near" ? 1 : 4)
    )
      fail();
    for (const h of s.hashes) {
      validateHash(h, e.chain);
      if (
        e.chain === "ethereum" &&
        e.kind === "relay" &&
        h.hash !== e.candidateHash
      )
        fail();
    }
    if (
      s.observation !== undefined &&
      ![
        "submission-started",
        "hash",
        "wallet-rejected",
        "wallet-unknown",
      ].includes(s.observation as string)
    )
      fail();
    if (s.diagnostic !== undefined) validateDiagnostic(s.diagnostic);
  }
  if (r.prepared !== undefined) {
    const p = object(r.prepared);
    keys(p, [], ["walletActions", "funding"]);
    if (p.walletActions !== undefined) {
      if (!Array.isArray(p.walletActions) || p.walletActions.length > 2) fail();
      for (const a of p.walletActions) wallet(a);
    }
    if (p.funding !== undefined) funding(p.funding);
  }
}
function stepStatus(s: StoredStep): OperationView["steps"][number]["status"] {
  if (s.hashes.some((h) => h.status === "succeeded")) return "succeeded";
  if (s.hashes.length && s.hashes.every((h) => h.status === "failed"))
    return "failed";
  if (s.hashes.some((h) => h.status === "pending")) return "processing";
  if (s.started || s.hashes.length || s.observation === "wallet-unknown")
    return "needs-check";
  return "prepared";
}
export function operationView(r: StoredOperation): OperationView {
  const steps = r.steps.map((s, index) => {
    const e = s.expected;
    return {
      index,
      chain: e.chain,
      method:
        e.chain === "near"
          ? e.action.methodName
          : e.kind === "funding"
            ? "fund"
            : "relay",
      signerId: e.chain === "near" ? e.signerId : e.intent.from,
      receiverId: e.chain === "near" ? e.action.receiverId : e.intent.to,
      started: s.started,
      status: stepStatus(s),
      ...(s.diagnostic
        ? {
            diagnostic: {
              category: s.diagnostic.category,
              ...(s.diagnostic.name ? { name: s.diagnostic.name } : {}),
              ...(s.diagnostic.code ? { code: s.diagnostic.code } : {}),
            },
          }
        : {}),
      hashes: s.hashes.map((h) => ({
        hash: h.hash,
        status: h.status,
        detail: Object.values(HASH_DETAILS).includes(
          h.detail as (typeof HASH_DETAILS)[keyof typeof HASH_DETAILS],
        )
          ? h.detail
          : HASH_DETAILS.unavailable,
        ...(h.blockNumber !== undefined ? { blockNumber: h.blockNumber } : {}),
        ...(h.gasUsed !== undefined ? { gasUsed: h.gasUsed } : {}),
        ...(h.feeWei !== undefined ? { feeWei: h.feeWei } : {}),
      })),
    };
  });
  const terminal = steps.filter(
    (s) => s.status === "succeeded" || s.status === "failed",
  ).length;
  const unresolved =
    steps.some(
      (s) => s.status === "processing" || s.status === "needs-check",
    ) ||
    r.preparation.phase === "preparing" ||
    r.preparation.phase === "interrupted";
  let stage: OperationView["stage"] = "awaiting-wallet";
  if (steps.length && steps.every((s) => s.status === "succeeded"))
    stage = "succeeded";
  else if (steps.length && terminal === steps.length)
    stage = steps.some((s) => s.status === "succeeded") ? "partial" : "failed";
  else if (terminal) stage = "partial";
  else if (steps.some((s) => s.status === "processing")) stage = "processing";
  else if (unresolved)
    stage = r.preparation.phase === "preparing" ? "preparing" : "needs-check";
  else if (r.preparation.phase === "failed") stage = "failed";
  const details = {
    preparing: "Preparing the operation.",
    "awaiting-wallet": "Prepared; awaiting an explicit wallet action.",
    processing: "Checking known transaction evidence.",
    "needs-check": "Submission is unresolved; check known evidence.",
    succeeded:
      "All operation steps were independently verified; current loan state is separate.",
    failed: "The operation was unsuccessful.",
    partial: "Some steps completed; review each remaining step.",
  };
  return {
    id: r.request.id,
    controllerId: r.controllerId,
    action: r.request.action,
    role: r.request.role,
    historical: r.historical,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    stage,
    unresolved,
    continued: r.continued,
    detail: details[stage],
    steps,
  };
}
export function operationReceipts(records: StoredOperation[]): Receipt[] {
  return records.flatMap((r) =>
    operationView(r).steps.flatMap((s) =>
      s.hashes.map((h) => ({
        id: `${r.request.id}:${s.index}:${h.hash}`,
        chain: s.chain,
        action: s.method,
        status:
          h.status === "succeeded"
            ? ("success" as const)
            : h.status === "failed"
              ? ("rejected" as const)
              : h.status === "pending"
                ? ("pending" as const)
                : ("uncertain" as const),
        hash: h.hash,
        blockNumber: h.blockNumber ?? null,
        gasUsed: h.gasUsed ?? null,
        feeWei: h.feeWei ?? null,
        detail: h.detail,
      })),
    ),
  );
}
interface JournalData {
  version: 1;
  controllerId: string;
  operations: StoredOperation[];
}
function validateData(
  v: unknown,
  binding: { controllerId: string },
): asserts v is JournalData {
  json(v, MAX_FILE);
  const d = object(v);
  keys(d, ["version", "controllerId", "operations"]);
  if (
    d.version !== 1 ||
    d.controllerId !== binding.controllerId ||
    !Array.isArray(d.operations) ||
    d.operations.length > 64
  )
    fail();
  const ids = new Set<string>(),
    hashes = new Set<string>();
  for (const r of d.operations) {
    validateRecord(r, binding);
    if (ids.has(r.request.id)) fail();
    ids.add(r.request.id);
    for (const s of r.steps) {
      const stepHashes = new Set(s.hashes.map((h) => h.hash));
      if (stepHashes.size !== s.hashes.length) fail();
      if (s.expected.chain === "ethereum" && s.expected.kind === "relay")
        stepHashes.add(s.expected.candidateHash);
      for (const hash of stepHashes) {
        if (hashes.has(hash)) fail();
        hashes.add(hash);
      }
    }
  }
}
function immutable(previous: StoredOperation, next: StoredOperation): void {
  for (const key of [
    "request",
    "controllerId",
    "createdAt",
    "historical",
  ] as const)
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) fail();
  if (previous.continued && !next.continued) fail();
  if (
    previous.prepared !== undefined &&
    JSON.stringify(previous.prepared) !== JSON.stringify(next.prepared)
  )
    fail();
  if (next.steps.length < previous.steps.length) fail();
  previous.steps.forEach((s, i) => {
    const n = next.steps[i];
    if (
      JSON.stringify(s.expected) !== JSON.stringify(n.expected) ||
      (s.started && !n.started)
    )
      fail();
    for (const h of s.hashes) {
      const newHash = n.hashes.find((x) => x.hash === h.hash);
      if (
        !newHash ||
        ((h.status === "succeeded" || h.status === "failed") &&
          JSON.stringify(h) !== JSON.stringify(newHash))
      )
        fail();
    }
  });
}
import { open, rename, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { parseAction } from "./safety.ts";
export class OperationJournal {
  private tail: Promise<unknown> = Promise.resolve();
  private unavailable = false;
  private constructor(
    readonly path: string,
    private data: JournalData,
    private binding: { controllerId: string },
    private durableSnapshot?: string,
  ) {}
  static async open(
    path: string,
    binding: { controllerId: string },
  ): Promise<OperationJournal> {
    if (!account(binding.controllerId)) fail();
    let data: JournalData = {
      version: 1,
      controllerId: binding.controllerId,
      operations: [],
    };
    let durableSnapshot: string | undefined;
    try {
      const file = await open(path, "r");
      try {
        if ((await file.stat()).size > MAX_FILE) fail();
        const buffer = Buffer.alloc(MAX_FILE + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_FILE) fail();
        durableSnapshot = buffer.subarray(0, bytesRead).toString("utf8");
        data = JSON.parse(durableSnapshot);
      } finally {
        await file.close();
      }
      validateData(data, binding);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw Error("operation journal unavailable or corrupt");
    }
    const journal = new OperationJournal(
      path,
      clone(data),
      clone(binding),
      durableSnapshot,
    );
    const interrupted = clone(data);
    for (const r of interrupted.operations)
      if (r.preparation.phase === "preparing") {
        r.preparation = { phase: "interrupted", detail: "interrupted" };
        r.updatedAt = String(Math.max(Date.now(), Number(r.updatedAt)));
      }
    if (JSON.stringify(interrupted) !== JSON.stringify(data)) {
      await journal.save(interrupted);
      journal.data = interrupted;
    }
    return journal;
  }
  private assertAvailable(): void {
    if (this.unavailable) throw Error("operation journal requires recovery");
  }
  private async syncDirectory(): Promise<void> {
    const dir = await open(dirname(this.path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  private async save(next: JournalData): Promise<void> {
    this.assertAvailable();
    validateData(next, this.binding);
    const bytes = JSON.stringify(next);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    let created = false;
    let renamed = false;
    const write = async (content: string): Promise<void> => {
      const file = await open(temp, "wx", 0o600);
      created = true;
      try {
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
    };
    try {
      await write(bytes);
      await rename(temp, this.path);
      created = false;
      renamed = true;
      await this.syncDirectory();
      this.durableSnapshot = bytes;
    } catch (error) {
      if (renamed) {
        try {
          if (this.durableSnapshot === undefined) await unlink(this.path);
          else {
            await write(this.durableSnapshot);
            await rename(temp, this.path);
            created = false;
          }
          await this.syncDirectory();
        } catch {
          // Neither memory nor the uncertain disk snapshot may authorize further work.
          this.unavailable = true;
          throw Error("operation journal requires recovery");
        }
      }
      throw error;
    } finally {
      if (created) await unlink(temp).catch(() => {});
    }
  }
  private serialize<T>(change: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      this.assertAvailable();
      return change();
    });
    this.tail = result.catch(() => {});
    return result;
  }
  start(
    request: OperationRequest,
    historical = false,
  ): Promise<{ record: StoredOperation; created: boolean }> {
    return this.serialize(async () => {
      const parsed = parseOperationRequest(request);
      if (typeof historical !== "boolean") fail();
      const existing = this.data.operations.find(
        (r) => r.request.id === parsed.id,
      );
      if (existing) {
        if (
          JSON.stringify(existing.request) !== JSON.stringify(parsed) ||
          existing.historical !== historical
        )
          throw Error("operation request conflict");
        return { record: clone(existing), created: false };
      }
      if (this.data.operations.length >= 64)
        throw Error("operation journal capacity reached");
      const now = String(Date.now());
      const record: StoredOperation = {
        request: parsed,
        controllerId: this.binding.controllerId,
        createdAt: now,
        updatedAt: now,
        historical,
        preparation: { phase: "preparing", detail: "preparing" },
        steps: [],
        continued: false,
      };
      const next = clone(this.data);
      next.operations.push(record);
      await this.save(next);
      this.data = next;
      return { record: clone(record), created: true };
    });
  }
  get(id: string): StoredOperation | undefined {
    this.assertAvailable();
    const r = this.data.operations.find((r) => r.request.id === id);
    return r ? clone(r) : undefined;
  }
  records(): StoredOperation[] {
    this.assertAvailable();
    return clone(this.data.operations);
  }
  list(): OperationView[] {
    this.assertAvailable();
    return this.data.operations.map(operationView);
  }
  update(
    id: string,
    change: (copy: StoredOperation) => void,
  ): Promise<StoredOperation> {
    return this.serialize(async () => {
      const index = this.data.operations.findIndex((r) => r.request.id === id);
      if (index < 0) throw Error("operation not found");
      const next = clone(this.data);
      const record = next.operations[index];
      change(record);
      record.updatedAt = String(
        Math.max(Date.now(), Number(this.data.operations[index].updatedAt)),
      );
      validateRecord(record, this.binding);
      immutable(this.data.operations[index], record);
      const snapshot = clone(next);
      await this.save(snapshot);
      this.data = snapshot;
      return clone(snapshot.operations[index]);
    });
  }
  receipts(): Receipt[] {
    this.assertAvailable();
    return operationReceipts(this.data.operations);
  }
}

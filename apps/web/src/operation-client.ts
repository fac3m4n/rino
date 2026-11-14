import type {
  ActionName,
  Config,
  OperationObservation,
  OperationRequest,
  OperationResult,
  OperationView,
  Role,
} from "@rino/coordinator/api";
import { DIAGNOSTIC_CODES, DIAGNOSTIC_NAMES } from "@rino/coordinator/api";
import {
  ACTION_TIMEOUT_MS,
  GET_TIMEOUT_MS,
  postApi,
  readApi,
  RequestFailure,
  validateApiBase,
} from "./client";
import { ActionFailure, submissionFailure } from "./outcomes";
import type { WalletProgress } from "./wallets";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const actions = [
  "initialize",
  "fund",
  "prove",
  "borrow",
  "repay",
  "default",
  "cancel",
  "settle",
  "claim",
  "challenge-forgery",
  "challenge-duplicate",
  "advance-maturity",
  "recover",
];
const legacyHintKey = "rino.operations.v1";
export function operationStorageKey(config: Config): string {
  return `${legacyHintKey}:${config.near.networkId}:${config.near.controllerId}`;
}
type ObjectValue = Record<string, unknown>;
function object(v: unknown): v is ObjectValue {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function keys(v: ObjectValue, allowed: string[]) {
  if (Object.keys(v).some((k) => !allowed.includes(k)))
    throw Error(
      "Operation recovery data is invalid. Financial actions remain paused.",
    );
}
function text(v: unknown, max = 512): v is string {
  return typeof v === "string" && v.length <= max;
}
function one(v: unknown, values: string[]) {
  return typeof v === "string" && values.includes(v);
}
function invalid(): never {
  throw Error(
    "Operation recovery data is invalid. Financial actions remain paused.",
  );
}
export function validHash(hash: string, chain: "near" | "ethereum"): boolean {
  if (chain === "ethereum") return /^0x[0-9a-fA-F]{64}$/.test(hash);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash)) return false;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n,
    bytes = 0;
  for (const c of hash) n = n * 58n + BigInt(alphabet.indexOf(c));
  while (n) {
    bytes++;
    n >>= 8n;
  }
  return bytes + (hash.match(/^1*/)?.[0].length ?? 0) === 32;
}
export function parseOperations(
  raw: unknown,
  controllerId: string,
): OperationView[] {
  if (
    !Array.isArray(raw) ||
    raw.length > 64 ||
    JSON.stringify(raw).length > 8 * 1024 * 1024
  )
    invalid();
  const ids = new Set<string>();
  for (const op of raw) {
    if (!object(op)) invalid();
    keys(op, [
      "id",
      "controllerId",
      "action",
      "role",
      "historical",
      "createdAt",
      "updatedAt",
      "stage",
      "unresolved",
      "continued",
      "detail",
      "steps",
    ]);
    if (
      !text(op.id, 36) ||
      !UUID.test(op.id) ||
      ids.has(op.id) ||
      op.controllerId !== controllerId ||
      !one(op.action, actions) ||
      !one(op.role, ["borrower", "lender"]) ||
      typeof op.historical !== "boolean" ||
      typeof op.unresolved !== "boolean" ||
      typeof op.continued !== "boolean" ||
      !one(op.stage, [
        "preparing",
        "awaiting-wallet",
        "processing",
        "needs-check",
        "succeeded",
        "failed",
        "partial",
      ]) ||
      !text(op.detail) ||
      ![op.createdAt, op.updatedAt].every(
        (v) => text(v, 16) && /^(0|[1-9][0-9]*)$/.test(v),
      ) ||
      !Array.isArray(op.steps) ||
      op.steps.length > 2 ||
      JSON.stringify(op).length > 98304
    )
      invalid();
    ids.add(op.id);
    for (const [index, step] of op.steps.entries()) {
      if (!object(step)) invalid();
      keys(step, [
        "index",
        "chain",
        "method",
        "signerId",
        "receiverId",
        "started",
        "status",
        "hashes",
        "diagnostic",
      ]);
      if (
        step.index !== index ||
        !one(step.chain, ["near", "ethereum"]) ||
        !text(step.method, 128) ||
        !text(step.signerId, 128) ||
        !text(step.receiverId, 128) ||
        typeof step.started !== "boolean" ||
        !one(step.status, [
          "prepared",
          "processing",
          "needs-check",
          "succeeded",
          "failed",
        ]) ||
        !Array.isArray(step.hashes) ||
        step.hashes.length > (step.chain === "near" ? 1 : 4)
      )
        invalid();
      for (const h of step.hashes) {
        if (!object(h)) invalid();
        keys(h, [
          "hash",
          "status",
          "detail",
          "blockNumber",
          "gasUsed",
          "feeWei",
        ]);
        if (
          !text(h.hash, 66) ||
          !validHash(h.hash, step.chain as "near" | "ethereum") ||
          !one(h.status, ["hint", "pending", "succeeded", "failed"]) ||
          !text(h.detail) ||
          ![h.blockNumber, h.gasUsed, h.feeWei].every(
            (v) =>
              v === undefined || (text(v, 80) && /^(0|[1-9][0-9]*)$/.test(v)),
          )
        )
          invalid();
      }
      if (step.diagnostic !== undefined) {
        const d = step.diagnostic;
        if (!object(d)) invalid();
        keys(d, ["category", "name", "code"]);
        if (
          !one(d.category, [
            "wallet-closed",
            "timeout",
            "rejected",
            "transport",
            "unknown",
          ]) ||
          (d.name !== undefined && !one(d.name, [...DIAGNOSTIC_NAMES])) ||
          (d.code !== undefined && !one(d.code, [...DIAGNOSTIC_CODES]))
        )
          invalid();
      }
    }
  }
  return raw as OperationView[];
}
export function operationPaused(operations: OperationView[]): boolean {
  return operations.some(
    (op) =>
      !op.historical &&
      !op.continued &&
      (op.unresolved ||
        op.stage === "preparing" ||
        op.stage === "awaiting-wallet"),
  );
}
export function mergeOperations(
  old: OperationView[],
  incoming: OperationView[],
): OperationView[] {
  const result = new Map(old.map((op) => [op.id, op]));
  for (const op of incoming) {
    const previous = result.get(op.id);
    if (!previous) {
      result.set(op.id, op);
      continue;
    }
    if (BigInt(op.updatedAt) < BigInt(previous.updatedAt)) continue;
    const continued = previous.continued || op.continued;
    if (
      !previous.unresolved &&
      (previous.stage === "succeeded" ||
        previous.stage === "failed" ||
        (previous.stage === "partial" &&
          previous.steps.length > 0 &&
          previous.steps.every((step) =>
            ["succeeded", "failed"].includes(step.status),
          )))
    ) {
      result.set(op.id, { ...previous, continued });
      continue;
    }
    // Journal timestamps are non-strict. Join irreversible observations instead
    // of treating equal milliseconds as a response-order revision.
    const steps = Array.from(
      { length: Math.max(previous.steps.length, op.steps.length) },
      (_, index) => {
        const before = previous.steps[index],
          next = op.steps[index];
        if (!before) return next;
        if (
          !next ||
          before.status === "succeeded" ||
          before.status === "failed"
        )
          return before;
        if (
          ["chain", "method", "signerId", "receiverId"].some(
            (key) =>
              before[key as keyof typeof before] !==
              next[key as keyof typeof next],
          )
        )
          invalid();
        const hashes = new Map(before.hashes.map((hash) => [hash.hash, hash]));
        for (const hash of next.hashes) {
          const known = hashes.get(hash.hash);
          if (
            !known ||
            (!["succeeded", "failed"].includes(known.status) &&
              !(known.status === "pending" && hash.status === "hint"))
          )
            hashes.set(hash.hash, hash);
        }
        if (hashes.size > (next.chain === "near" ? 1 : 4)) invalid();
        const mergedHashes = [...hashes.values()];
        const started = before.started || next.started;
        const status = mergedHashes.some((hash) => hash.status === "succeeded")
          ? "succeeded"
          : mergedHashes.length &&
              mergedHashes.every((hash) => hash.status === "failed")
            ? "failed"
            : mergedHashes.some((hash) => hash.status === "pending")
              ? "processing"
              : started ||
                  mergedHashes.length ||
                  before.status === "needs-check" ||
                  next.status === "needs-check"
                ? "needs-check"
                : "prepared";
        return {
          ...next,
          started,
          status,
          hashes: mergedHashes,
        } as OperationView["steps"][number];
      },
    );
    const terminal = steps.filter((step) =>
      ["succeeded", "failed"].includes(step.status),
    ).length;
    const stage =
      steps.length && steps.every((step) => step.status === "succeeded")
        ? "succeeded"
        : steps.length && terminal === steps.length
          ? steps.some((step) => step.status === "succeeded")
            ? "partial"
            : "failed"
          : terminal
            ? "partial"
            : steps.some((step) => step.status === "processing")
              ? "processing"
              : steps.some((step) => step.status === "needs-check")
                ? "needs-check"
                : op.stage;
    const unresolved =
      op.unresolved ||
      steps.some((step) => ["processing", "needs-check"].includes(step.status));
    const detail =
      stage === op.stage
        ? op.detail
        : stage === "partial"
          ? "Some steps completed; review each remaining step."
          : stage === "succeeded"
            ? "All operation steps were independently verified; current loan state is separate."
            : stage === "failed"
              ? "The operation was unsuccessful."
              : "Submission is unresolved; check known evidence.";
    result.set(op.id, { ...op, continued, steps, stage, unresolved, detail });
  }
  if (result.size > 64)
    throw Error(
      "Operation recovery capacity reached. Existing unresolved history is preserved.",
    );
  return [...result.values()];
}
type Hint = {
  id: string;
  action: ActionName;
  role: Role;
  step: number;
  hash: string;
};
type StoredRecovery = { hints: Hint[]; requests: OperationRequest[] };
function storedKeys(
  value: ObjectValue,
  required: string[],
  optional: string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => required.includes(key) || optional.includes(key),
    )
  );
}
function readableRecovery(
  value: unknown,
  config: Config,
  scoped: boolean,
): value is StoredRecovery {
  if (
    !object(value) ||
    !storedKeys(
      value,
      ["version", "controllerId", "hints", "requests"],
      ["networkId"],
    ) ||
    value.version !== 1 ||
    value.controllerId !== config.near.controllerId ||
    (scoped
      ? value.networkId !== config.near.networkId
      : value.networkId !== undefined &&
        value.networkId !== config.near.networkId) ||
    !Array.isArray(value.hints) ||
    value.hints.length > 512 ||
    !Array.isArray(value.requests) ||
    value.requests.length > 64
  )
    return false;
  const hints = new Set<string>(),
    requests = new Set<string>();
  for (const hint of value.hints) {
    if (
      !object(hint) ||
      !storedKeys(hint, ["id", "action", "role", "step", "hash"]) ||
      !text(hint.id, 36) ||
      !UUID.test(hint.id) ||
      !one(hint.action, actions) ||
      !one(hint.role, ["borrower", "lender"]) ||
      (hint.step !== 0 && hint.step !== 1) ||
      !text(hint.hash, 66) ||
      !(validHash(hint.hash, "near") || validHash(hint.hash, "ethereum"))
    )
      return false;
    const identity = `${hint.id}:${hint.step}:${hint.hash}`;
    if (hints.has(identity)) return false;
    hints.add(identity);
  }
  for (const request of value.requests) {
    if (
      !object(request) ||
      !storedKeys(request, ["id", "action", "role"], ["evmSender"]) ||
      !text(request.id, 36) ||
      !UUID.test(request.id) ||
      requests.has(request.id) ||
      !one(request.action, actions) ||
      !one(request.role, ["borrower", "lender"]) ||
      (request.evmSender !== undefined &&
        (!text(request.evmSender, 42) ||
          !/^0x[0-9a-fA-F]{40}$/.test(request.evmSender)))
    )
      return false;
    requests.add(request.id);
  }
  return true;
}
export class OperationClient {
  private live = true;
  private queues = new Map<string, Promise<unknown>>();
  private hints: Hint[] = [];
  private requests: OperationRequest[] = [];
  private checking = new Map<string, Promise<OperationView>>();
  private storageWritable = false;
  private readonly storageKey: string;
  constructor(
    private config: Config,
    private changed: (op: OperationView) => void,
    private storage?: Pick<Storage, "getItem" | "setItem">,
    private readonly apiBase = "/api",
  ) {
    validateApiBase(apiBase);
    this.storageKey = operationStorageKey(config);
    try {
      const current = storage?.getItem(this.storageKey);
      const scoped = current !== null && current !== undefined;
      const raw = scoped ? current : storage?.getItem(legacyHintKey);
      if (raw === null || raw === undefined) {
        this.storageWritable = true;
        return;
      }
      if (typeof raw !== "string" || raw.length > 98304) return;
      const parsed: unknown = JSON.parse(raw);
      if (
        !scoped &&
        object(parsed) &&
        typeof parsed.controllerId === "string" &&
        (parsed.controllerId !== config.near.controllerId ||
          (parsed.networkId !== undefined &&
            parsed.networkId !== config.near.networkId))
      ) {
        // Another market's legacy evidence stays intact; this namespace is new.
        this.storageWritable = true;
        return;
      }
      // Validate the complete payload before permitting any write. Filtering a
      // partially unreadable record would erase evidence needed for recovery.
      if (!readableRecovery(parsed, config, scoped)) return;
      this.hints = parsed.hints.map((hint) => ({ ...hint }));
      this.requests = parsed.requests.map((request) => ({ ...request }));
      this.storageWritable = true;
      // A valid migration is marked once so cleared requests cannot resurrect.
      if (!scoped) this.save();
    } catch {
      // Reads that fail never authorize writes over the unreadable record.
      // Server recovery remains available without discarding browser evidence.
    }
  }

  dispose() {
    this.live = false;
  }
  updateConfig(config: Config) {
    if (
      config.mode !== "public" ||
      config.near.controllerId !== this.config.near.controllerId ||
      config.near.networkId !== this.config.near.networkId ||
      config.capabilities?.operations !== true
    )
      invalid();
    this.config = config;
  }
  private save() {
    if (!this.storageWritable) return;
    try {
      this.storage?.setItem(
        this.storageKey,
        JSON.stringify({
          version: 1,
          controllerId: this.config.near.controllerId,
          networkId: this.config.near.networkId,
          hints: this.hints,
          requests: this.requests,
        }),
      );
    } catch {
      /* Server record still recovers without browser hints. */
    }
  }
  private preparing(request: OperationRequest): OperationView {
    return {
      id: request.id,
      controllerId: this.config.near.controllerId,
      action: request.action,
      role: request.role,
      historical: false,
      createdAt: "0",
      updatedAt: "0",
      stage: "preparing",
      unresolved: false,
      continued: false,
      detail:
        "Preparation response needs checking. The wallet has not been reopened.",
      steps: [],
    };
  }
  private publish(raw: unknown, id?: string): OperationView {
    const op = parseOperations([raw], this.config.near.controllerId)[0];
    if (id && op.id !== id) invalid();
    if (
      op.continued ||
      (!op.unresolved && ["succeeded", "failed"].includes(op.stage))
    ) {
      this.requests = this.requests.filter((request) => request.id !== op.id);
      this.hints = this.hints.filter((hint) => hint.id !== op.id);
      this.save();
    }
    if (this.live) this.changed(op);
    return op;
  }
  private remember(op: OperationView, observation: OperationObservation) {
    if (
      !observation.hash ||
      !validHash(observation.hash, op.steps[observation.step]?.chain)
    )
      return;
    const hint: Hint = {
      id: op.id,
      action: op.action,
      role: op.role,
      step: observation.step,
      hash: observation.hash,
    };
    if (
      !this.hints.some(
        (h) => h.id === hint.id && h.step === hint.step && h.hash === hint.hash,
      )
    ) {
      if (
        this.hints.filter((h) => h.id === hint.id && h.step === hint.step)
          .length >= (op.steps[hint.step].chain === "near" ? 1 : 4) ||
        this.hints.length >= 512
      )
        return;
      this.hints.push(hint);
    }
    this.save();
  }
  async create(
    action: ActionName,
    role: Role,
    evmSender?: string,
  ): Promise<OperationResult> {
    const request: OperationRequest = {
      id: crypto.randomUUID(),
      action,
      role,
      ...(evmSender ? { evmSender } : {}),
    };
    if (this.requests.length >= 64)
      throw Error(
        "Browser operation hint capacity reached. Review existing operations before continuing.",
      );
    this.requests.push(request);
    this.save();
    this.publish(this.preparing(request));
    // One attempt only: a lost create response must never re-prepare an action.
    const result = await postApi<OperationResult>(
      this.config,
      "operations",
      request,
      { apiBase: this.apiBase },
    );
    const op = this.publish(result.operation, request.id);
    if (op.action !== action || op.role !== role || op.historical) invalid();
    return result;
  }
  observe(
    op: OperationView,
    observation: OperationObservation,
  ): Promise<OperationView> {
    this.remember(op, observation);
    const previous = this.queues.get(op.id) ?? Promise.resolve();
    const result = previous
      .catch(() => {})
      .then(async () => {
        const path = `operations/${op.id}/observe`;
        let value: unknown;
        try {
          value = await postApi(this.config, path, observation, {
            timeoutMs: GET_TIMEOUT_MS,
            apiBase: this.apiBase,
          });
        } catch (error) {
          if (
            !(error instanceof RequestFailure) ||
            error.responseCode !== "ACTION_REJECTED"
          )
            throw error;
          const fresh = await readApi<Config>("config", {
            fresh: true,
            apiBase: this.apiBase,
          });
          if (fresh.csrfToken === this.config.csrfToken) throw error;
          this.updateConfig(fresh);
          value = await postApi(this.config, path, observation, {
            timeoutMs: GET_TIMEOUT_MS,
            apiBase: this.apiBase,
          });
        }
        return this.publish(value, op.id);
      });
    this.queues.set(op.id, result);
    void result
      .finally(() => {
        if (this.queues.get(op.id) === result) this.queues.delete(op.id);
      })
      .catch(() => {});
    return result;
  }
  async recoverHints(operations: OperationView[]) {
    for (const request of this.requests)
      if (!operations.some((op) => op.id === request.id))
        this.publish(this.preparing(request));
    this.requests = this.requests.filter(
      (request) =>
        !operations.some(
          (op) =>
            op.id === request.id &&
            !op.unresolved &&
            !["preparing", "awaiting-wallet"].includes(op.stage),
        ),
    );
    this.save();
    for (const hint of this.hints) {
      const op = operations.find(
        (op) =>
          op.id === hint.id &&
          op.action === hint.action &&
          op.role === hint.role &&
          !op.historical &&
          op.unresolved,
      );
      const step = op?.steps[hint.step];
      if (
        op &&
        step &&
        validHash(hint.hash, step.chain) &&
        !step.hashes.some((h) => h.hash === hint.hash)
      )
        await this.observe(op, {
          step: hint.step,
          event: "hash",
          hash: hint.hash,
        });
    }
  }
  check(op: OperationView): Promise<OperationView> {
    const active = this.checking.get(op.id);
    if (active) return active;
    const result = postApi(
      this.config,
      `operations/${op.id}/reconcile`,
      {},
      { timeoutMs: GET_TIMEOUT_MS, apiBase: this.apiBase },
    ).then((value) => this.publish(value, op.id));
    this.checking.set(op.id, result);
    void result
      .finally(() => {
        if (this.checking.get(op.id) === result) this.checking.delete(op.id);
      })
      .catch(() => {});
    return result;
  }
  async continue(op: OperationView): Promise<OperationView> {
    return this.publish(
      await postApi(
        this.config,
        `operations/${op.id}/continue`,
        {},
        { timeoutMs: GET_TIMEOUT_MS, apiBase: this.apiBase },
      ),
      op.id,
    );
  }
  async import(
    action: ActionName,
    role: Role,
    hash: string,
  ): Promise<OperationView> {
    if (!validHash(hash, "near"))
      throw Error("Enter a valid NEAR transaction hash.");
    const id = crypto.randomUUID();
    return this.publish(
      await postApi(
        this.config,
        "operations/import",
        { id, action, role, hash },
        { timeoutMs: GET_TIMEOUT_MS, apiBase: this.apiBase },
      ),
      id,
    );
  }
  async wallet(
    op: OperationView,
    invoke: (progress: WalletProgress) => Promise<unknown>,
  ): Promise<void> {
    let attempted: number | undefined;
    let acceptingStarts = true;
    const requireStartAuthority = () => {
      if (!this.live || !acceptingStarts)
        throw new ActionFailure(
          "Wallet observation ended. No further wallet submission was started; the original operation remains recorded.",
          "unknown",
          "before-submission",
          [],
          { category: this.live ? "timeout" : "unknown" },
        );
    };
    const progress: WalletProgress = async (event) => {
      if (
        !op.steps[event.step] ||
        (event.event === "hash" &&
          (!event.hash || !validHash(event.hash, op.steps[event.step].chain)))
      )
        throw Error("Invalid wallet progress.");
      if (event.event === "submission-started") requireStartAuthority();
      await this.observe(op, event);
      if (event.event === "submission-started") {
        requireStartAuthority();
        attempted = event.step;
      }
    };
    const delivery = Promise.resolve()
      .then(() => invoke(progress))
      .catch(async (error) => {
        const failure = submissionFailure(error, []);
        if (attempted !== undefined) {
          try {
            await this.observe(op, {
              step: attempted,
              event:
                failure.outcome === "rejected"
                  ? "wallet-rejected"
                  : "wallet-unknown",
              diagnostic: failure.diagnostic ?? { category: "unknown" },
            });
          } catch {
            /* Never reopen the wallet after lost metadata. */
          }
        }
        throw failure;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        acceptingStarts = false;
        if (attempted !== undefined)
          void this.observe(op, {
            step: attempted,
            event: "wallet-unknown",
            diagnostic: { category: "timeout", code: "TIMEOUT" },
          }).catch(() => {});
        reject(
          new ActionFailure(
            "Wallet response deadline exceeded. The original request may still complete; check this operation before continuing.",
            "unknown",
            "confirmation",
            [],
            { category: "timeout", code: "TIMEOUT" },
          ),
        );
      }, ACTION_TIMEOUT_MS);
    });
    try {
      await Promise.race([delivery, deadline]);
    } finally {
      acceptingStarts = false;
      clearTimeout(timer);
    }
  }
}

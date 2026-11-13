/** Metadata recovery never prepares or submits a financial action during reconciliation. */
import type { State, WalletAction, Receipt } from "./api.ts";
import type {
  OperationRequest,
  OperationObservation,
  OperationView,
  OperationResult,
  OperationHashView,
  FundingIntent,
} from "./operations-api.ts";
import {
  OperationJournal,
  operationView,
  HASH_DETAILS,
  parseOperationRequest,
  parseOperationObservation,
  parseOperationImport,
  type ExpectedStep,
  type StoredOperation,
  type StoredStep,
} from "./operations.ts";
import type { ReceiptVerifier } from "./receipt-verifier.ts";
import { SerialQueue } from "./safety.ts";

export interface OperationPreparation {
  steps: ExpectedStep[];
  walletActions?: WalletAction[];
  funding?: FundingIntent;
  state?: State;
}
interface Dependencies {
  journal: OperationJournal;
  verifier: Pick<ReceiptVerifier, "verify" | "importNear">;
  binding: { controllerId: string; borrowerId: string; lenderId: string };
  prepare: (
    request: OperationRequest,
    beforeRelay: (expected: ExpectedStep) => Promise<void>,
  ) => Promise<OperationPreparation>;
  replacement?: (
    expected: Extract<ExpectedStep, { chain: "ethereum"; kind: "funding" }>,
    original: string,
    candidate: string,
  ) => Promise<"same-nonce" | "mismatch" | "unavailable">;
  readiness: () => Promise<string[]>;
  state: () => Promise<State>;
  now?: () => number;
}
export class PublicOperations {
  private readonly queue = new SerialQueue(4);
  private readonly checking = new Map<string, Promise<OperationView>>();
  private readonly checks = new Map<
    string,
    { until: number; value: OperationView }
  >();
  private readonly evidence = new Map<
    string,
    { until: number; value: OperationHashView }
  >();
  private readonly imports = new Map<
    string,
    {
      until: number;
      value?: Awaited<ReturnType<ReceiptVerifier["importNear"]>>;
    }
  >();
  private readonly replacements = new Map<
    string,
    { until: number; value: "same-nonce" | "mismatch" | "unavailable" }
  >();
  private readonly failedUntil = new Map<string, number>();
  private readonly now: () => number;
  constructor(private readonly dependencies: Dependencies) {
    this.now = dependencies.now ?? (() => Date.now());
  }
  private record(id: string): StoredOperation {
    const value = this.dependencies.journal.get(id);
    if (!value) throw Error("operation not found");
    return value;
  }
  private async ready(): Promise<void> {
    if ((await this.dependencies.readiness()).length)
      throw Error("public operation readiness unavailable");
  }
  list(): OperationView[] {
    return this.dependencies.journal.list();
  }
  receipts(): Receipt[] {
    return this.dependencies.journal.receipts();
  }
  create(input: OperationRequest): Promise<OperationResult> {
    const request = parseOperationRequest(input);
    return this.queue.run(async () => {
      const old = this.dependencies.journal.get(request.id);
      if (
        !old &&
        this.dependencies.journal
          .records()
          .some(
            (r) => !r.historical && !r.continued && operationView(r).unresolved,
          )
      )
        throw Error(
          "unresolved operation requires review or explicit continuation",
        );
      const { record, created } =
        await this.dependencies.journal.start(request);
      if (!created) return this.result(record);
      try {
        const prepared = await this.dependencies.prepare(
          request,
          async (expected) => {
            if (expected.chain !== "ethereum" || expected.kind !== "relay")
              throw Error("invalid relay context");
            await this.dependencies.journal.update(request.id, (r) => {
              if (r.steps.length) throw Error("relay context already recorded");
              r.steps = [
                {
                  expected,
                  started: true,
                  observation: "submission-started",
                  hashes: [
                    {
                      hash: expected.candidateHash,
                      status: "hint",
                      detail: HASH_DETAILS.recorded,
                    },
                  ],
                },
              ];
            });
          },
        );
        const saved = await this.dependencies.journal.update(
          request.id,
          (r) => {
            // An authorized relay context has already been committed before its broadcast.
            if (r.steps.length)
              throw Error("relay preparation cannot return replayable actions");
            r.steps = prepared.steps.map((expected) => ({
              expected,
              started: false,
              hashes: [],
            }));
            r.prepared = {
              ...(prepared.walletActions
                ? { walletActions: prepared.walletActions }
                : {}),
              ...(prepared.funding ? { funding: prepared.funding } : {}),
            };
            r.preparation = { phase: "prepared", detail: "prepared" };
          },
        );
        return {
          ...this.result(saved),
          ...(prepared.state ? { state: prepared.state } : {}),
        };
      } catch (error) {
        let awaitingFinality = false;
        try {
          // Read only an Error's own data value; arbitrary accessors/causes are untrusted.
          const message =
            error instanceof Error
              ? Object.getOwnPropertyDescriptor(error, "message")?.value
              : undefined;
          awaitingFinality =
            typeof message === "string" &&
            message.length <= 256 &&
            /^Captured block (?:0|[1-9][0-9]{0,77}); awaiting both fixed providers finalized coverage before wallet request$/.exec(
              message,
            )?.[0] === message;
        } catch {
          // Hostile error objects must not prevent durable generic failure metadata.
        }
        const saved = await this.dependencies.journal.update(
          request.id,
          (r) => {
            const phase = r.steps.some((s) => s.started)
              ? "interrupted"
              : "failed";
            r.preparation = {
              phase,
              detail:
                phase === "failed" && r.steps.length === 0 && awaitingFinality
                  ? "awaiting-finality"
                  : phase,
            };
          },
        );
        return { operation: operationView(saved) };
      }
    });
  }
  private result(record: StoredOperation): OperationResult {
    return {
      operation: operationView(record),
      ...(!record.steps.some(
        (s) => s.started || s.hashes.length || s.observation,
      ) && record.preparation.phase === "prepared"
        ? record.prepared
        : {}),
    };
  }
  private async verify(
    id: string,
    expected: ExpectedStep,
    hash: string,
    respectCooldown = true,
  ): Promise<OperationHashView> {
    if (respectCooldown && this.now() < (this.failedUntil.get(id) ?? 0))
      return { hash, status: "hint", detail: HASH_DETAILS.unavailable };
    const key = JSON.stringify([expected, hash]);
    const cached = this.evidence.get(key);
    if (cached && this.now() < cached.until)
      return structuredClone(cached.value);
    for (const [k, v] of this.evidence)
      if (this.now() >= v.until) this.evidence.delete(k);
    if (this.evidence.size >= 512)
      throw Error("operation evidence capacity reached");
    let value: OperationHashView;
    try {
      await this.ready();
      value = await this.dependencies.verifier.verify(expected, hash);
    } catch {
      value = { hash, status: "hint", detail: HASH_DETAILS.unavailable };
    }
    if (value.detail === HASH_DETAILS.unavailable)
      this.failedUntil.set(id, this.now() + 30000);
    this.evidence.set(key, {
      value: structuredClone(value),
      until:
        this.now() + (value.detail === HASH_DETAILS.unavailable ? 30000 : 5000),
    });
    return value;
  }
  private consumeRevertedNonce(step: StoredStep): void {
    if (
      step.expected.chain !== "ethereum" ||
      step.expected.kind !== "funding" ||
      !step.hashes.some(
        (h) => h.status === "failed" && h.detail === HASH_DETAILS.failed,
      )
    )
      return;
    for (const hash of step.hashes)
      if (hash.status !== "failed" && hash.status !== "succeeded") {
        Object.assign(hash, {
          status: "failed",
          detail: HASH_DETAILS.replaced,
        });
        delete hash.blockNumber;
        delete hash.gasUsed;
        delete hash.feeWei;
      }
  }
  private async checkReplacement(
    id: string,
    expected: Extract<ExpectedStep, { chain: "ethereum"; kind: "funding" }>,
    original: string,
    candidate: string,
  ): Promise<void> {
    const key = JSON.stringify([expected, original, candidate]);
    let cached = this.replacements.get(key);
    if (!cached || this.now() >= cached.until) {
      if (this.now() < (this.failedUntil.get(id) ?? 0))
        throw Error(
          "funding replacement nonce unavailable; preserve original uncertainty",
        );
      for (const [k, v] of this.replacements)
        if (this.now() >= v.until) this.replacements.delete(k);
      if (this.replacements.size >= 512)
        throw Error("replacement check capacity reached");
      let value: "same-nonce" | "mismatch" | "unavailable" = "unavailable";
      try {
        await this.ready();
        value =
          (await this.dependencies.replacement?.(
            expected,
            original,
            candidate,
          )) ?? "unavailable";
      } catch {}
      const until = this.now() + (value === "unavailable" ? 30000 : 5000);
      if (value === "unavailable") this.failedUntil.set(id, until);
      cached = { value, until };
      this.replacements.set(key, cached);
    }
    if (cached.value !== "same-nonce")
      throw Error(
        "funding replacement nonce unavailable or mismatched; preserve original uncertainty",
      );
  }
  observe(id: string, input: OperationObservation): Promise<OperationView> {
    const observation = parseOperationObservation(input);
    return this.queue.run(async () => {
      const record = this.record(id),
        step = record.steps[observation.step];
      if (!step) throw Error("operation step not found");
      let verified: OperationHashView | undefined;
      if (observation.event === "hash") {
        const hash = observation.hash!;
        const existing = step.hashes.find((h) => h.hash === hash);
        if (existing) return operationView(record);
        const chain = step.expected.chain;
        if (
          chain === "near"
            ? !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash)
            : !/^0x[0-9a-f]{64}$/.test(hash)
        )
          throw Error("hash chain mismatch");
        if (step.hashes.length >= (chain === "near" ? 1 : 4))
          throw Error("operation hash capacity reached");
        if (
          this.dependencies.journal
            .records()
            .some((r) =>
              r.steps.some(
                (s) =>
                  s.hashes.some((h) => h.hash === hash) ||
                  (s.expected.chain === "ethereum" &&
                    s.expected.kind === "relay" &&
                    s.expected.candidateHash === hash),
              ),
            )
        )
          throw Error("operation hash already bound");
        if (
          step.expected.chain === "ethereum" &&
          step.expected.kind === "funding" &&
          step.hashes.length
        ) {
          if (
            step.hashes.some(
              (h) => h.status === "succeeded" || h.status === "failed",
            )
          )
            throw Error("final funding nonce cannot be replaced");
          await this.checkReplacement(
            id,
            step.expected,
            step.hashes[0].hash,
            hash,
          );
        }
        verified = await this.verify(id, step.expected, hash);
        if (verified.detail === HASH_DETAILS.mismatch)
          throw Error("transaction does not match operation");
      }
      const saved = await this.dependencies.journal.update(id, (r) => {
        const target = r.steps[observation.step];
        if (
          observation.event === "submission-started" ||
          observation.event === "wallet-unknown" ||
          observation.event === "hash"
        )
          target.started = true;
        target.observation = observation.event;
        if (observation.diagnostic) target.diagnostic = observation.diagnostic;
        if (verified) target.hashes.push(verified);
        this.consumeRevertedNonce(target);
      });
      this.checks.delete(id);
      return operationView(saved);
    });
  }
  reconcile(id: string): Promise<OperationView> {
    this.record(id);
    const active = this.checking.get(id);
    if (active) return active;
    const cached = this.checks.get(id);
    if (cached && this.now() < cached.until)
      return Promise.resolve(structuredClone(cached.value));
    const work = this.queue
      .run(async () => {
        let record = this.record(id);
        let unavailable = false;
        const respectCooldown = this.now() < (this.failedUntil.get(id) ?? 0);
        const results: Array<{ index: number; value: OperationHashView }> = [];
        for (const [index, step] of record.steps.entries()) {
          if (step.hashes.some((h) => h.status === "succeeded")) continue;
          for (const hash of step.hashes) {
            if (hash.status === "succeeded" || hash.status === "failed")
              continue;
            const value = await this.verify(
              id,
              step.expected,
              hash.hash,
              respectCooldown,
            );
            unavailable ||= value.detail === HASH_DETAILS.unavailable;
            // A later context mismatch is unresolved evidence, never a verdict for the intended action.
            if (JSON.stringify(value) !== JSON.stringify(hash))
              results.push({ index, value });
          }
        }
        if (results.length)
          record = await this.dependencies.journal.update(id, (r) => {
            for (const { index, value } of results) {
              const hash = r.steps[index].hashes.find(
                (h) => h.hash === value.hash,
              )!;
              Object.assign(hash, value);
            }
            for (const step of r.steps) this.consumeRevertedNonce(step);
            if (
              r.preparation.phase === "interrupted" &&
              r.steps.length &&
              r.steps.every(
                (s) =>
                  s.hashes.some((h) => h.status === "succeeded") ||
                  (s.hashes.length > 0 &&
                    s.hashes.every((h) => h.status === "failed")),
              )
            )
              r.preparation = { phase: "prepared", detail: "prepared" };
          });
        const value = operationView(record);
        this.checks.set(id, {
          value: structuredClone(value),
          until: unavailable
            ? (this.failedUntil.get(id) ?? this.now() + 30000)
            : this.now() + 5000,
        });
        return value;
      })
      .finally(() => {
        if (this.checking.get(id) === work) this.checking.delete(id);
      });
    this.checking.set(id, work);
    return work;
  }
  continue(id: string): Promise<OperationView> {
    return this.queue.run(async () => {
      const record = this.record(id);
      if (record.historical)
        throw Error("historical operation cannot continue a prepared action");
      const state = await this.dependencies.state();
      if (
        !state.ready ||
        state.busy ||
        state.settlement?.pending ||
        state.proofStatus === "Deriving" ||
        state.proofStatus?.endsWith("Pending")
      )
        throw Error("fresh ready idle controller required");
      if (record.continued) return operationView(record);
      const saved = await this.dependencies.journal.update(id, (r) => {
        r.continued = true;
      });
      this.checks.delete(id);
      return operationView(saved);
    });
  }
  import(input: OperationRequest & { hash: string }): Promise<OperationView> {
    const request = parseOperationImport(input);
    return this.queue.run(async () => {
      const existing = this.dependencies.journal.get(request.id);
      if (existing) {
        if (
          !existing.historical ||
          JSON.stringify(existing.request) !==
            JSON.stringify({
              id: request.id,
              action: request.action,
              role: request.role,
            }) ||
          existing.steps[0]?.hashes[0]?.hash !== request.hash
        )
          throw Error("operation request conflict");
        return operationView(existing);
      }
      if (
        this.dependencies.journal
          .records()
          .some((r) =>
            r.steps.some((s) => s.hashes.some((h) => h.hash === request.hash)),
          )
      )
        throw Error("operation hash already bound");
      const key = JSON.stringify([request.action, request.role, request.hash]);
      let cached = this.imports.get(key);
      if (!cached || this.now() >= cached.until) {
        for (const [k, v] of this.imports)
          if (this.now() >= v.until) this.imports.delete(k);
        if (this.imports.size >= 128)
          throw Error("operation import capacity reached");
        // Cache negative results by immutable context, so a new UUID cannot bypass cooldown.
        cached = { until: this.now() + 30000 };
        this.imports.set(key, cached);
        await this.ready();
        try {
          cached.value = await this.dependencies.verifier.importNear(
            request.hash,
            request.action,
            request.role,
            this.dependencies.binding,
          );
        } catch {
          throw Error("historical transaction unavailable or mismatched");
        }
      }
      const value = cached.value;
      if (
        !value ||
        value.verification.detail === HASH_DETAILS.unavailable ||
        value.verification.detail === HASH_DETAILS.mismatch
      )
        throw Error("historical transaction unavailable or mismatched");
      const { hash, ...identity } = request;
      await this.dependencies.journal.start(identity, true);
      const saved = await this.dependencies.journal.update(request.id, (r) => {
        r.preparation = { phase: "prepared", detail: "prepared" };
        r.steps = [
          {
            expected: value.expected,
            started: true,
            observation: "hash",
            hashes: [value.verification],
          },
        ];
      });
      return operationView(saved);
    });
  }
}

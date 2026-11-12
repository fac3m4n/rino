export type Outcome =
  "unknown" | "partial" | "rejected" | "cancelled" | "failed";
/** Delivery stage and accepted hashes survive transport/SDK errors for reconciliation. */
export class ActionFailure extends Error {
  readonly uncertainMutation: boolean;
  constructor(
    message: string,
    readonly outcome: Outcome,
    readonly stage: "before-submission" | "submission" | "confirmation",
    readonly knownHashes: string[] = [],
  ) {
    super(message);
    this.uncertainMutation = outcome === "unknown" || outcome === "partial";
  }
}
export function userRejected(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; name?: string; cause?: unknown };
  return (
    e.code === 4001 ||
    e.name === "UserRejectedRequestError" ||
    (e.cause !== error && userRejected(e.cause))
  );
}
export function submissionFailure(
  error: unknown,
  hashes: string[],
): ActionFailure {
  if (error instanceof ActionFailure) return error;
  const rejected = userRejected(error);
  const outcome =
    hashes.length && rejected ? "partial" : rejected ? "rejected" : "unknown";
  return new ActionFailure(
    rejected
      ? hashes.length
        ? `Earlier wallet transactions were confirmed (${hashes.join(", ")}); the later request was rejected. Reconcile chain state before continuing.`
        : "Wallet request rejected before acceptance. No transaction was submitted."
      : `Outcome uncertain. Wallet submission or confirmation was not received.${hashes.length ? ` Known transaction hashes: ${hashes.join(", ")}.` : ""} Do not resubmit; reconcile chain state and receipts.`,
    outcome,
    "submission",
    [...hashes],
  );
}

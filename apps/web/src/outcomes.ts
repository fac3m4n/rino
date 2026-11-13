import {
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_NAMES,
  type OperationDiagnostic,
} from "@proofcredit/coordinator/api";

export type Outcome =
  "unknown" | "partial" | "rejected" | "cancelled" | "failed";
const actionFailures = new WeakSet<object>();
/** Delivery stage and accepted hashes survive transport/SDK errors for reconciliation. */
export class ActionFailure extends Error {
  readonly uncertainMutation: boolean;
  constructor(
    message: string,
    readonly outcome: Outcome,
    readonly stage: "before-submission" | "submission" | "confirmation",
    readonly knownHashes: string[] = [],
    readonly diagnostic?: OperationDiagnostic,
  ) {
    super(message);
    actionFailures.add(this);
    this.uncertainMutation = outcome === "unknown" || outcome === "partial";
  }
}
// Inspect data descriptors only: wallet/provider exceptions can contain cycles,
// accessors, credentials and arbitrarily large payloads. Never stringify them.
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
function causes(error: unknown): object[] {
  const nodes: object[] = [];
  while (error && typeof error === "object" && nodes.length < 8) {
    if (nodes.includes(error)) break;
    nodes.push(error);
    error = field(error, "cause");
  }
  return nodes;
}
function rejectedNode(node: object): boolean {
  const code = field(node, "code");
  return (
    code === 4001 ||
    code === "4001" ||
    code === "ACTION_REJECTED" ||
    field(node, "name") === "UserRejectedRequestError"
  );
}
export function userRejected(error: unknown): boolean {
  return causes(error).some(rejectedNode);
}
function diagnostic(nodes: object[]): OperationDiagnostic {
  let result: OperationDiagnostic = { category: "unknown" };
  for (const node of nodes) {
    const rawName = field(node, "name");
    const rawCode = field(node, "code");
    const code =
      typeof rawCode === "number" || typeof rawCode === "string"
        ? String(rawCode)
        : undefined;
    const name =
      typeof rawName === "string" && DIAGNOSTIC_NAMES.some((n) => n === rawName)
        ? rawName
        : [
              "RpcError",
              "RpcRequestError",
              "HttpRequestError",
              "WebSocketRequestError",
              "SocketClosedError",
            ].includes(typeof rawName === "string" ? rawName : "")
          ? "TransportError"
          : undefined;
    const message = field(node, "message");
    const text =
      typeof message === "string" && message.length <= 512 ? message : "";
    const category: OperationDiagnostic["category"] = rejectedNode(node)
      ? "rejected"
      : name === "TimeoutError" ||
          name === "AbortError" ||
          code === "TIMEOUT" ||
          /\b(timed out|timeout)\b/i.test(text)
        ? "timeout"
        : /\b(wallet|popup|window)\b.{0,40}\bclosed\b/i.test(text)
          ? "wallet-closed"
          : name === "TransportError" ||
              code === "NETWORK_ERROR" ||
              code === "4900" ||
              code === "4901" ||
              /\b(network error|connection lost|disconnected|failed to fetch)\b/i.test(
                text,
              )
            ? "transport"
            : "unknown";
    const next: OperationDiagnostic = { category };
    if (name) next.name = name;
    if (code && DIAGNOSTIC_CODES.some((c) => c === code)) next.code = code;
    if (category !== "unknown" || result.category === "unknown") result = next;
    if (category === "rejected") break;
  }
  return result;
}
function hashChain(value: unknown): "near" | "ethereum" | undefined {
  if (typeof value !== "string") return undefined;
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return "ethereum";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return undefined;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const character of value)
    n = n * 58n + BigInt(alphabet.indexOf(character));
  let bytes = 0;
  while (n > 0n) {
    bytes++;
    n >>= 8n;
  }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32
    ? "near"
    : undefined;
}
function hintedHashes(nodes: object[], hashes: string[]): string[] {
  const result = [...hashes];
  const counts = { near: 0, ethereum: 0 };
  for (const hash of hashes) {
    const chain = hashChain(hash);
    if (chain) counts[chain]++;
  }
  for (const node of nodes) {
    for (const value of [
      field(node, "hash"),
      field(node, "transactionHash"),
      field(field(node, "transaction"), "hash"),
      field(field(node, "transaction_outcome"), "id"),
    ]) {
      const chain = hashChain(value);
      if (!chain || counts[chain] >= 4) continue;
      const hash =
        chain === "ethereum"
          ? (value as string).toLowerCase()
          : (value as string);
      if (result.includes(hash)) continue;
      result.push(hash);
      counts[chain]++;
    }
  }
  return result;
}
export function submissionFailure(
  error: unknown,
  hashes: string[],
): ActionFailure {
  if (error && typeof error === "object" && actionFailures.has(error))
    return error as ActionFailure;
  const nodes = causes(error);
  const safeDiagnostic = diagnostic(nodes);
  hashes = hintedHashes(nodes, hashes);
  const rejected = nodes.some((node) => rejectedNode(node));
  const outcome =
    hashes.length && rejected ? "partial" : rejected ? "rejected" : "unknown";
  return new ActionFailure(
    rejected
      ? hashes.length
        ? `Wallet request rejected with known transaction hashes (${hashes.join(", ")}). Submission remains uncertain; reconcile chain state before continuing.`
        : "Wallet request rejected before acceptance. No transaction was submitted."
      : `Outcome uncertain. Wallet submission or confirmation was not received.${hashes.length ? ` Known transaction hashes: ${hashes.join(", ")}.` : ""} Do not resubmit; reconcile chain state and receipts.`,
    outcome,
    "submission",
    [...hashes],
    safeDiagnostic,
  );
}

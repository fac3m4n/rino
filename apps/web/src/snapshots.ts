/** One read in flight; mutation/effect boundaries revoke older read authority. */
export class SnapshotLane<T> {
  private generation = 0;
  private disposed = false;
  private active?: { controller: AbortController; promise: Promise<boolean> };
  constructor(
    private loader: (signal: AbortSignal) => Promise<T>,
    private apply: (value: T) => void,
  ) {}
  refresh(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.active) return this.active.promise;
    const token = this.generation,
      controller = new AbortController();
    const promise = this.loader(controller.signal)
      .then((value) => {
        if (!this.isCurrent(token)) return false;
        this.apply(value);
        return true;
      })
      .catch((error) => {
        if (!this.isCurrent(token)) return false;
        throw error;
      })
      .finally(() => {
        if (this.active?.controller === controller) this.active = undefined;
      });
    this.active = { controller, promise };
    return promise;
  }
  invalidate(): number {
    this.generation++;
    this.active?.controller.abort();
    this.active = undefined;
    return this.generation;
  }
  isCurrent(token: number): boolean {
    return !this.disposed && token === this.generation;
  }
  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }
}

import type { ActionName } from "@proofcredit/coordinator/api";
import type { Snapshot } from "./client";
export function mutationObserved(
  action: ActionName,
  before: Snapshot,
  after: Snapshot,
): boolean {
  if (after.state.busy) return false;
  const methods: Record<ActionName, string[]> = {
    initialize: ["initialize_vault"],
    fund: ["fund_liquidity", "fund"],
    prove: ["request_proof"],
    borrow: ["borrow"],
    repay: ["repay"],
    default: ["declare_default"],
    cancel: ["cancel"],
    settle: ["confirm_settlement"],
    claim: ["claim_credit"],
    "challenge-forgery": ["request_proof"],
    "challenge-duplicate": ["borrow"],
    "advance-maturity": [],
    recover: ["confirm_settlement", "expire_pending"],
  };
  const oldIds = new Set(before.receipts.map((receipt) => receipt.id));
  if (
    after.receipts.some(
      (receipt) =>
        !oldIds.has(receipt.id) &&
        methods[action].includes(receipt.action) &&
        ["success", "rejected"].includes(receipt.status),
    )
  )
    return true;
  const market = after.state.market,
    previous = before.state.market;
  if (!market) return false;
  switch (action) {
    case "initialize":
      return !previous?.vault && !!market.vault;
    case "borrow":
      return previous?.borrowed_at == null && market.borrowed_at != null;
    case "repay":
      return (
        previous?.phase === "Active" &&
        ["Repaid", "Closed"].includes(market.phase) &&
        market.debt_units === "0"
      );
    case "default":
      return (
        previous?.phase === "Active" &&
        (market.phase === "DefaultLocked" ||
          after.state.settlement?.branch === "default")
      );
    case "cancel":
      return (
        previous?.phase === "Offered" &&
        (market.phase === "CancelLocked" ||
          after.state.settlement?.branch === "cancel")
      );
    case "prove":
      return !previous?.proof_fresh && market.proof_fresh;
    case "fund":
      return (
        BigInt(market.available_liquidity_units) >
          BigInt(previous?.available_liquidity_units ?? "0") ||
        BigInt(after.state.ethereum?.vaultBalanceWei ?? "0") >
          BigInt(before.state.ethereum?.vaultBalanceWei ?? "0")
      );
    case "claim":
      return (
        BigInt(market.lender_balance_units) >
        BigInt(previous?.lender_balance_units ?? "0")
      );
    case "settle":
    case "recover":
      return (
        before.state.settlement?.stage !== "Complete" &&
        after.state.settlement?.stage === "Complete"
      );
    case "advance-maturity":
      return (
        !!market.maturity &&
        BigInt(after.state.nearTimeSeconds ?? "0") >= BigInt(market.maturity) &&
        BigInt(before.state.nearTimeSeconds ?? "0") < BigInt(market.maturity)
      );
    default:
      return false;
  }
}

export interface UnconfirmedAction {
  action: ActionName;
  before: Snapshot;
  checked?: Snapshot;
  knownHashes?: string[];
  requireExplicitContinuation?: boolean;
}
export function canContinueFromCheckedState(
  unknown: UnconfirmedAction | null,
  latest: Snapshot | null,
  online: boolean,
  pending: boolean,
): boolean {
  const checked = unknown?.checked;
  return (
    !!checked &&
    checked === latest &&
    online &&
    !pending &&
    checked.config.ready &&
    checked.state.ready &&
    !checked.state.busy
  );
}

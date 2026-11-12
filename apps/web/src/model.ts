import { collateralSufficient } from "@proofcredit/coordinator/collateral";
import type {
  ActionName,
  Config,
  Role,
  State,
  Settlement,
} from "@proofcredit/coordinator/api";

/** Decimal integer formatting: no floating point conversion or upward rounding. */
export function formatUnits(
  value: string,
  decimals: number,
  precision = 4,
): string {
  const amount = BigInt(value);
  const digits = (amount < 0n ? -amount : amount)
    .toString()
    .padStart(decimals + 1, "0");
  const whole = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals
    ? digits.slice(-decimals).slice(0, precision).replace(/0+$/, "")
    : "";
  return `${amount < 0n ? "-" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}`;
}

export function actionGuard(
  action: ActionName,
  config: Config,
  state: State,
  role: Role,
  wallet?: { nearAccount?: string; evmChainId?: number },
): string | null {
  if (!config.ready || !state.ready)
    return "The environment is not ready. Review readiness details.";
  if (state.busy) return "A transaction is pending. Wait for its receipt.";
  if (action === "fund" && state.settlement?.retired)
    return "This vault is retired. Deposits cannot be recovered by this loan.";
  if (config.mode === "public") {
    if (
      action === "fund" &&
      role === "borrower" &&
      wallet?.evmChainId !== 11155111
    )
      return "Connect an Ethereum wallet on Sepolia.";
    if (
      (action !== "fund" || role === "lender") &&
      wallet?.nearAccount !==
        (role === "borrower" ? config.near.borrowerId : config.near.lenderId)
    ) {
      const expected =
        role === "borrower" ? config.near.borrowerId : config.near.lenderId;
      return wallet?.nearAccount
        ? `Connected to ${wallet.nearAccount}. Disconnect NEAR, then reconnect as ${expected} on NEAR testnet.`
        : `Connect ${expected} on NEAR testnet.`;
    }
    if (
      ["advance-maturity", "challenge-forgery", "challenge-duplicate"].includes(
        action,
      )
    )
      return "This control is available only in the local demo.";
  }
  if (
    [
      "initialize",
      "prove",
      "borrow",
      "repay",
      "cancel",
      "challenge-forgery",
      "challenge-duplicate",
    ].includes(action) &&
    role !== "borrower"
  )
    return "Switch to the borrower account.";
  if (action === "fund" && config.mode === "local" && role !== "lender")
    return "Switch to the lender account to fund the local offer and vault.";
  if (
    ["default", "claim", "advance-maturity"].includes(action) &&
    role !== "lender"
  )
    return "Switch to the lender account.";
  const market = state.market;
  if (action === "initialize")
    return market?.vault ? "The market is already initialized." : null;
  if (!market) return "Initialize the market first.";
  if (
    action === "fund" &&
    config.mode === "public" &&
    role === "lender" &&
    BigInt(market.available_liquidity_units) >=
      BigInt(market.terms.principal_units) &&
    BigInt(market.borrower_balance_units) >= 1000000n
  )
    return "The CREDIT offer is funded. Switch to the borrower to fund or authenticate ETH collateral.";
  if (action === "recover" && state.settlement?.retired)
    return "This vault is retired; no settlement work remains.";
  if (action === "advance-maturity" && market.phase !== "Active")
    return "Maturity controls require an active loan.";
  if (
    action === "claim" &&
    BigInt(market.available_liquidity_units) +
      BigInt(market.lender_claim_units) ===
      0n
  )
    return "No tracked lender CREDIT claim remains.";
  if (action === "challenge-duplicate" && market.phase !== "Active")
    return "The duplicate challenge requires an active loan.";
  if (
    action === "challenge-forgery" &&
    (market.phase !== "Offered" ||
      !market.vault ||
      BigInt(state.ethereum?.vaultBalanceWei ?? "0") === 0n)
  )
    return "The forged-proof challenge requires a funded offer before borrowing.";
  if (action === "fund" && market.phase !== "Offered")
    return "Only fund collateral before borrowing. Do not deposit during settlement.";
  if (action === "borrow") {
    if (market.phase !== "Offered")
      return "This loan cannot be borrowed again.";
    if (!collateralSufficient(market.terms, state.ethereum?.vaultBalanceWei))
      return "Fund sufficient collateral before borrowing.";
    if (
      !market.proof_fresh ||
      !collateralSufficient(market.terms, state.evidence?.balance_wei)
    )
      return "Authenticate a fresh financially sufficient collateral proof first.";
    if (
      BigInt(market.available_liquidity_units) <
      BigInt(market.terms.principal_units)
    )
      return "The lender escrow has insufficient CREDIT.";
  }
  if (action === "repay") {
    if (market.phase !== "Active") return "Repayment requires an active loan.";
    if (
      market.maturity &&
      state.nearTimeSeconds &&
      BigInt(state.nearTimeSeconds) >= BigInt(market.maturity)
    )
      return "The loan has matured. The lender may lock default.";
  }
  if (action === "default") {
    if (market.phase !== "Active") return "Default requires an active loan.";
    if (
      !market.maturity ||
      !state.nearTimeSeconds ||
      BigInt(state.nearTimeSeconds) < BigInt(market.maturity)
    )
      return "Wait until the loan reaches maturity.";
  }
  if (action === "cancel" && market.phase !== "Offered")
    return "Cancellation is available before borrowing.";
  if (
    action === "settle" &&
    !["Repaid", "DefaultLocked", "CancelLocked"].includes(market.phase)
  )
    return "Repay, cancel, or lock default before releasing collateral.";
  return null;
}
export function settlementLabel(stage?: Settlement["stage"]): string {
  const labels: Record<Settlement["stage"], string> = {
    Idle: "Waiting for loan resolution",
    Preparing: "Authenticating vault state",
    ReadyToSign: "Transfer authorized · ready to sign",
    Signing: "Awaiting MPC signature",
    Signed: "Signed · awaiting inclusion",
    Confirming: "Included · awaiting NEAR authentication",
    NeedsTopup: "Fee topup required · collateral held",
    Complete: "NEAR-authenticated release",
  };
  return stage ? labels[stage] : labels.Idle;
}

export function loanHistory(state: State | undefined): {
  borrowed: boolean;
  cancelled: boolean;
} {
  return {
    borrowed: state?.market?.borrowed_at != null,
    cancelled:
      state?.settlement?.branch === "cancel" ||
      state?.market?.phase === "CancelLocked",
  };
}

export function offeredAction(
  state: State,
  role: Role,
  mode: Config["mode"] = "local",
): ActionName {
  if (
    role === "lender" &&
    state.market &&
    (BigInt(state.market.available_liquidity_units) <
      BigInt(state.market.terms.principal_units) ||
      (mode === "public" &&
        BigInt(state.market.borrower_balance_units) < 1000000n))
  )
    return "fund";
  return !state.market ||
    !collateralSufficient(state.market.terms, state.ethereum?.vaultBalanceWei)
    ? "fund"
    : state.market.proof_fresh &&
        collateralSufficient(state.market.terms, state.evidence?.balance_wei)
      ? "borrow"
      : "prove";
}

/** Historical funding ignores deposits made after a terminal authenticated checkpoint. */
export function fundingHistory(state: State | undefined): {
  done: boolean;
  skipped: boolean;
} {
  const positive = (value: unknown) =>
    typeof value === "string" && /^[0-9]+$/.test(value) && BigInt(value) > 0n;
  const s = state?.settlement;
  const done =
    !!state?.market?.borrowed_at ||
    positive(state?.evidence?.balance_wei) ||
    [
      s?.balance_wei,
      s?.fees_paid_wei,
      s?.lender_paid_wei,
      s?.borrower_surplus_wei,
    ].some(positive) ||
    (!s?.retired && positive(state?.ethereum?.vaultBalanceWei));
  return { done, skipped: loanHistory(state).cancelled && !done };
}

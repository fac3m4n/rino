import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Fingerprint,
  FlaskConical,
  Layers3,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import type {
  ActionName,
  Config,
  Receipt,
  Role,
  State,
} from "@proofcredit/coordinator/api";
import type { Address } from "viem";
import {
  actionGuard,
  formatUnits,
  settlementLabel,
  loanHistory,
  offeredAction,
  fundingHistory,
} from "./model";
import {
  snapshot,
  submitAction,
  RequestFailure,
  type Snapshot,
} from "./client";
import {
  SnapshotLane,
  mutationObserved,
  canContinueFromCheckedState,
  type UnconfirmedAction,
} from "./snapshots";
import { useWallets } from "./wallets";
import { ActionFailure } from "./outcomes";
import {
  collateralShortfall,
  collateralSufficient,
} from "@proofcredit/coordinator/collateral";

const short = (value?: string | null) =>
  value
    ? value.length > 22
      ? `${value.slice(0, 10)}…${value.slice(-7)}`
      : value
    : "Awaiting initialization";
const credit = (value?: string | null) =>
  value ? formatUnits(value, 6, 6) : "—";
const eth = (value?: string | null) =>
  value ? formatUnits(value, 18, 6) : "—";
const actionNames: Record<ActionName, string> = {
  initialize: "Initialize local market",
  fund: "Fund vault · 0.12 ETH",
  prove: "Authenticate collateral",
  borrow: "Borrow 100 CREDIT",
  repay: "Repay 101 CREDIT",
  default: "Lock default",
  cancel: "Cancel before borrowing",
  settle: "Release collateral",
  claim: "Claim lender CREDIT",
  "challenge-forgery": "Try forged proof",
  "challenge-duplicate": "Try duplicate borrow",
  "advance-maturity": "Advance to maturity",
  recover: "Reconcile pending operation",
};

function EthereumMark() {
  return (
    <svg className="eth-mark" viewBox="0 0 24 36" aria-hidden="true">
      <path d="m12 0 12 20-12 7L0 20Z" fill="currentColor" />
      <path d="m0 22 12 7 12-7-12 14Z" fill="currentColor" opacity=".6" />
    </svg>
  );
}
function NearMark() {
  return (
    <svg className="near-mark" viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M5 27V6a1 1 0 0 1 2-.6l18 21a1 1 0 0 0 2-.6V5M5 27l9-10M27 5l-9 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function App() {
  const [config, setConfig] = useState<Config>();
  const [state, setState] = useState<State>();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [role, setRole] = useState<Role>("borrower");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<ActionName | "wallet" | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [details, setDetails] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const openEvidence = () => {
    drawerTrigger.current = document.activeElement as HTMLElement | null;
    setDrawer(true);
  };
  useEffect(() => {
    if (!drawer) return;
    const previous = drawerTrigger.current;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawer(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], summary, [tabindex="0"]',
      );
      if (!focusable?.length) return;
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [drawer]);
  const wallets = useWallets();
  const inflight = useRef(false);
  const snapshots = useRef<SnapshotLane<Snapshot> | null>(null);
  const latest = useRef<Snapshot | null>(null);
  const unknownAction = useRef<UnconfirmedAction | null>(null);
  const networkPausedRef = useRef(false);
  const [networkPaused, setNetworkPaused] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [continued, setContinued] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const pauseNetwork = (reason: string) => {
    if (unknownAction.current) unknownAction.current.checked = undefined;
    networkPausedRef.current = true;
    setNetworkPaused(true);
    setError(
      unknownAction.current
        ? `Outcome uncertain. ${reason} Reconcile chain state and receipts before resubmitting.`
        : reason,
    );
  };
  const refresh = useCallback(async () => {
    if (!snapshots.current) return false;
    return snapshots.current.refresh();
  }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lane = new SnapshotLane<Snapshot>(
      (signal) => snapshot({ signal }),
      (data) => {
        latest.current = data;
        setConfig(data.config);
        setState(data.state);
        setReceipts(data.receipts);
        // Only this current-generation post-uncertainty delivery may authorize continuation.
        if (unknownAction.current) unknownAction.current.checked = data;
        if (
          unknownAction.current &&
          !unknownAction.current.requireExplicitContinuation &&
          mutationObserved(
            unknownAction.current.action,
            unknownAction.current.before,
            data,
          )
        ) {
          unknownAction.current = null;
          setUncertain(false);
          setContinued(false);
          setError("");
          setMessage(
            "Latest chain state and receipts reconciled. No action was automatically resubmitted.",
          );
        } else if (networkPausedRef.current && !unknownAction.current)
          setError("");
        networkPausedRef.current = false;
        setNetworkPaused(false);
      },
    );
    snapshots.current = lane;
    const poll = async () => {
      try {
        if (active && !inflight.current) await lane.refresh();
      } catch (error) {
        if (active)
          pauseNetwork(
            error instanceof Error
              ? error.message
              : "Unable to refresh chain state.",
          );
      } finally {
        if (active) timer = setTimeout(() => void poll(), 2500);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
      lane.dispose();
      if (snapshots.current === lane) snapshots.current = null;
    };
  }, []);
  const market = state?.market;
  const settlement = state?.settlement;
  const local = config?.mode === "local";
  const fundingShortfall = (() => {
    try {
      return market
        ? collateralShortfall(
            market.terms,
            state?.ethereum?.vaultBalanceWei,
          ).toString()
        : "0";
    } catch {
      return "0";
    }
  })();
  const guard = (action: ActionName) =>
    !config || !state
      ? "Connecting to the coordinator."
      : pending
        ? "Wait for the pending transaction receipt."
        : uncertain && !continued
          ? "Outcome uncertain. Reconcile chain state and receipts before another financial action."
          : networkPaused
            ? "Latest chain state is unavailable. Refresh it before another financial action."
            : actionGuard(action, config, state, role, wallets);
  const reconcile = async () => {
    const lane = snapshots.current;
    if (!lane || pending) return;
    setRefreshing(true);
    try {
      await lane.refresh();
    } catch (error) {
      if (snapshots.current === lane)
        pauseNetwork(
          error instanceof Error
            ? error.message
            : "Unable to refresh chain state.",
        );
    } finally {
      if (snapshots.current === lane) setRefreshing(false);
    }
  };
  const continueFromCheckedState = () => {
    if (
      !canContinueFromCheckedState(
        unknownAction.current,
        latest.current,
        !networkPausedRef.current,
        inflight.current || refreshing,
      )
    )
      return;
    setContinued(true);
    setError("");
    setMessage("");
  };
  const run = async (action: ActionName) => {
    const lane = snapshots.current;
    if (!config || !state || !lane || inflight.current) return;
    const blocked = guard(action);
    if (blocked) {
      setError(blocked);
      return;
    }
    const before = latest.current ?? { config, state, receipts };
    const token = lane.invalidate();
    inflight.current = true;
    setPending(action);
    setError("");
    setMessage("");
    try {
      if (
        config.mode === "public" &&
        action === "fund" &&
        role === "borrower"
      ) {
        if (!market?.vault) throw new Error("The vault has not been derived.");
        const hash = await wallets.fundEvm(
          config,
          market.vault as Address,
          collateralShortfall(market.terms, state.ethereum?.vaultBalanceWei),
        );
        if (lane.isCurrent(token))
          setMessage(
            `Ethereum funding included: ${hash}. Authenticate collateral before borrowing.`,
          );
      } else {
        const result = await submitAction(config, action, role);
        if (!lane.isCurrent(token)) return;
        if (result.walletActions?.length) {
          await wallets.sendNear(
            config,
            result.walletActions,
            role === "borrower" ? config.near.borrowerId : config.near.lenderId,
          );
          if (lane.isCurrent(token))
            setMessage(
              "Wallet submission returned. Chain state and receipts are being refreshed.",
            );
        } else {
          setState(result.state);
          setMessage(result.message);
        }
        if (!result.ok) setError(result.message);
      }
    } catch (error) {
      if (lane.isCurrent(token)) {
        if (error instanceof ActionFailure && error.uncertainMutation) {
          unknownAction.current = {
            action,
            before,
            knownHashes: error.knownHashes,
            // Balance deltas or an earlier batch receipt cannot authenticate an ambiguous wallet submission.
            requireExplicitContinuation: !(error instanceof RequestFailure),
          };
          setContinued(false);
          setUncertain(true);
        }
        setError(
          error instanceof Error
            ? error.message
            : "Action outcome is unknown. Reconcile chain state before continuing.",
        );
      }
    } finally {
      if (lane.isCurrent(token)) {
        try {
          await refresh();
        } catch (error) {
          if (lane.isCurrent(token)) {
            networkPausedRef.current = true;
            setNetworkPaused(true);
            if (!unknownAction.current)
              setError(
                error instanceof Error
                  ? error.message
                  : "Latest chain state is unavailable; financial actions are paused.",
              );
          }
        } finally {
          if (lane.isCurrent(token)) {
            inflight.current = false;
            setPending(null);
          }
        }
      }
    }
  };
  const connect = async (chain: "near" | "ethereum" | "switch") => {
    if (!config || inflight.current) return;
    inflight.current = true;
    setPending("wallet");
    setError("");
    try {
      if (chain === "near") await wallets.connectNear(config);
      else if (chain === "switch") await wallets.switchEvm();
      else await wallets.connectEvm();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connection failed.");
    } finally {
      inflight.current = false;
      setPending(null);
    }
  };
  let primary: ActionName = "initialize";
  let stageTitle = "A credit line, across two networks.";
  let stageCopy =
    "Initialize the local actors and fixed loan terms. Every action below executes against the running chains.";
  if (market?.vault) {
    if (market.phase === "Offered") {
      const offered = offeredAction(state!, role, config!.mode);
      if (offered === "fund") {
        primary = "fund";
        stageTitle = "Put your ETH to work.";
        stageCopy = local
          ? "The local lender funds 100 CREDIT in escrow, transfers the 1 CREDIT fee endowment, and tops up insufficient collateral to 0.12 test ETH."
          : "Fund the CREDIT offer as lender, then top up insufficient collateral to 0.12 Sepolia ETH as borrower. Your wallet authorizes each action.";
        if (
          collateralSufficient(market.terms, state?.ethereum?.vaultBalanceWei)
        ) {
          stageTitle = "Restore the CREDIT offer.";
          stageCopy =
            "The vault already holds sufficient ETH. Fund 100 CREDIT in lender escrow without depositing more collateral.";
        }
        if (
          !local &&
          role === "lender" &&
          BigInt(market.available_liquidity_units) >=
            BigInt(market.terms.principal_units)
        ) {
          stageTitle = "Restore the borrower fee endowment.";
          stageCopy =
            "The CREDIT offer is funded. Transfer only the missing amount to give the borrower the 1 CREDIT demonstration repayment fee.";
        }
      } else if (offered === "prove") {
        primary = "prove";
        stageTitle = "Turn collateral into evidence.";
        stageCopy =
          "Authenticate the funded Ethereum account through the worker and NEAR receipts.";
      } else {
        primary = "borrow";
        stageTitle = "Your collateral is ready.";
        stageCopy =
          "Receive 100 transferable test CREDIT on NEAR. Your fixed repayment is 101 CREDIT.";
      }
    } else if (market.phase === "Active") {
      primary = role === "borrower" ? "repay" : "default";
      stageTitle = "Credit unlocked. ETH secured.";
      stageCopy =
        role === "borrower"
          ? "Repay before maturity, then authenticate the Ethereum release."
          : "The lender may lock default at maturity. Recovery is capped; the borrower keeps any surplus.";
    } else if (market.phase === "Closed") {
      primary = "claim";
      stageTitle = "The loop is complete.";
      stageCopy =
        "The terminal Ethereum checkpoint is authenticated on NEAR. This vault is retired; do not send further deposits.";
    } else {
      primary = "settle";
      stageTitle = "Bring the collateral home.";
      stageCopy =
        "Sign the fixed transfer, relay it to Ethereum, then authenticate its receipt on NEAR.";
    }
  }
  const history = loanHistory(state);
  const funded = fundingHistory(state);
  const steps = [
    {
      name: "Fund vault",
      done: funded.done,
      skipped: funded.skipped,
      sub: funded.skipped ? "Not funded · cancellation" : "Ethereum collateral",
    },
    {
      name: "Prove collateral",
      done: !!market?.proof_timestamp,
      skipped: history.cancelled && !market?.proof_timestamp,
      sub:
        history.cancelled && !market?.proof_timestamp
          ? "Not required · cancellation"
          : "Worker → NEAR",
    },
    {
      name: "Borrow CREDIT",
      done: history.borrowed,
      skipped: history.cancelled && !history.borrowed,
      sub:
        history.cancelled && !history.borrowed
          ? "Not borrowed · cancelled"
          : "Atomic token transfer",
    },
    {
      name: "Resolve loan",
      done:
        !!market &&
        ["Repaid", "DefaultLocked", "CancelLocked", "Closed"].includes(
          market.phase,
        ),
      sub: "Repay or capped default",
    },
    {
      name: "Confirm release",
      done: settlement?.stage === "Complete",
      sub: "NEAR-authenticated receipt",
    },
  ];
  const activeStep = steps.findIndex((s) => !s.done && !s.skipped);
  function ActionButton({
    action,
    secondary = false,
  }: {
    action: ActionName;
    secondary?: boolean;
  }) {
    const reason = guard(action);
    return (
      <button
        className={secondary ? "button secondary" : "button primary"}
        disabled={!!reason}
        title={reason ?? undefined}
        onClick={() => void run(action)}
      >
        {pending === action ? <RefreshCw size={16} className="spin" /> : null}
        {pending === action
          ? "Waiting for receipts…"
          : action === "fund" && role === "lender"
            ? local
              ? "Fund offer + vault"
              : "Fund CREDIT offer"
            : action === "fund"
              ? `Fund vault · ${eth(fundingShortfall)} ETH`
              : actionNames[action]}
        {!secondary && pending !== action ? <ArrowRight size={17} /> : null}
      </button>
    );
  }
  return (
    <>
      <div className="app-shell">
        <header className="topbar">
          <a className="brand" href="/" aria-label="ProofCredit home">
            <span className="brand-symbol">
              p<span>c</span>
            </span>
            ProofCredit<span className="beta">BETA</span>
          </a>
          <nav aria-label="Primary">
            <span className="nav-active">Dashboard</span>
            <button onClick={openEvidence}>
              Evidence <ArrowUpRight size={13} />
            </button>
          </nav>
          <div className="connection">
            <span className={`status-dot ${config?.ready ? "live" : ""}`} />
            {config?.ready ? "Environment ready" : "Connecting environment"}
          </div>
        </header>
        <main>
          <section className="heading">
            <div>
              <div className="eyebrow">CROSS-CHAIN CREDIT, WITH PROOF</div>
              <h1>
                Keep your ETH.
                <br className="mobile-break" /> Unlock credit<span>.</span>
              </h1>
              <p>
                Ethereum collateral. NEAR liquidity. One verifiable credit line.
              </p>
            </div>
            <span className="environment-badge">
              <FlaskConical size={15} />
              {config
                ? local
                  ? "Local two-chain demo"
                  : "Public testnet mode"
                : "Connecting local services"}
            </span>
          </section>
          <section
            className="authority-strip"
            aria-label="Network and authority"
          >
            <div>
              <span className="small-network">E</span>
              <b>{local ? "Ethereum · local Anvil" : "Ethereum · Sepolia"}</b>
              <span className="cross-arrow">↔</span>
              <NearMark />
              <b>NEAR · {local ? "Sandbox" : "testnet"}</b>
            </div>
            <span className="authority-summary">
              {local
                ? "Mock MPC / executor · synthetic RPC · 120s demo"
                : "User wallet authority · public testnets"}
            </span>
            <button onClick={() => setDetails(!details)}>
              Trust & environment <ChevronDown size={14} />
            </button>
          </section>
          {details && (
            <section className="trust-panel">
              <h2>Know what verifies this demo</h2>
              <p>
                {local
                  ? "Local actors hold development keys. Two synthetic RPC routes share one owned Anvil; mock MPC and executor services are trusted. The controller and real worker execute against local chains."
                  : "Connected users authorize financial actions. Public testnet readiness must pass before any action is available."}
              </p>
              <p>
                Receipt data relies on the declared two-RPC policy. This is not
                a receipt-trie light client or hardware attestation. Editable
                developer accounts and configured service authorities remain
                trusted.
              </p>
              <ul>
                {config?.authority.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p>
                Chain ID: {config?.ethereum.chainId ?? "—"} ·{" "}
                {local
                  ? "Compressed 120-second loan; owned Sandbox clock"
                  : "24-hour testnet term"}
                . CREDIT is a nonredeemable test asset.
              </p>
            </section>
          )}
          {config && !config.ready && (
            <section role="alert" className="notice error">
              <b>Environment is not ready</b>
              <ul>
                {config.readinessErrors.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          )}
          {error && (
            <div className="notice error" role="alert">
              <span>{error}</span>
              <button aria-label="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {(uncertain || networkPaused) && (
            <div className="notice uncertain-status" role="status">
              <span>
                {uncertain
                  ? continued
                    ? "The previous request remains unconfirmed. The client pause is released; continuing did not retry it. Inspect receipts before another action; a late original request may still complete."
                    : "The previous request remains unconfirmed. Inspect receipts, then deliberately continue only from fresh ready idle state. Continuing releases the client pause; it does not retry, sign, or declare an outcome."
                  : "Latest chain state is unavailable. Financial actions are paused until a fresh snapshot is received."}
              </span>
              <button
                disabled={!!pending || refreshing}
                onClick={() => void reconcile()}
              >
                {refreshing ? "Refreshing…" : "Refresh chain state"}
              </button>
              {uncertain && !continued && (
                <button
                  disabled={
                    !canContinueFromCheckedState(
                      unknownAction.current,
                      latest.current,
                      !networkPaused,
                      !!pending || refreshing,
                    )
                  }
                  onClick={continueFromCheckedState}
                >
                  Continue from checked state
                </button>
              )}
            </div>
          )}
          {message && (
            <div className="notice" role="status">
              {message}
            </div>
          )}
          <div className="dashboard-grid">
            <div className="overview">
              <div className="section-label">
                YOUR TWO-CHAIN POSITION <span>01 / OVERVIEW</span>
              </div>
              <div className="asset-cards">
                <section className="asset-card ethereum">
                  <div className="card-heading">
                    <div className="token-icon eth">
                      <EthereumMark />
                    </div>
                    <div>
                      <h2>Ethereum vault</h2>
                      <span>COLLATERAL</span>
                    </div>
                    <span className="chain-tag">
                      {local ? "LOCAL ETH" : "SEPOLIA"}
                    </span>
                  </div>
                  <div className="asset-balance" data-testid="vault-balance">
                    {eth(state?.ethereum?.vaultBalanceWei)} <span>ETH</span>
                  </div>
                  <div className="asset-description">
                    <LockKeyhole size={13} />
                    {settlement?.retired
                      ? "Vault retired"
                      : market?.phase === "Active"
                        ? "Reserved for this loan"
                        : "Held in your derived vault"}
                  </div>
                  <div className="card-rule" />
                  <div className="card-row">
                    <span>Vault address</span>
                    <button
                      className="address"
                      disabled={!market?.vault}
                      title={market?.vault ?? undefined}
                      onClick={() => {
                        if (market?.vault)
                          void navigator.clipboard
                            .writeText(market.vault)
                            .then(() => setMessage("Vault address copied."))
                            .catch(() =>
                              setError(
                                "Clipboard unavailable. Open evidence for the complete address.",
                              ),
                            );
                      }}
                    >
                      {short(market?.vault)}
                      <Copy size={12} />
                    </button>
                  </div>
                  <div className="card-row">
                    <span>Account nonce</span>
                    <b>{state?.ethereum?.vaultNonce ?? "—"}</b>
                  </div>
                  <div className="card-footer">
                    <span
                      className={`status-dot ${market?.proof_fresh ? "live" : ""}`}
                    />
                    {settlement?.retired
                      ? "Loan closed · vault retired"
                      : market?.proof_fresh
                        ? "Collateral authenticated"
                        : "Awaiting fresh collateral proof"}
                  </div>
                </section>
                <section className="asset-card near">
                  <div className="card-heading">
                    <div className="token-icon near-token">
                      <NearMark />
                    </div>
                    <div>
                      <h2>NEAR account</h2>
                      <span>AVAILABLE CREDIT</span>
                    </div>
                    <span className="chain-tag">
                      {local ? "SANDBOX" : "TESTNET"}
                    </span>
                  </div>
                  <div className="asset-balance" data-testid="credit-balance">
                    {credit(
                      role === "borrower"
                        ? market?.borrower_balance_units
                        : market?.lender_balance_units,
                    )}{" "}
                    <span>CREDIT</span>
                  </div>
                  <div className="asset-description">
                    <Wallet size={13} />
                    {short(
                      role === "borrower"
                        ? config?.near.borrowerId
                        : config?.near.lenderId,
                    )}
                  </div>
                  <div className="card-rule" />
                  <div className="card-row">
                    <span>
                      {market?.phase === "DefaultLocked"
                        ? "Debt at default"
                        : "Outstanding debt"}
                    </span>
                    <b data-testid="loan-debt">
                      {credit(
                        market?.phase === "DefaultLocked"
                          ? market.terms.debt_units
                          : market?.debt_units,
                      )}{" "}
                      <small>CREDIT</small>
                    </b>
                  </div>
                  <div className="card-row">
                    <span>
                      {role === "borrower"
                        ? "Lender escrow"
                        : "Claimable CREDIT"}
                    </span>
                    <b>
                      {credit(
                        role === "borrower"
                          ? market?.available_liquidity_units
                          : market?.lender_claim_units,
                      )}{" "}
                      <small>CREDIT</small>
                    </b>
                  </div>
                  <div className="card-footer">
                    <span className="test-asset-dot" />
                    Nonredeemable test asset · 6 decimals
                  </div>
                </section>
              </div>
              <section className="terms-panel">
                <div className="panel-heading">
                  <h2>Your loan, in plain numbers.</h2>
                  <span>FIXED TERMS · V{market?.terms.version ?? "1"}</span>
                </div>
                <div className="terms-grid">
                  <div>
                    <span>Borrow amount</span>
                    <b>
                      {credit(market?.terms.principal_units ?? "100000000")}{" "}
                      <small>CREDIT</small>
                    </b>
                  </div>
                  <div>
                    <span>Fixed fee</span>
                    <b>
                      {credit(market?.terms.fee_units ?? "1000000")}{" "}
                      <small>CREDIT</small>
                    </b>
                  </div>
                  <div>
                    <span>Loan term</span>
                    <b>
                      {local ? "120 sec" : "24 hours"}{" "}
                      <small>{local ? "DEMO" : "FIXED"}</small>
                    </b>
                  </div>
                  <div>
                    <span>Maximum LTV</span>
                    <b>
                      50<small>%</small>
                    </b>
                  </div>
                </div>
                <div className="terms-note">
                  <ShieldCheck size={15} />
                  <span>
                    Reference: 2,000 CREDIT / ETH. Fixed demo reference, not a
                    market price oracle.
                  </span>
                </div>
              </section>
              <section className="journey-panel">
                <div className="panel-heading">
                  <h2>One loan. An evidence trail.</h2>
                  <button onClick={openEvidence}>
                    View receipts <ArrowUpRight size={14} />
                  </button>
                </div>
                <ol className="journey">
                  {steps.map((step, index) => (
                    <li
                      key={step.name}
                      className={
                        step.skipped
                          ? "skipped"
                          : step.done
                            ? "done"
                            : index === activeStep
                              ? "current"
                              : ""
                      }
                    >
                      <span className="step-node">
                        {step.skipped ? (
                          "—"
                        ) : step.done ? (
                          <Check size={14} />
                        ) : (
                          String(index + 1).padStart(2, "0")
                        )}
                      </span>
                      <b>{step.name}</b>
                      <small>{step.sub}</small>
                    </li>
                  ))}
                </ol>
              </section>
            </div>
            <aside className="action-panel">
              <div className="role-tabs" aria-label="Acting account">
                <button
                  aria-pressed={role === "borrower"}
                  onClick={() => setRole("borrower")}
                >
                  Borrower
                </button>
                <button
                  aria-pressed={role === "lender"}
                  onClick={() => setRole("lender")}
                >
                  Lender
                </button>
              </div>
              <div className="action-body">
                <div className="stage-kicker">
                  <span className="status-dot live" />
                  {market?.phase ?? "NEW CREDIT LINE"}
                </div>
                <div className="action-illustration">
                  <Layers3 size={32} />
                  <span>
                    <ShieldCheck size={21} />
                  </span>
                </div>
                <h2>{stageTitle}</h2>
                <p>{stageCopy}</p>
                <div className="repayment-row">
                  <span>Total repayment</span>
                  <b>
                    {credit(market?.terms.debt_units ?? "101000000")}{" "}
                    <small>CREDIT</small>
                  </b>
                </div>
                <div className="repayment-row">
                  <span>
                    {market?.maturity
                      ? "Maturity · chain time"
                      : "Collateral network"}
                  </span>
                  <b>
                    {market?.maturity && state?.nearTimeSeconds
                      ? `${BigInt(market.maturity) > BigInt(state.nearTimeSeconds) ? BigInt(market.maturity) - BigInt(state.nearTimeSeconds) : 0n}s remaining`
                      : "Ethereum"}
                  </b>
                </div>
                <ActionButton action={primary} />
                {guard(primary) && (
                  <p className="guard-reason">{guard(primary)}</p>
                )}
                <div className="authority-note">
                  <Fingerprint size={14} />
                  <span>
                    {local
                      ? `Local ${role} actor · real chain transactions`
                      : "Your connected wallet signs every financial action"}
                  </span>
                </div>
                {(pending ||
                  state?.busy ||
                  (!settlement?.retired &&
                    (state?.pendingReason || settlement?.pending_reason))) && (
                  <div className="pending-box" role="status">
                    <Clock3 size={16} />
                    <span>
                      {pending
                        ? "Transaction in progress. Waiting for actual receipts."
                        : state?.pendingReason || settlement?.pending_reason}
                    </span>
                  </div>
                )}
                {settlement && settlement.stage !== "Idle" && (
                  <div className="settlement-box">
                    <span className="eyebrow">ETHEREUM RELEASE</span>
                    <b data-testid="settlement-stage">
                      {settlementLabel(settlement.stage)}
                    </b>
                    <dl>
                      <div>
                        <dt>Lender cap</dt>
                        <dd>{eth(settlement.lender_cap_wei)} ETH</dd>
                      </div>
                      <div>
                        <dt>Lender paid</dt>
                        <dd>{eth(settlement.lender_paid_wei)} ETH</dd>
                      </div>
                      <div>
                        <dt>Borrower surplus</dt>
                        <dd>{eth(settlement.borrower_surplus_wei)} ETH</dd>
                      </div>
                      <div>
                        <dt>Fees paid</dt>
                        <dd>{eth(settlement.fees_paid_wei)} ETH</dd>
                      </div>
                    </dl>
                    <p>
                      Do not deposit during settlement. Deposits after the
                      terminal checkpoint are outside this loan.
                    </p>
                  </div>
                )}
                {!local && config && (
                  <div className="wallet-controls">
                    <button
                      className="button secondary"
                      disabled={!!pending}
                      onClick={() => void connect("near")}
                    >
                      <NearMark />
                      {wallets.nearAccount
                        ? short(wallets.nearAccount)
                        : "Connect NEAR testnet"}
                    </button>
                    <button
                      className="button secondary"
                      disabled={!!pending}
                      onClick={() => void connect("ethereum")}
                    >
                      <EthereumMark />
                      {wallets.evmAccount
                        ? short(wallets.evmAccount)
                        : "Connect Ethereum wallet"}
                    </button>
                    {wallets.evmAccount && wallets.evmChainId !== 11155111 && (
                      <button
                        className="button secondary"
                        disabled={!!pending}
                        onClick={() => void connect("switch")}
                      >
                        Switch to Sepolia
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="more-actions">
                <details>
                  <summary>
                    Recovery & loan controls <ChevronDown size={14} />
                  </summary>
                  <div className="secondary-actions">
                    <ActionButton action="cancel" secondary />
                    <ActionButton action="recover" secondary />
                    {role === "lender" && (
                      <>
                        {primary !== "default" && (
                          <ActionButton action="default" secondary />
                        )}
                        {primary !== "claim" && (
                          <ActionButton action="claim" secondary />
                        )}
                      </>
                    )}
                    {local && (
                      <ActionButton action="advance-maturity" secondary />
                    )}
                  </div>
                </details>
                {local && (
                  <details>
                    <summary>
                      Test the safeguards <ShieldCheck size={14} />
                    </summary>
                    <p>
                      These submit real rejected contract operations and compare
                      balances. A failed request is not a simulated success.
                    </p>
                    <div className="secondary-actions">
                      <ActionButton action="challenge-forgery" secondary />
                      <ActionButton action="challenge-duplicate" secondary />
                    </div>
                  </details>
                )}
              </div>
            </aside>
          </div>
          <section className="evidence-bar">
            <div className="evidence-icon">
              <ShieldCheck size={21} />
            </div>
            <div>
              <b>Proof you can inspect.</b>
              <p>
                Account proof → worker result → NEAR receipt → Ethereum release.
              </p>
            </div>
            <button onClick={openEvidence}>
              Open evidence <ArrowUpRight size={15} />
            </button>
            <span className="receipt-count">{receipts.length} receipts</span>
          </section>
          <footer>
            <span>
              ProofCredit <span className="footer-slash">/</span> Built for
              verifiable credit.
            </span>
            <span>
              Test assets only. No redemption or production custody promise.
            </span>
          </footer>
        </main>
      </div>
      {drawer && (
        <div className="drawer-backdrop" onClick={() => setDrawer(false)}>
          <section
            ref={drawerRef}
            className="evidence-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Chain evidence and receipts"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span className="eyebrow">VERIFY THE JOURNEY</span>
                <h2>Evidence & receipts</h2>
              </div>
              <button
                aria-label="Close evidence"
                onClick={() => setDrawer(false)}
                autoFocus
              >
                <X size={22} />
              </button>
            </header>
            <p className="drawer-intro">
              Actual coordinator observations. Pending, included, and
              authenticated are distinct stages. Local hashes have no public
              explorer.
            </p>
            <dl className="evidence-meta">
              <div>
                <dt>Loan phase</dt>
                <dd>{market?.phase ?? "Uninitialized"}</dd>
              </div>
              <div>
                <dt>Proof status</dt>
                <dd>{state?.proofStatus ?? "No authenticated proof"}</dd>
              </div>
              <div>
                <dt>Finalized ETH block</dt>
                <dd>{state?.ethereum?.finalizedBlock ?? "—"}</dd>
              </div>
              <div>
                <dt>Release</dt>
                <dd>{settlementLabel(settlement?.stage)}</dd>
              </div>
            </dl>
            <div className="receipt-list">
              {receipts.length === 0 ? (
                <div className="empty-receipts">
                  <Clock3 size={26} />
                  <b>No receipts yet.</b>
                  <p>Run an action to build the evidence trail.</p>
                </div>
              ) : (
                [...receipts].reverse().map((receipt) => (
                  <article
                    key={receipt.id}
                    className={`receipt ${receipt.status}`}
                  >
                    <div className="receipt-title">
                      <span>{receipt.chain.toUpperCase()}</span>
                      <b>{receipt.action}</b>
                      <em>{receipt.status}</em>
                    </div>
                    <p>{receipt.detail}</p>
                    {receipt.hash && <code>{receipt.hash}</code>}
                    <div className="receipt-facts">
                      <span>Block {receipt.blockNumber ?? "pending"}</span>
                      {receipt.gasUsed && <span>Gas {receipt.gasUsed}</span>}
                      {receipt.feeWei && (
                        <span>Fee {eth(receipt.feeWei)} ETH</span>
                      )}
                    </div>
                  </article>
                ))
              )}
            </div>
            <details className="raw-evidence">
              <summary>Raw state & artifact evidence</summary>
              <pre>
                {JSON.stringify(
                  {
                    artifactHashes: config?.artifactHashes,
                    evidence: state?.evidence,
                    market,
                    settlement,
                    ethereum: state?.ethereum,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </section>
        </div>
      )}
    </>
  );
}

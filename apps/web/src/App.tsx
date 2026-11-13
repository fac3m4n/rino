import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock3,
  Fingerprint,
  FlaskConical,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import type {
  ActionName,
  Config,
  Receipt,
  Role,
  State,
  OperationView,
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
import { ReadPoller, pollingPending } from "./polling";
import { ActionFailure } from "./outcomes";
import {
  OperationClient,
  mergeOperations,
  operationPaused,
} from "./operation-client";
import { OperationPanel } from "./OperationPanel";
import { Brand } from "./Brand";
import { FeedbackToast } from "./FeedbackToast";
import { phaseTitle, type FeedbackNotice, type UiPhase } from "./feedback";
import { ThemeToggle } from "./ThemeToggle";
import { ActivityTable } from "./ActivityTable";
import { TransactionLink } from "./TransactionLink";
import {
  collateralShortfall,
  collateralSufficient,
} from "@proofcredit/coordinator/collateral";

const credit = (value?: string | null) =>
  value ? formatUnits(value, 6, 6) : "—";
const eth = (value?: string | null) =>
  value ? formatUnits(value, 18, 6) : "—";
const actionNames: Record<ActionName, string> = {
  initialize: "Initialize local market",
  fund: "Fund vault",
  prove: "Authenticate collateral",
  borrow: "Borrow CREDIT",
  repay: "Repay CREDIT",
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
  const [operations, setOperations] = useState<OperationView[]>([]);
  const operationsRef = useRef<OperationView[]>([]);
  const operationClient = useRef<OperationClient | null>(null);
  const [role, setRole] = useState<Role>("borrower");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<ActionName | "wallet" | null>(null);
  const [uiPhase, setUiPhase] = useState<UiPhase | null>(null);
  const [uiEvent, setUiEvent] = useState(0);
  const uiGeneration = useRef(0);
  const [connectionNotice, setConnectionNotice] = useState("");
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
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
  const wallets = useWallets(config);
  const inflight = useRef(false);
  const snapshots = useRef<SnapshotLane<Snapshot> | null>(null);
  const latest = useRef<Snapshot | null>(null);
  const poller = useRef<ReadPoller | null>(null);
  const unknownAction = useRef<UnconfirmedAction | null>(null);
  const networkPausedRef = useRef(false);
  const [networkPaused, setNetworkPaused] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [continued, setContinued] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const applyOperation = (op: OperationView) => {
    operationsRef.current = mergeOperations(operationsRef.current, [op]);
    setOperations(operationsRef.current);
  };
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
  const refresh = useCallback(async (options: { fresh?: boolean } = {}) => {
    if (!snapshots.current) return false;
    return snapshots.current.refresh(options);
  }, []);
  useEffect(() => {
    let active = true;
    const lane = new SnapshotLane<Snapshot>(
      (signal, options) => snapshot({ ...options, signal }),
      (data) => {
        latest.current = data;
        setConfig(data.config);
        setState(data.state);
        setReceipts(data.receipts);
        if (data.operations) {
          operationsRef.current = mergeOperations(
            operationsRef.current,
            data.operations,
          );
          setOperations(operationsRef.current);
          if (!operationClient.current) {
            let storage: Storage | undefined;
            try {
              storage = window.localStorage;
            } catch {
              /* Server recovery still works. */
            }
            operationClient.current = new OperationClient(
              data.config,
              (op) => {
                if (active) applyOperation(op);
              },
              storage,
            );
            void operationClient.current
              .recoverHints(data.operations)
              .catch(() => {});
          } else operationClient.current.updateConfig(data.config);
        }
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
    const automatic = new ReadPoller({
      read: async () => {
        if (inflight.current) return;
        try {
          await lane.refresh();
          return (
            latest.current?.config.ready === true && latest.current.state.ready
          );
        } catch (error) {
          if (active) {
            pauseNetwork(
              error instanceof Error
                ? error.message
                : "Unable to refresh chain state.",
            );
          }
          return false;
        }
      },
      operations: () => operationsRef.current,
      reconcile: async (op) => {
        if (inflight.current || !operationClient.current) return true;
        try {
          const checked = await operationClient.current.check(op);
          return !checked.steps.some((step) =>
            step.hashes.some(
              (hash) => hash.detail === "Provider unavailable; check again.",
            ),
          );
        } catch {
          return false;
        }
      },
      mode: () => latest.current?.config.mode ?? "public",
      pending: () =>
        pollingPending(
          latest.current?.state,
          inflight.current,
          !!unknownAction.current,
        ),
      available: () =>
        document.visibilityState !== "hidden" && navigator.onLine,
      subscribe: (wake) => {
        document.addEventListener("visibilitychange", wake);
        window.addEventListener("online", wake);
        window.addEventListener("offline", wake);
        return () => {
          document.removeEventListener("visibilitychange", wake);
          window.removeEventListener("online", wake);
          window.removeEventListener("offline", wake);
        };
      },
    });
    poller.current = automatic;
    automatic.start();
    return () => {
      active = false;
      automatic.dispose();
      if (poller.current === automatic) poller.current = null;
      lane.dispose();
      operationClient.current?.dispose();
      operationClient.current = null;
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
      : pending || refreshing
        ? "Wait for the pending transaction receipt."
        : config.capabilities?.operations &&
            (operations === undefined || operationPaused(operations))
          ? "An operation needs checking. Check its evidence or deliberately continue before another financial action."
          : uncertain && !continued
            ? "Outcome uncertain. Reconcile chain state and receipts before another financial action."
            : networkPaused
              ? "Latest chain state is unavailable. Refresh it before another financial action."
              : actionGuard(action, config, state, role, wallets);
  const reconcile = async () => {
    const lane = snapshots.current;
    if (!lane || pending) return;
    const uiToken = ++uiGeneration.current;
    setUiEvent(uiToken);
    setUiPhase("reconciling");
    setRefreshing(true);
    try {
      await lane.refresh({ fresh: true });
      poller.current?.delivered(
        latest.current?.config.ready === true && latest.current.state.ready,
      );
    } catch (error) {
      poller.current?.delivered(false);
      if (snapshots.current === lane)
        pauseNetwork(
          error instanceof Error
            ? error.message
            : "Unable to refresh chain state.",
        );
    } finally {
      if (snapshots.current === lane) {
        setRefreshing(false);
        if (uiGeneration.current === uiToken) setUiPhase(null);
      }
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
  const operationTask = async (task: () => Promise<void>) => {
    if (inflight.current) return;
    const lane = snapshots.current;
    const uiToken = ++uiGeneration.current;
    setUiEvent(uiToken);
    setUiPhase("checking-state");
    inflight.current = true;
    setRefreshing(true);
    poller.current?.changed();
    try {
      await task();
    } catch (error) {
      pauseNetwork(
        "Operation recovery is unavailable. Refresh current evidence before another financial action.",
      );
      throw error;
    } finally {
      inflight.current = false;
      setRefreshing(false);
      poller.current?.changed();
      if (snapshots.current === lane && uiGeneration.current === uiToken)
        setUiPhase(null);
    }
  };
  const run = async (action: ActionName) => {
    const lane = snapshots.current;
    if (!config || !state || !lane || inflight.current) return;
    const blocked = guard(action);
    if (blocked) {
      setError(blocked);
      return;
    }
    let before = latest.current ?? { config, state, receipts };
    let tracked = false;
    const token = lane.invalidate();
    const uiToken = ++uiGeneration.current;
    setUiEvent(uiToken);
    const showPhase = (phase: UiPhase | null) => {
      if (lane.isCurrent(token) && uiGeneration.current === uiToken)
        setUiPhase(phase);
    };
    showPhase("checking-state");
    inflight.current = true;
    poller.current?.changed();
    setPending(action);
    setError("");
    setMessage("");
    setConnectionNotice("");
    try {
      await lane.refresh({ fresh: true });
      if (!lane.isCurrent(token)) return;
      const current = latest.current;
      if (!current) throw Error("Latest chain state is unavailable.");
      before = current;
      const { config, state } = current;
      const market = state.market;
      const blocked = actionGuard(action, config, state, role, wallets);
      if (blocked) throw Error(blocked);
      if (
        config.mode === "public" &&
        config.capabilities?.operations === true
      ) {
        if (
          !current.operations ||
          !operationClient.current ||
          operationPaused(operationsRef.current)
        )
          throw Error(
            "Operation recovery must complete before another financial action.",
          );
        tracked = true;
        const client = operationClient.current;
        showPhase("preparing");
        const result = await client.create(
          action,
          role,
          action === "fund" && role === "borrower"
            ? (wallets.evmAccount ?? undefined)
            : undefined,
        );
        if (!lane.isCurrent(token)) return;
        if (
          result.operation.stage === "failed" &&
          result.operation.steps.length === 0
        )
          throw Error(result.operation.detail);
        if (result.funding) {
          const funding = result.funding;
          if (
            !market?.vault ||
            action !== "fund" ||
            role !== "borrower" ||
            funding.chainId !== "11155111" ||
            funding.from.toLowerCase() !== wallets.evmAccount?.toLowerCase() ||
            funding.to.toLowerCase() !== market.vault.toLowerCase() ||
            funding.data !== "0x" ||
            funding.valueWei !==
              collateralShortfall(
                market.terms,
                state.ethereum?.vaultBalanceWei,
              ).toString()
          )
            throw Error(
              "Prepared funding intent does not match the current wallet and collateral requirement.",
            );
          showPhase("wallet");
          await client.wallet(result.operation, (progress) =>
            wallets.fundEvm(
              config,
              funding.to as Address,
              BigInt(funding.valueWei),
              progress,
              funding.from as Address,
            ),
          );
        } else if (result.walletActions?.length) {
          showPhase("wallet");
          await client.wallet(result.operation, (progress) =>
            wallets.sendNear(
              config,
              result.walletActions!,
              role === "borrower"
                ? config.near.borrowerId
                : config.near.lenderId,
              progress,
            ),
          );
        }
        if (lane.isCurrent(token))
          setMessage("Operation recorded. Check Activity for confirmation.");
      } else if (
        config.mode === "public" &&
        action === "fund" &&
        role === "borrower"
      ) {
        if (!market?.vault) throw new Error("The vault has not been derived.");
        showPhase("wallet");
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
        showPhase("preparing");
        const result = await submitAction(config, action, role);
        if (!lane.isCurrent(token)) return;
        if (result.walletActions?.length) {
          showPhase("wallet");
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
        if (
          !tracked &&
          error instanceof ActionFailure &&
          error.uncertainMutation
        ) {
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
        showPhase("reconciling");
        try {
          await refresh({ fresh: true });
        } catch (error) {
          if (lane.isCurrent(token)) {
            poller.current?.delivered(false);
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
            poller.current?.changed();
            setPending(null);
            showPhase(null);
          }
        }
      }
    }
  };
  const connect = async (
    chain: "near" | "disconnect-near" | "ethereum" | "switch",
  ) => {
    if (!config || inflight.current) return;
    const lane = snapshots.current;
    const uiToken = ++uiGeneration.current;
    setUiEvent(uiToken);
    setUiPhase("wallet");
    setConnectionNotice("");
    inflight.current = true;
    poller.current?.changed();
    setPending("wallet");
    setError("");
    try {
      if (chain === "near") await wallets.connectNear(config);
      else if (chain === "disconnect-near") await wallets.disconnectNear();
      else if (chain === "switch") await wallets.switchEvm();
      else await wallets.connectEvm();
      if (snapshots.current === lane && uiGeneration.current === uiToken)
        setConnectionNotice(
          chain === "disconnect-near"
            ? "Wallet disconnected"
            : "Wallet connection updated",
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Wallet connection failed.");
    } finally {
      inflight.current = false;
      poller.current?.changed();
      setPending(null);
      if (snapshots.current === lane && uiGeneration.current === uiToken)
        setUiPhase(null);
    }
  };
  let primary: ActionName = "initialize";
  let stageTitle = "Set up credit line";
  let stageCopy =
    "Initialize the local actors and fixed loan terms. Every action below executes against the running chains.";
  if (market?.vault) {
    if (market.phase === "Offered") {
      const offered = offeredAction(state!, role, config!.mode);
      if (offered === "fund") {
        primary = "fund";
        stageTitle = "Fund credit line";
        stageCopy = local
          ? `Fund ${credit(market.terms.principal_units)} CREDIT in escrow and the ${credit(market.terms.fee_units)} CREDIT fee endowment, then top up the configured ETH collateral.`
          : "Fund the CREDIT offer as lender, then top up the exact ETH shortfall as borrower. Your wallet authorizes each action.";
        if (
          collateralSufficient(market.terms, state?.ethereum?.vaultBalanceWei)
        ) {
          stageTitle = "Restore the CREDIT offer.";
          stageCopy = `The vault already holds sufficient ETH. Fund ${credit(market.terms.principal_units)} CREDIT in lender escrow without depositing more collateral.`;
        }
        if (
          !local &&
          role === "lender" &&
          BigInt(market.available_liquidity_units) >=
            BigInt(market.terms.principal_units)
        ) {
          stageTitle = "Restore the borrower fee endowment.";
          stageCopy = `The CREDIT offer is funded. Transfer only the missing amount to give the borrower the ${credit(market.terms.fee_units)} CREDIT demonstration repayment fee.`;
        }
      } else if (offered === "prove") {
        primary = "prove";
        stageTitle = "Authenticate collateral";
        stageCopy =
          "Authenticate the funded Ethereum account through the worker and NEAR receipts.";
      } else {
        primary = "borrow";
        stageTitle = "Borrow CREDIT";
        stageCopy = `Receive ${credit(market.terms.principal_units)} test CREDIT on NEAR. Fixed repayment: ${credit(market.terms.debt_units)} CREDIT.`;
      }
    } else if (market.phase === "Active") {
      primary = role === "borrower" ? "repay" : "default";
      stageTitle = role === "borrower" ? "Repay loan" : "Lender position";
      stageCopy =
        role === "borrower"
          ? "Repay before maturity, then authenticate the Ethereum release."
          : "The lender may lock default at maturity. Recovery is capped; the borrower keeps any surplus.";
    } else if (market.phase === "Closed") {
      primary = "claim";
      stageTitle = "Loan closed";
      stageCopy =
        "The terminal Ethereum checkpoint is authenticated on NEAR. This vault is retired; do not send further deposits.";
    } else {
      primary = "settle";
      stageTitle = "Confirm release";
      stageCopy =
        "Sign the fixed transfer, relay it to Ethereum, then authenticate its receipt on NEAR.";
    }
  }
  if (!config || !state) {
    stageTitle = "Loading credit line";
    stageCopy =
      "Connecting to the coordinator for current position and network information.";
  }
  const latestOperation = [...operations]
    .reverse()
    .find((op) => !op.historical);
  const operationNotice =
    latestOperation &&
    (latestOperation.stage === "failed" ||
      latestOperation.unresolved ||
      latestOperation.stage === "partial")
      ? latestOperation
      : undefined;
  const notice: FeedbackNotice | null = error
    ? {
        id: `error:${uiEvent}:${error}`,
        kind: uncertain ? "uncertain" : "error",
        title: uncertain ? "Outcome uncertain" : "Request needs attention",
        detail: error,
      }
    : uncertain || networkPaused
      ? {
          id: `uncertain:${uiEvent}`,
          kind: "uncertain",
          title: "Current outcome needs checking",
          detail:
            "Use the persistent recovery notice before another financial action.",
        }
      : uiPhase
        ? {
            id: `phase:${uiEvent}:${uiPhase}`,
            kind: "pending",
            title: phaseTitle[uiPhase],
            detail:
              uiPhase === "reconciling" && message
                ? message
                : "Financial controls stay paused while this request is in progress.",
          }
        : operationNotice
          ? {
              id: `operation:${operationNotice.id}:${operationNotice.stage}`,
              kind: operationNotice.stage === "failed" ? "error" : "uncertain",
              title:
                operationNotice.stage === "failed"
                  ? "Operation unsuccessful"
                  : "Checking transaction",
              detail:
                "Review exact transaction evidence in operation recovery. Current loan state is shown separately.",
            }
          : message || connectionNotice
            ? {
                id: `info:${uiEvent}:${message || connectionNotice}`,
                kind: "info",
                title: connectionNotice || message,
              }
            : null;
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
        {!config || !state
          ? "Loading credit line…"
          : pending === action
            ? "Waiting for receipts…"
            : action === "fund" && role === "lender"
              ? local
                ? "Fund offer + vault"
                : "Fund CREDIT offer"
              : action === "fund"
                ? `Fund vault · ${eth(fundingShortfall)} ETH`
                : action === "borrow"
                  ? `Borrow ${credit(market?.terms.principal_units)} CREDIT`
                  : action === "repay"
                    ? `Repay ${credit(market?.terms.debt_units)} CREDIT`
                    : actionNames[action]}
        {!secondary && pending !== action ? <ArrowRight size={17} /> : null}
      </button>
    );
  }
  return (
    <>
      <div className="app-shell">
        <header className="topbar">
          <Brand />
          <nav aria-label="Primary">
            <a className="nav-active" href="#position">
              Your position
            </a>
            <a href="#activity">Activity</a>
            <button onClick={openEvidence}>
              Market details <ArrowUpRight size={14} />
            </button>
          </nav>
          <div className="header-controls">
            <span className="environment-badge">
              <FlaskConical size={15} />
              {config
                ? local
                  ? "Local two-chain demo"
                  : "Public testnet mode"
                : "Connecting environment"}
            </span>
            <ThemeToggle />
          </div>
        </header>
        <main>
          <section className="heading" id="position">
            <div>
              <h1>Your position</h1>
              <p>Borrow on NEAR. Keep your collateral on Ethereum.</p>
            </div>
            <div className="network-label">
              {!config ? (
                "Connecting networks"
              ) : (
                <>
                  {local ? "Local Ethereum" : "Sepolia"}
                  <span aria-hidden="true">→</span>NEAR{" "}
                  {local ? "Sandbox" : "testnet"}
                </>
              )}
            </div>
          </section>
          {(!config || !state) && (
            <div className="notice loading-position" role="status">
              <RefreshCw size={16} className="spin" aria-hidden="true" />
              Loading current position…
            </div>
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
          <FeedbackToast
            notice={notice?.id === dismissedNotice ? null : notice}
            onDismiss={() => setDismissedNotice(notice?.id ?? null)}
          />
          <div className="dashboard-grid">
            <div className="overview">
              <div
                className={`asset-cards ${!state ? "position-loading" : ""}`}
                aria-busy={!state}
              >
                <section className="asset-card">
                  <h2>ETH collateral</h2>
                  <div className="asset-balance" data-testid="vault-balance">
                    {eth(state?.ethereum?.vaultBalanceWei)} <span>ETH</span>
                  </div>
                  <p>
                    {!state
                      ? "Loading collateral state"
                      : settlement?.retired
                        ? "Vault retired"
                        : market?.proof_fresh
                          ? "Collateral authenticated"
                          : "Awaiting fresh collateral proof"}
                  </p>
                </section>
                <section className="asset-card">
                  <h2>
                    {market?.phase === "DefaultLocked"
                      ? "Debt at default"
                      : "Outstanding debt"}
                  </h2>
                  <div className="asset-balance" data-testid="loan-debt">
                    {credit(
                      market?.phase === "DefaultLocked"
                        ? market.terms.debt_units
                        : market?.debt_units,
                    )}{" "}
                    <span>CREDIT</span>
                  </div>
                  <p>Fixed fee · {credit(market?.terms.fee_units)} CREDIT</p>
                </section>
                <section className="asset-card">
                  <h2>Wallet balance</h2>
                  <div className="asset-balance" data-testid="credit-balance">
                    {credit(
                      role === "borrower"
                        ? market?.borrower_balance_units
                        : market?.lender_balance_units,
                    )}{" "}
                    <span>CREDIT</span>
                  </div>
                  <p>
                    {!config ? (
                      "Connecting wallet network"
                    ) : (
                      <>
                        Configured {role} · NEAR {local ? "Sandbox" : "testnet"}
                      </>
                    )}
                  </p>
                </section>
              </div>
              <section className="terms-panel">
                <div className="panel-heading">
                  <h2>Your credit line</h2>
                  <button onClick={openEvidence}>
                    Details <ArrowUpRight size={14} />
                  </button>
                </div>
                <div className="market-pair">
                  <span className="token-icon">
                    <EthereumMark />
                  </span>
                  <div>
                    <h3>ETH / CREDIT</h3>
                    <p>Ethereum collateral · NEAR liquidity</p>
                  </div>
                  <span className="phase-badge">
                    {market?.phase ?? (!state ? "Loading…" : "Uninitialized")}
                  </span>
                </div>
                <div className="terms-grid">
                  <div>
                    <span>Principal</span>
                    <b>
                      {credit(market?.terms.principal_units)}{" "}
                      <small>CREDIT</small>
                    </b>
                  </div>
                  <div>
                    <span>Fixed fee</span>
                    <b>
                      {credit(market?.terms.fee_units)} <small>CREDIT</small>
                    </b>
                  </div>
                  <div>
                    <span>Maximum LTV</span>
                    <b>
                      {market?.terms.max_ltv_bps
                        ? `${formatUnits(market.terms.max_ltv_bps, 2, 2)}%`
                        : "—"}
                    </b>
                  </div>
                </div>
              </section>
              <section className="journey-panel">
                <div className="panel-heading">
                  <h2>Loan progress</h2>
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
                      {step.skipped && (
                        <small className="step-outcome">{step.sub}</small>
                      )}
                    </li>
                  ))}
                </ol>
                <details className="progress-details">
                  <summary>Progress details</summary>
                  <dl>
                    {steps
                      .filter((step) => !step.skipped)
                      .map((step) => (
                        <div key={step.name}>
                          <dt>{step.name}</dt>
                          <dd>{step.sub}</dd>
                        </div>
                      ))}
                  </dl>
                </details>
              </section>
              <ActivityTable
                config={config}
                receipts={receipts}
                onOpenEvidence={openEvidence}
              />
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
                  {market?.phase ?? (!state ? "CONNECTING" : "NEW CREDIT LINE")}
                </div>
                <h2>{stageTitle}</h2>
                <p>{stageCopy}</p>
                <div className="repayment-row">
                  <span>Total repayment</span>
                  <b>
                    {credit(market?.terms.debt_units)} <small>CREDIT</small>
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
                <div className="repayment-row">
                  <span>Loan term</span>
                  <b>
                    {market?.terms.term_seconds
                      ? `${market.terms.term_seconds} sec`
                      : "—"}
                  </b>
                </div>
                {config?.capabilities?.operations &&
                  operationPaused(operations) && (
                    <div className="pending-box recovery-prompt">
                      <b>An operation needs checking.</b>
                      <p>
                        Financial actions remain paused. Inspect the exact
                        transaction before continuing.
                      </p>
                      <a href="#operation-recovery">
                        Check operation recovery <ArrowRight size={14} />
                      </a>
                    </div>
                  )}
                <ActionButton action={primary} />
                {guard(primary) && (
                  <p className="guard-reason">{guard(primary)}</p>
                )}
                <div className="authority-note">
                  <Fingerprint size={14} />
                  <span>
                    {!config
                      ? "Connecting signing environment"
                      : local
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
                        ? uiPhase
                          ? phaseTitle[uiPhase]
                          : "Transaction in progress. Waiting for actual receipts."
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
                      title={wallets.nearAccount || undefined}
                    >
                      <NearMark />
                      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                        {wallets.nearAccount || "Connect NEAR testnet"}
                      </span>
                    </button>
                    {wallets.nearAccount && (
                      <button
                        className="button secondary"
                        disabled={!!pending}
                        onClick={() => void connect("disconnect-near")}
                      >
                        Disconnect NEAR
                      </button>
                    )}
                    <button
                      className="button secondary"
                      disabled={!!pending}
                      onClick={() => void connect("ethereum")}
                    >
                      <EthereumMark />
                      {wallets.evmAccount
                        ? wallets.evmAccount
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
                <details className="identity-details">
                  <summary>
                    Accounts & vault <ChevronDown size={14} />
                  </summary>
                  <dl className="identity-meta">
                    <div>
                      <dt>Intended {role}</dt>
                      <dd>
                        {role === "borrower"
                          ? (config?.near.borrowerId ?? "—")
                          : (config?.near.lenderId ?? "—")}
                      </dd>
                    </div>
                    <div>
                      <dt>Connected NEAR signer</dt>
                      <dd>
                        {wallets.nearAccount ||
                          (local ? "Local development actor" : "Not connected")}
                      </dd>
                    </div>
                    <div>
                      <dt>Connected Ethereum signer</dt>
                      <dd>{wallets.evmAccount || "Not connected"}</dd>
                    </div>
                    <div>
                      <dt>Ethereum wallet network</dt>
                      <dd>{wallets.evmChainId ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Vault address</dt>
                      <dd>{market?.vault ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>Account nonce</dt>
                      <dd>{state?.ethereum?.vaultNonce ?? "—"}</dd>
                    </div>
                    <div>
                      <dt>
                        {role === "borrower"
                          ? "Lender escrow"
                          : "Claimable CREDIT"}
                      </dt>
                      <dd>
                        {credit(
                          role === "borrower"
                            ? market?.available_liquidity_units
                            : market?.lender_claim_units,
                        )}{" "}
                        CREDIT
                      </dd>
                    </div>
                  </dl>
                </details>
                <p className="asset-disclosure">
                  Demo CREDIT has no redemption value.
                </p>
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
          <div id="operation-recovery" tabIndex={-1}>
            {config?.mode === "public" && config.capabilities?.operations && (
              <OperationPanel
                config={config}
                operations={operations}
                disabled={!!pending || refreshing}
                onCheck={(op) =>
                  operationTask(async () => {
                    if (!operationClient.current) return;
                    await operationClient.current.check(op);
                    await reconcile();
                  })
                }
                onHash={(op, step, hash) =>
                  operationTask(async () => {
                    if (!operationClient.current) return;
                    await operationClient.current.observe(op, {
                      step,
                      event: "hash",
                      hash,
                    });
                    await operationClient.current.check(op);
                    await reconcile();
                  })
                }
                onContinue={(op) =>
                  operationTask(async () => {
                    if (!operationClient.current) return;
                    await operationClient.current.check(op);
                    const lane = snapshots.current;
                    if (
                      !lane ||
                      !(await lane.refresh({ fresh: true })) ||
                      !latest.current?.config.ready ||
                      !latest.current.state.ready ||
                      latest.current.state.busy
                    )
                      throw Error(
                        "Fresh ready idle state is required before continuing.",
                      );
                    await operationClient.current.continue(op);
                    if (!(await lane.refresh({ fresh: true })))
                      throw Error(
                        "Unable to refresh state after continuation.",
                      );
                  })
                }
                onImport={(action, importRole, hash) =>
                  operationTask(async () => {
                    if (!operationClient.current) return;
                    await operationClient.current.import(
                      action,
                      importRole,
                      hash,
                    );
                    await reconcile();
                  })
                }
                onError={setError}
              />
            )}
          </div>
          <div className="protocol-details">
            <section
              className="authority-strip"
              aria-label="Network and authority"
            >
              <div>
                <span className="small-network">E</span>
                <b>
                  {!config
                    ? "Ethereum · connecting"
                    : local
                      ? "Ethereum · local Anvil"
                      : "Ethereum · Sepolia"}
                </b>
                <span className="cross-arrow">↔</span>
                <NearMark />
                <b>
                  NEAR ·{" "}
                  {!config ? "connecting" : local ? "Sandbox" : "testnet"}
                </b>
              </div>
              <span className="authority-summary">
                {!config
                  ? "Connecting authority information"
                  : local
                    ? "Mock MPC / executor · synthetic RPC"
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
                  {!config
                    ? "Connecting to the coordinator for environment and authority details."
                    : local
                      ? "Local actors hold development keys. Two synthetic RPC routes share one owned Anvil; mock MPC and executor services are trusted. The controller and real worker execute against local chains."
                      : "Connected users authorize financial actions. Public testnet readiness must pass before any action is available."}
                </p>
                <p>
                  Receipt data relies on the declared two-RPC policy. This is
                  not a receipt-trie light client or hardware attestation.
                  Editable developer accounts and configured service authorities
                  remain trusted.
                </p>
                <ul>
                  {config?.authority.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <p>
                  Chain ID: {config?.ethereum.chainId ?? "—"} ·{" "}
                  {market?.terms.term_seconds ?? config?.termSeconds ?? "—"}{" "}
                  second configured term . CREDIT is a nonredeemable test asset.
                </p>
              </section>
            )}
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
              Rino <span className="footer-slash">/</span> Credit, across
              chains.
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
                <dt>Borrower</dt>
                <dd>{config?.near.borrowerId ?? "—"}</dd>
              </div>
              <div>
                <dt>Lender</dt>
                <dd>{config?.near.lenderId ?? "—"}</dd>
              </div>
              <div>
                <dt>Connected NEAR signer</dt>
                <dd>{wallets.nearAccount || "Not connected"}</dd>
              </div>
              <div>
                <dt>Connected Ethereum signer</dt>
                <dd>{wallets.evmAccount || "Not connected"}</dd>
              </div>
              <div>
                <dt>Vault</dt>
                <dd>{market?.vault ?? "—"}</dd>
              </div>
              <div>
                <dt>Fixed reference (not a price oracle)</dt>
                <dd>
                  {credit(market?.terms.reference_units_per_eth)} CREDIT / ETH
                </dd>
              </div>
              <div>
                <dt>Loan phase</dt>
                <dd>
                  {market?.phase ?? (!state ? "Loading…" : "Uninitialized")}
                </dd>
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
                    <TransactionLink
                      config={config}
                      chain={receipt.chain}
                      hash={receipt.hash}
                    />
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

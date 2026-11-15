import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type MutableRefObject,
} from "react";
import { flushSync } from "react-dom";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock3,
  FlaskConical,
  Info,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type {
  ActionName,
  Config,
  Receipt,
  Role,
  State,
  OperationView,
} from "@rino/coordinator/api";
import type { Address } from "viem";
import {
  actionGuard,
  formatUnits,
  settlementLabel,
  loanHistory,
  fundingHistory,
} from "./model";
import { submitAction, RequestFailure, type Snapshot } from "./client";
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
import { Dialog } from "./Dialog";
import { NearWalletChoices } from "./NearWalletChoices";
import { FeedbackToast } from "./FeedbackToast";
import { phaseTitle, type FeedbackNotice, type UiPhase } from "./feedback";
import { ThemeToggle } from "./ThemeToggle";
import { ActivityTable } from "./ActivityTable";
import { TransactionLink } from "./TransactionLink";
import {
  collateralShortfall,
  collateralSufficient,
} from "@rino/coordinator/collateral";
import {
  loadMarkets,
  requireMarket,
  marketSnapshot,
  type MarketCatalog,
  type MarketDescriptor,
} from "./markets";
import {
  positionAction,
  positionStatus,
  portfolioSummary,
  isOpenPosition,
  claimable,
  fundingAmounts,
  type PositionRecord,
  type AssetBalance,
} from "./portfolio";
const credit = (value?: string | null) =>
  value ? formatUnits(value, 6, 6) : "—";
const eth = (value?: string | null) =>
  value ? formatUnits(value, 18, 6) : "—";
const exactEth = (value?: string | null) =>
  value ? formatUnits(value, 18, 18) : "—";
const ethFee = (value?: string | null) =>
  value && BigInt(value) > 0n && BigInt(value) < 1000000000000n
    ? "<0.000001"
    : eth(value);
const actionNames: Record<ActionName, string> = {
  initialize: "Create position",
  fund: "Add collateral",
  prove: "Verify collateral",
  borrow: "Borrow CREDIT",
  repay: "Repay loan",
  default: "Settle overdue loan",
  cancel: "Cancel position",
  settle: "Release collateral",
  claim: "Claim CREDIT",
  "challenge-forgery": "Try forged proof",
  "challenge-duplicate": "Try duplicate borrow",
  "advance-maturity": "Advance to maturity",
  recover: "Reconcile pending operation",
};
type View = "dashboard" | "lend" | "activity";
type Panel =
  | "position"
  | "wallets"
  | "networks"
  | "review"
  | "transaction"
  | "evidence"
  | "recovery"
  | "new"
  | "balances";
type Command = {
  id: string;
  panel: Panel | null;
  action?: ActionName;
  serial: number;
};
type Wallets = ReturnType<typeof useWallets>;
type WorkspaceProps = {
  descriptor: MarketDescriptor;
  active: boolean;
  view: View;
  role: Role;
  wallets: Wallets;
  records: PositionRecord[];
  command: Command | null;
  lock: MutableRefObject<string | null>;
  onLock: (id: string | null) => void;
  onRecord: (record: PositionRecord) => void;
  onSelect: (id: string, panel: Panel | null, action?: ActionName) => void;
  onView: (view: View) => void;
  onRole: (role: Role) => void;
};
const short = (value: string) =>
  value.length > 26 ? `${value.slice(0, 15)}…${value.slice(-8)}` : value;
function timeLabel(value?: string | null) {
  if (!value) return "—";
  const ms = BigInt(value) * 1000n;
  if (ms > 8640000000000000n) return "Unavailable";
  return (
    new Date(Number(ms)).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    }) + " UTC"
  );
}
function durationLabel(value?: string) {
  if (!value) return "—";
  const seconds = BigInt(value);
  return seconds % 3600n === 0n
    ? `${seconds / 3600n} hours`
    : seconds % 60n === 0n
      ? `${seconds / 60n} minutes`
      : `${seconds} seconds`;
}
function AssetIcon({ chain }: { chain: "ethereum" | "near" }) {
  return (
    <span className="asset-icon">
      <img
        src={chain === "ethereum" ? "/assets/ethereum.png" : "/assets/near.svg"}
        alt=""
        width="24"
        height="24"
      />
    </span>
  );
}
function Definition({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="definition">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
function Badge({ label, tone }: { label: string; tone: string }) {
  return <span className={`badge ${tone}`}>{label}</span>;
}
export default function App() {
  const [catalog, setCatalog] = useState<MarketCatalog>(),
    [catalogError, setCatalogError] = useState(""),
    [revision, setRevision] = useState(0);
  const params = new URLSearchParams(location.search),
    initialView = params.get("view");
  const [selected, setSelected] = useState(params.get("market") || "primary");
  const [view, setView] = useState<View>(
    initialView === "lend"
      ? "lend"
      : initialView === "activity"
        ? "activity"
        : "dashboard",
  );
  const [role, setRole] = useState<Role>(
    initialView === "lend" ? "lender" : "borrower",
  );
  const [recordMap, setRecordMap] = useState<Record<string, PositionRecord>>(
    {},
  );
  const [command, setCommand] = useState<Command | null>(null),
    serial = useRef(0),
    lock = useRef<string | null>(null);
  const [, setLockRevision] = useState(0);
  const primary = catalog?.markets[0];
  const walletConfig = primary
    ? recordMap[primary.id]?.snapshot?.config
    : undefined;
  const wallets = useWallets(walletConfig);
  useEffect(() => {
    const controller = new AbortController();
    setCatalogError("");
    void loadMarkets({ signal: controller.signal })
      .then((data) => {
        requireMarket(data, selected);
        setCatalog(data);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setCatalogError(
            error instanceof Error ? error.message : "Markets are unavailable.",
          );
      });
    return () => controller.abort();
  }, [revision]);
  const onRecord = useCallback(
    (record: PositionRecord) =>
      setRecordMap((old) => ({ ...old, [record.descriptor.id]: record })),
    [],
  );
  const onLock = useCallback((id: string | null) => {
    lock.current = id;
    setLockRevision((value) => value + 1);
  }, []);
  const onView = (next: View) => {
    setView(next);
    if (next !== "activity" && walletConfig?.mode !== "local")
      setRole(next === "lend" ? "lender" : "borrower");
    history.replaceState(
      null,
      "",
      `?market=${encodeURIComponent(selected)}&view=${next}`,
    );
  };
  const onSelect = (id: string, panel: Panel | null, action?: ActionName) => {
    if (!catalog) return;
    requireMarket(catalog, id);
    setSelected(id);
    setCommand({ id, panel, action, serial: ++serial.current });
    history.replaceState(
      null,
      "",
      `?market=${encodeURIComponent(id)}&view=${view}`,
    );
  };
  useEffect(() => {
    document.title = `ЯINO — ${view === "lend" ? "Lending" : view === "activity" ? "Activity" : "Dashboard"}`;
  }, [view]);
  if (!catalog)
    return (
      <>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <header className="app-header">
          <div className="header-inner">
            <Brand />
          </div>
        </header>
        <main id="main" className="app-main">
          <h1>Dashboard</h1>
          <section
            className="panel empty"
            role={catalogError ? "alert" : "status"}
          >
            {catalogError ? (
              <>
                <h2>Positions are unavailable</h2>
                <p>{catalogError}</p>
                <button
                  className="button primary"
                  onClick={() => setRevision((n) => n + 1)}
                >
                  Try again
                </button>
              </>
            ) : (
              <>
                <RefreshCw className="spin" />
                <p>Loading your markets…</p>
              </>
            )}
          </section>
        </main>
      </>
    );
  const records = catalog.markets.map(
    (descriptor) =>
      recordMap[descriptor.id] ?? {
        descriptor,
        paused: false,
        pending: false,
        unavailable: false,
      },
  );
  return (
    <>
      {catalog.markets.map((descriptor) => (
        <MarketWorkspace
          key={descriptor.id}
          descriptor={descriptor}
          active={selected === descriptor.id}
          view={view}
          role={role}
          wallets={wallets}
          records={records}
          command={command}
          lock={lock}
          onLock={onLock}
          onRecord={onRecord}
          onSelect={onSelect}
          onView={onView}
          onRole={setRole}
        />
      ))}
    </>
  );
}
function MarketWorkspace(props: WorkspaceProps) {
  const { descriptor, active, view, role, wallets, onRecord, onLock } = props;
  const [config, setConfig] = useState<Config>();
  const [state, setState] = useState<State>();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [operations, setOperations] = useState<OperationView[]>([]);
  const operationsRef = useRef<OperationView[]>([]);
  const operationClient = useRef<OperationClient | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<ActionName | "wallet" | null>(null);
  const [uiPhase, setUiPhase] = useState<UiPhase | null>(null);
  const [uiEvent, setUiEvent] = useState(0);
  const uiGeneration = useRef(0);
  const [connectionNotice, setConnectionNotice] = useState("");
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [reviewAction, setReviewAction] = useState<ActionName>("initialize");
  const [filter, setFilter] = useState<"open" | "all" | "closed">("open");
  const walletIntent = useRef<ActionName | null>(null);
  const [choosingNear, setChoosingNear] = useState(false);
  const openEvidence = () => setPanel("evidence");
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
      (signal, options) => marketSnapshot(descriptor, { ...options, signal }),
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
              descriptor.apiBase,
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
  const foreignPause = props.records.find(
    (record) => record.descriptor.id !== descriptor.id && record.paused,
  );
  const guard = (action: ActionName) =>
    props.lock.current && props.lock.current !== descriptor.id
      ? "Another position has a wallet request in progress."
      : foreignPause
        ? `Check the unresolved request in ${foreignPause.descriptor.name} first.`
        : !config || !state
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
    if (
      inflight.current ||
      (props.lock.current && props.lock.current !== descriptor.id)
    )
      return;
    const lane = snapshots.current;
    const uiToken = ++uiGeneration.current;
    setUiEvent(uiToken);
    setUiPhase("checking-state");
    inflight.current = true;
    onLock(descriptor.id);
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
      if (props.lock.current === descriptor.id) onLock(null);
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
    onLock(descriptor.id);
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
        const result = await submitAction(config, action, role, {
          apiBase: descriptor.apiBase,
        });
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
            if (props.lock.current === descriptor.id) onLock(null);
            poller.current?.changed();
            setPending(null);
            showPhase(null);
          }
        }
      }
    }
  };
  const connect = async (
    chain:
      | "near"
      | "disconnect-near"
      | "ethereum"
      | "disconnect-ethereum"
      | "switch",
    walletId?: string,
  ) => {
    if (!config || inflight.current || props.lock.current) return;
    const lane = snapshots.current;
    const uiToken = ++uiGeneration.current;
    setUiEvent(uiToken);
    setUiPhase("wallet");
    setConnectionNotice("");
    inflight.current = true;
    onLock(descriptor.id);
    poller.current?.changed();
    setPending("wallet");
    setError("");
    try {
      if (chain === "near") {
        // The SDK selector lives outside this native dialog and must remain interactive.
        flushSync(() => setPanel(null));
        await wallets.connectNear(config, walletId);
        setChoosingNear(false);
        if (!walletIntent.current) setPanel("wallets");
      } else if (chain === "disconnect-near") await wallets.disconnectNear();
      else if (chain === "disconnect-ethereum") wallets.disconnectEvm();
      else if (chain === "switch") await wallets.switchEvm();
      else await wallets.connectEvm();
      if (snapshots.current === lane && uiGeneration.current === uiToken)
        setConnectionNotice(
          chain === "disconnect-near" || chain === "disconnect-ethereum"
            ? "Wallet disconnected"
            : "Wallet connection updated",
        );
    } catch (e) {
      if (chain === "near") setPanel("wallets");
      setError(e instanceof Error ? e.message : "Wallet connection failed.");
    } finally {
      inflight.current = false;
      if (props.lock.current === descriptor.id) onLock(null);
      poller.current?.changed();
      setPending(null);
      if (snapshots.current === lane && uiGeneration.current === uiToken)
        setUiPhase(null);
    }
  };
  const own: PositionRecord = {
    descriptor,
    snapshot:
      config && state ? { config, state, receipts, operations } : undefined,
    paused: (uncertain && !continued) || operationPaused(operations),
    pending: !!pending || !!state?.busy,
    unavailable: networkPaused || (!state && !!error),
  };
  useEffect(
    () =>
      onRecord({
        descriptor,
        snapshot:
          config && state ? { config, state, receipts, operations } : undefined,
        paused: (uncertain && !continued) || operationPaused(operations),
        pending: !!pending || !!state?.busy,
        unavailable: networkPaused || (!state && !!error),
      }),
    [
      descriptor,
      config,
      state,
      receipts,
      operations,
      pending,
      uncertain,
      continued,
      networkPaused,
      error,
      onRecord,
    ],
  );
  const desiredRole: Role =
    view === "lend" ? "lender" : view === "dashboard" ? "borrower" : role;
  function needsWallet(action: ActionName) {
    if (!config) return false;
    if (config.mode === "local") return role !== desiredRole;
    return action === "fund" && role === "borrower"
      ? !wallets.evmAccount || wallets.evmChainId !== 11155111
      : wallets.nearAccount !==
          (role === "borrower" ? config.near.borrowerId : config.near.lenderId);
  }
  function askAction(action: ActionName) {
    setReviewAction(action);
    if (needsWallet(action)) {
      walletIntent.current = action;
      setPanel("wallets");
    } else setPanel("review");
  }
  useEffect(() => {
    const command = props.command;
    if (active && command?.id === descriptor.id) {
      if (command.action) askAction(command.action);
      else setPanel(command.panel);
    }
  }, [active, props.command]);
  useEffect(() => {
    if (
      walletIntent.current &&
      !pending &&
      panel === "wallets" &&
      !needsWallet(walletIntent.current)
    ) {
      setReviewAction(walletIntent.current);
      walletIntent.current = null;
      setPanel("review");
    }
  }, [
    wallets.nearAccount,
    wallets.evmAccount,
    wallets.evmChainId,
    role,
    pending,
  ]);
  const visibleRecords = props.records.filter(
    (record) =>
      record.snapshot?.config.mode === "local" ||
      !wallets.nearAccount ||
      !record.snapshot ||
      (desiredRole === "lender"
        ? record.snapshot.config.near.lenderId
        : record.snapshot.config.near.borrowerId) === wallets.nearAccount,
  );
  const totals = portfolioSummary(
      visibleRecords,
      props.records.some((record) => record.paused),
    ),
    status = positionStatus(own, desiredRole),
    next = positionAction(own, desiredRole);
  const funding = fundingAmounts(own);
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
    : uiPhase
      ? {
          id: `phase:${uiEvent}:${uiPhase}`,
          kind: "pending",
          title: phaseTitle[uiPhase],
        }
      : operationNotice
        ? {
            id: `operation:${operationNotice.id}:${operationNotice.stage}`,
            kind: operationNotice.stage === "failed" ? "error" : "uncertain",
            title:
              operationNotice.stage === "failed"
                ? "Operation unsuccessful"
                : "Request needs checking",
            detail: operationNotice.detail,
          }
        : message || connectionNotice
          ? {
              id: `info:${uiEvent}:${message || connectionNotice}`,
              kind: "info",
              title: connectionNotice || message,
            }
          : null;
  const reportStatus = pending
    ? uiPhase === "checking-state"
      ? "Checking current state"
      : uiPhase === "preparing"
        ? "Preparing request"
        : uiPhase === "reconciling"
          ? "Verifying position"
          : latestOperation?.steps.some((step) => step.hashes.length)
            ? "Transaction reported · verifying receipt"
            : "Waiting for wallet response"
    : own.paused
      ? "Outcome needs checking"
      : error
        ? "Request needs attention"
        : "Position updated";
  const showPersonal = local || !!wallets.nearAccount;
  const ownsRole =
    local ||
    wallets.nearAccount ===
      (role === "lender" ? config?.near.lenderId : config?.near.borrowerId);
  const rowRecords = visibleRecords.filter(
    (record) =>
      filter === "all" ||
      (filter === "closed"
        ? !isOpenPosition(record, desiredRole)
        : isOpenPosition(record, desiredRole)),
  );
  const newRecords = props.records.filter(
    (record) =>
      record.snapshot?.config.ready &&
      record.snapshot.state.ready &&
      !record.snapshot.state.market?.vault &&
      !record.unavailable,
  );
  function assetTotal(values: AssetBalance[]) {
    if (totals.collateralWei === null) return <span>—</span>;
    if (values.length === 0)
      return (
        <>
          0 <small>CREDIT</small>
        </>
      );
    if (values.length === 1)
      return (
        <>
          {credit(values[0].units.toString())} <small>CREDIT</small>
        </>
      );
    return (
      <button className="stat-link" onClick={() => setPanel("balances")}>
        {values.length} markets <Info size={14} />
      </button>
    );
  }
  function renderActionButton({
    action,
    secondary = false,
  }: {
    action: ActionName;
    secondary?: boolean;
  }) {
    const reason = guard(action);
    return (
      <button
        className={`button ${secondary ? "secondary" : "primary"}`}
        disabled={!!reason && !needsWallet(action)}
        title={reason ?? undefined}
        onClick={() => askAction(action)}
      >
        {action === "fund" && role === "lender"
          ? local
            ? "Fund offer + vault"
            : "Fund CREDIT offer"
          : action === "fund"
            ? `Add collateral · ${exactEth(fundingShortfall)} ETH`
            : action === "borrow"
              ? `Borrow ${credit(market?.terms.principal_units)} CREDIT`
              : action === "repay"
                ? `Repay ${credit(market?.debt_units)} CREDIT`
                : action === "claim"
                  ? `Claim ${credit(claimable(own).toString())} CREDIT`
                  : actionNames[action]}
      </button>
    );
  }
  function renderTerms() {
    return market ? (
      <details className="disclosure">
        <summary>Loan terms</summary>
        <dl className="definitions">
          <Definition label="Fixed principal">
            {credit(market.terms.principal_units)} CREDIT
          </Definition>
          <Definition label="One-time fee">
            {credit(market.terms.fee_units)} CREDIT
          </Definition>
          <Definition label="Total repayment">
            {credit(market.terms.debt_units)} CREDIT
          </Definition>
          <Definition label="Term after borrowing">
            {durationLabel(market.terms.term_seconds)}
          </Definition>
          <Definition label="Maximum LTV">
            {formatUnits(market.terms.max_ltv_bps, 2, 2)}%
          </Definition>
          <Definition label="Reference valuation">
            {credit(market.terms.reference_units_per_eth)} CREDIT per ETH
          </Definition>
          <Definition label="Settlement reserve">
            {eth(
              (
                BigInt(market.terms.fee_cap_wei_per_gas) *
                21000n *
                6n
              ).toString(),
            )}{" "}
            ETH
          </Definition>
          <Definition label="CREDIT contract">
            {config?.near.controllerId}
          </Definition>
        </dl>
        <p>
          CREDIT is a test token with no dollar peg or redemption promise. The
          reference valuation is fixed, not a live price oracle. CREDIT from
          another market is a different asset.
        </p>
      </details>
    ) : null;
  }
  function renderSettlementFacts() {
    return settlement ? (
      <details className="disclosure">
        <summary>Settlement details</summary>
        <dl className="definitions">
          <Definition label="Release stage">
            <span data-testid="settlement-stage">
              {settlementLabel(settlement.stage)}
            </span>
          </Definition>
          <Definition label="Account nonce">
            {state?.ethereum?.vaultNonce ?? "—"}
          </Definition>
          <Definition label="Lender payout cap">
            {eth(settlement.lender_cap_wei)} ETH
          </Definition>
          <Definition label="Paid to lender">
            {eth(settlement.lender_paid_wei)} ETH
          </Definition>
          <Definition label="Borrower surplus">
            {eth(settlement.borrower_surplus_wei)} ETH
          </Definition>
          <Definition label="Fees paid">
            {ethFee(settlement.fees_paid_wei)} ETH
          </Definition>
          <Definition label="Remaining fee reserve">
            {eth(settlement.remaining_fee_budget_wei)} ETH
          </Definition>
          <Definition label="Shortfall">
            {credit(settlement.shortfall_credit_units)} CREDIT
          </Definition>
          <Definition label="Terminal checkpoint">
            {settlement.checkpoint_block_number ?? "Not complete"}
          </Definition>
        </dl>
        {settlement.retired && (
          <p>
            This vault is retired. Later deposits are outside the completed
            loan.
          </p>
        )}
      </details>
    ) : null;
  }
  function renderHistoryFacts() {
    const history = loanHistory(state),
      funding = fundingHistory(state);
    return (
      <details className="disclosure">
        <summary>Position history</summary>
        <dl className="definitions">
          <Definition label="Collateral funding">
            {funding.done
              ? "Funded"
              : funding.skipped
                ? "Not funded · cancellation"
                : "Not recorded"}
          </Definition>
          <Definition label="Collateral verification">
            {market?.proof_timestamp
              ? "Authenticated"
              : history.cancelled
                ? "Not required · cancellation"
                : "Not recorded"}
          </Definition>
          <Definition label="Borrowing">
            {history.borrowed
              ? `Borrowed ${timeLabel(market?.borrowed_at)}`
              : history.cancelled
                ? "Not borrowed · cancelled"
                : "Not borrowed"}
          </Definition>
          <Definition label="Loan resolution">
            {market?.phase ?? "Not initialized"}
          </Definition>
        </dl>
      </details>
    );
  }
  function renderEvidence() {
    return (
      <>
        <p className="sheet-intro">
          Actual coordinator observations for {descriptor.name}. Inclusion,
          authentication and loan closure are separate outcomes.
        </p>
        <dl className="definitions">
          <Definition label="Controller">
            {config?.near.controllerId ?? "—"}
          </Definition>
          <Definition label="Borrower">
            {config?.near.borrowerId ?? "—"}
          </Definition>
          <Definition label="Lender">{config?.near.lenderId ?? "—"}</Definition>
          <Definition label="Vault">
            {market?.vault ?? "Not derived"}
          </Definition>
          <Definition label="Proof status">
            {state?.proofStatus ?? "No authenticated proof"}
          </Definition>
          <Definition label="Finalized Ethereum block">
            {state?.ethereum?.finalizedBlock ?? "—"}
          </Definition>
          <Definition label="Release">
            {settlementLabel(settlement?.stage)}
          </Definition>
        </dl>
        {renderSettlementFacts()}
        {renderHistoryFacts()}
        <button className="text-button" onClick={() => setPanel("recovery")}>
          Request recovery
        </button>
        <div className="receipt-list">
          {receipts.length === 0 ? (
            <p className="empty-copy">No receipts yet.</p>
          ) : (
            [...receipts].reverse().map((receipt) => (
              <article className={`receipt ${receipt.status}`} key={receipt.id}>
                <header>
                  <b>{receipt.action}</b>
                  <Badge
                    label={receipt.status}
                    tone={
                      receipt.status === "success"
                        ? "repaid"
                        : receipt.status === "rejected"
                          ? "danger"
                          : "warning"
                    }
                  />
                </header>
                <p>{receipt.detail}</p>
                <TransactionLink
                  config={config}
                  chain={receipt.chain}
                  hash={receipt.hash}
                />
                <p className="receipt-facts">
                  Block {receipt.blockNumber ?? "pending"}{" "}
                  {receipt.gasUsed && ` · Gas ${receipt.gasUsed}`}{" "}
                  {receipt.feeWei && ` · Fee ${ethFee(receipt.feeWei)} ETH`}
                </p>
              </article>
            ))
          )}
        </div>
        <details className="disclosure">
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
      </>
    );
  }
  const reviewName =
    reviewAction === "fund" && role === "lender"
      ? "Fund CREDIT offer"
      : actionNames[reviewAction];
  const title =
    panel === "position"
      ? descriptor.name
      : panel === "wallets"
        ? "Wallets"
        : panel === "networks"
          ? "Networks"
          : panel === "review"
            ? reviewName
            : panel === "transaction"
              ? reportStatus
              : panel === "evidence"
                ? "Evidence & receipts"
                : panel === "recovery"
                  ? "Request recovery"
                  : panel === "new"
                    ? "New position"
                    : "Balances by market";
  if (!active) return null;
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <div className="header-inner">
          <Brand />
          <nav aria-label="Main navigation">
            {(["dashboard", "lend", "activity"] as View[]).map((item) => (
              <button
                key={item}
                aria-current={view === item ? "page" : undefined}
                className={view === item ? "active" : ""}
                onClick={() => props.onView(item)}
              >
                {item === "dashboard"
                  ? "Dashboard"
                  : item === "lend"
                    ? "Lend"
                    : "Activity"}
              </button>
            ))}
          </nav>
          <div className="header-end">
            <button
              className="network-control"
              aria-label="Network details"
              onClick={() => setPanel("networks")}
            >
              <AssetIcon chain="ethereum" />
              <AssetIcon chain="near" />
              <span>
                {!config
                  ? "Connecting networks"
                  : local
                    ? "Local chains"
                    : "Test networks"}
              </span>
            </button>
            <button
              className="wallet-control"
              onClick={() => setPanel("wallets")}
              aria-label={
                local
                  ? `Wallets: local ${role} actor`
                  : wallets.nearAccount
                    ? `Wallets: ${wallets.nearAccount}; Ethereum ${wallets.evmAccount ? "connected" : "optional, not connected"}`
                    : "Connect wallet"
              }
            >
              <span className="wallet-avatar">
                {local
                  ? role[0].toUpperCase()
                  : wallets.nearAccount
                    ? wallets.nearAccount[0].toUpperCase()
                    : "↗"}
              </span>
              <span className="wallet-name">
                {local
                  ? `Local ${role}`
                  : wallets.nearAccount
                    ? short(wallets.nearAccount)
                    : "Connect wallet"}
              </span>
              <ChevronDown size={14} />
            </button>
          </div>
        </div>
      </header>
      <main className="app-main" id="main" tabIndex={-1}>
        <div className="page-title">
          <div>
            <h1>
              {view === "lend"
                ? "Lending"
                : view === "activity"
                  ? "Activity"
                  : "Dashboard"}
            </h1>
            <p>
              <AssetIcon chain="ethereum" />
              {!config
                ? "Ethereum · connecting"
                : local
                  ? "Local Ethereum"
                  : "Ethereum Sepolia"}
              <span aria-hidden="true">↔</span>
              <AssetIcon chain="near" />
              NEAR {!config ? "· connecting" : local ? "Sandbox" : "testnet"}
            </p>
          </div>
          {view === "dashboard" && (
            <button
              className="button primary"
              onClick={() => setPanel("new")}
              disabled={!!props.lock.current}
            >
              <Plus size={16} />
              New position
            </button>
          )}
        </div>
        {local && (
          <div className="environment-note">
            <FlaskConical size={15} />
            <span>Owned local chains · Development actors</span>
          </div>
        )}
        <FeedbackToast
          notice={notice?.id === dismissedNotice ? null : notice}
          onDismiss={() => setDismissedNotice(notice?.id ?? null)}
        />
        {!config && (
          <p className="inline-status" role="status">
            Loading current position
          </p>
        )}
        {state?.pendingReason &&
          (state.busy ||
            !state.ready ||
            !config?.ready ||
            !!state.settlement?.pending) &&
          !state.settlement?.retired &&
          state.market?.phase !== "Closed" && (
            <p className="notice warning" role="status">
              {state.pendingReason}
            </p>
          )}
        {config && !config.ready && (
          <section className="notice danger" role="alert">
            <b>Market is not ready</b>
            <ul>
              {config.readinessErrors.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        )}
        {error && (
          <div className="notice danger" role="alert">
            <p>{error}</p>
            <button
              className="text-button"
              onClick={() => void reconcile()}
              disabled={!!pending || refreshing}
            >
              Refresh state
            </button>
          </div>
        )}
        {(own.paused || foreignPause || networkPaused) && (
          <section className="notice warning" role="status">
            <Clock3 size={20} />
            <div>
              <b>
                {foreignPause
                  ? `${foreignPause.descriptor.name} needs checking`
                  : networkPaused
                    ? "Current state is unavailable"
                    : "Outcome needs checking"}
              </b>
              <p>
                Review the original request before another financial action.
              </p>
            </div>
            <button
              className="button secondary"
              onClick={() =>
                foreignPause
                  ? props.onSelect(foreignPause.descriptor.id, "recovery")
                  : setPanel("recovery")
              }
            >
              Check request
            </button>
          </section>
        )}
        {continued && (
          <p className="notice warning" role="status">
            You continued from checked state. A late original request may still
            complete. Check Activity before submitting another request.
          </p>
        )}
        {props.lock.current && props.lock.current !== descriptor.id && (
          <div className="notice warning" role="status">
            Another position has a wallet request in progress. Your request
            remains attached to its original position.
          </div>
        )}
        {!showPersonal ? (
          <section className="panel empty">
            <div className="empty-symbol">
              <AssetIcon chain="near" />
            </div>
            <h2>Connect your loan account</h2>
            <p>View your collateral, debt and available CREDIT.</p>
            <button
              className="button primary"
              onClick={() => setPanel("wallets")}
            >
              Connect wallet
            </button>
          </section>
        ) : (
          <>
            {view !== "activity" && (
              <dl className="portfolio-stats">
                <div className="portfolio-stat">
                  <dt>{view === "lend" ? "Committed" : "Collateral"}</dt>
                  <dd data-testid="vault-balance">
                    {view === "lend" ? (
                      assetTotal(totals.committed)
                    ) : totals.collateralWei === null ? (
                      "—"
                    ) : (
                      <>
                        {eth(totals.collateralWei.toString())}{" "}
                        <small>ETH</small>
                      </>
                    )}
                  </dd>
                </div>
                <div className="portfolio-stat">
                  <dt>{view === "lend" ? "Claimable" : "Total debt"}</dt>
                  <dd data-testid="loan-debt">
                    {assetTotal(
                      view === "lend" ? totals.claimable : totals.debts,
                    )}
                  </dd>
                </div>
                <div className="portfolio-stat">
                  <dt>
                    {view === "lend" ? "Wallet balance" : "Available to borrow"}
                  </dt>
                  <dd
                    data-testid={view === "lend" ? "credit-balance" : undefined}
                  >
                    {view === "lend" ? (
                      <>
                        {credit(
                          role === "lender" && ownsRole
                            ? market?.lender_balance_units
                            : undefined,
                        )}{" "}
                        <small>CREDIT</small>
                      </>
                    ) : totals.availableOffers === null ? (
                      "—"
                    ) : visibleRecords.length === 1 && market ? (
                      <>
                        {totals.availableOffers
                          ? credit(market.terms.principal_units)
                          : "0"}{" "}
                        <small>CREDIT</small>
                      </>
                    ) : (
                      <>
                        {totals.availableOffers}{" "}
                        <small>
                          {totals.availableOffers === 1 ? "offer" : "offers"}
                        </small>
                      </>
                    )}
                  </dd>
                </div>
              </dl>
            )}
            {view === "activity" ? (
              <section>
                <div className="activity-market">
                  <label>
                    Position
                    <select
                      aria-label="Activity position"
                      value={descriptor.id}
                      onChange={(event) =>
                        props.onSelect(event.target.value, null)
                      }
                    >
                      {props.records.map((record) => (
                        <option
                          key={record.descriptor.id}
                          value={record.descriptor.id}
                        >
                          {record.descriptor.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <ActivityTable
                  config={config}
                  receipts={receipts}
                  onOpenEvidence={openEvidence}
                />
              </section>
            ) : (
              <section className="panel positions-panel">
                <div className="panel-heading">
                  <h2>
                    {view === "lend" ? "Your lending" : "Your positions"}
                    <span className="count">{rowRecords.length}</span>
                    <button
                      className="info-button"
                      aria-label="About isolated positions"
                      onClick={() => setPanel("balances")}
                    >
                      <Info size={16} />
                    </button>
                  </h2>
                  <select
                    className="filter"
                    aria-label="Filter positions"
                    value={filter}
                    onChange={(event) =>
                      setFilter(event.target.value as typeof filter)
                    }
                  >
                    <option value="open">Open positions</option>
                    <option value="all">All positions</option>
                    <option value="closed">Closed positions</option>
                  </select>
                </div>
                {rowRecords.length === 0 ? (
                  <div className="empty">
                    <h2>
                      {filter === "closed"
                        ? "No closed positions"
                        : "No positions for this account"}
                    </h2>
                    <p>
                      {filter === "closed"
                        ? "Settled vaults remain available in your history."
                        : "Connect the participant account for an available market."}
                    </p>
                    <button
                      className="button secondary"
                      onClick={() => setPanel("wallets")}
                    >
                      Manage wallets
                    </button>
                  </div>
                ) : (
                  <table
                    className="positions-table"
                    aria-label={
                      view === "lend" ? "Lending positions" : "Your positions"
                    }
                  >
                    <thead>
                      <tr>
                        <th scope="col">Position</th>
                        <th scope="col">Collateral</th>
                        <th scope="col">
                          {view === "lend" ? "Claimable" : "Debt"}
                        </th>
                        <th scope="col">Status</th>
                        <th scope="col">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rowRecords.map((record) => {
                        const s = record.snapshot?.state,
                          m = s?.market,
                          st = positionStatus(record, desiredRole),
                          a = positionAction(record, desiredRole);
                        return (
                          <tr
                            key={record.descriptor.id}
                            data-market={record.descriptor.id}
                          >
                            <td>
                              <button
                                className="name-button"
                                onClick={() =>
                                  props.onSelect(
                                    record.descriptor.id,
                                    "position",
                                  )
                                }
                              >
                                <span className="position-name">
                                  <AssetIcon chain="ethereum" />
                                  <span>
                                    <b>{record.descriptor.name}</b>
                                    <small>
                                      {record.descriptor.networkId === "sandbox"
                                        ? "Local Ethereum"
                                        : "Sepolia"}{" "}
                                      · #{record.descriptor.id}
                                    </small>
                                  </span>
                                </span>
                              </button>
                            </td>
                            <td>
                              <span className="cell-label">Collateral</span>
                              {record.unavailable
                                ? "—"
                                : eth(s?.ethereum?.vaultBalanceWei)}{" "}
                              <small>ETH</small>
                            </td>
                            <td>
                              <span className="cell-label">
                                {view === "lend" ? "Claimable" : "Debt"}
                              </span>
                              {view === "lend"
                                ? credit(claimable(record).toString())
                                : credit(
                                    m?.phase === "DefaultLocked"
                                      ? m.terms.debt_units
                                      : m?.debt_units,
                                  )}{" "}
                              <small>CREDIT</small>
                            </td>
                            <td>
                              <Badge {...st} />
                              {m?.phase === "Active" && (
                                <span className="cell-sub">
                                  Due {timeLabel(m.maturity)}
                                </span>
                              )}
                            </td>
                            <td>
                              <button
                                className="button secondary row-action"
                                disabled={a.disabled || !!props.lock.current}
                                onClick={() =>
                                  props.onSelect(
                                    record.descriptor.id,
                                    a.panel ?? "review",
                                    a.action,
                                  )
                                }
                              >
                                {a.label}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </section>
            )}
          </>
        )}
        <footer className="app-footer">
          <span>Test assets only. CREDIT has no redemption promise.</span>
          <div>
            <button
              className="text-button"
              onClick={() => setPanel("networks")}
            >
              Market details
            </button>
            <ThemeToggle />
          </div>
        </footer>
      </main>
      <Dialog
        open={panel !== null}
        focusKey={panel ?? undefined}
        onClose={() => {
          setChoosingNear(false);
          walletIntent.current = null;
          setPanel(null);
        }}
        title={title}
        eyebrow={
          panel === "wallets" ? "ACCOUNTS" : descriptor.name.toUpperCase()
        }
      >
        {panel === "position" && (
          <>
            <p className="sheet-intro">
              <Badge {...status} />
            </p>
            <div className="sheet-balance">
              <span>
                {desiredRole === "lender"
                  ? "Claimable CREDIT"
                  : market?.phase === "DefaultLocked"
                    ? "Debt at default"
                    : "Outstanding debt"}
              </span>
              <div>
                {credit(
                  desiredRole === "lender"
                    ? claimable(own).toString()
                    : market?.phase === "DefaultLocked"
                      ? market.terms.debt_units
                      : market?.debt_units,
                )}{" "}
                <small>CREDIT</small>
              </div>
            </div>
            <dl className="definitions">
              <Definition label="ETH collateral">
                {eth(state?.ethereum?.vaultBalanceWei)} ETH
              </Definition>
              <Definition label="Wallet balance">
                <span data-testid="credit-balance">
                  {credit(
                    ownsRole
                      ? role === "borrower"
                        ? market?.borrower_balance_units
                        : market?.lender_balance_units
                      : undefined,
                  )}{" "}
                  CREDIT
                </span>
              </Definition>
              <Definition
                label={
                  market?.phase === "Active" ? "Repay before" : "Loan term"
                }
              >
                {market?.phase === "Active"
                  ? timeLabel(market.maturity)
                  : durationLabel(
                      market?.terms.term_seconds ?? config?.termSeconds,
                    )}
              </Definition>
              <Definition label="Position status">
                {market?.phase ?? "Not initialized"}
              </Definition>
              {market?.phase === "Active" &&
                market.maturity &&
                state?.nearTimeSeconds && (
                  <Definition label="Time remaining">
                    {BigInt(market.maturity) > BigInt(state.nearTimeSeconds)
                      ? `${BigInt(market.maturity) - BigInt(state.nearTimeSeconds)}s remaining`
                      : "Repayment deadline passed"}
                  </Definition>
                )}
              {settlement && (
                <Definition label="Collateral release">
                  {settlementLabel(settlement.stage)}
                </Definition>
              )}
            </dl>
            {market?.phase === "Active" &&
              market.maturity &&
              state?.nearTimeSeconds &&
              BigInt(state.nearTimeSeconds) >= BigInt(market.maturity) && (
                <p className="warning-box">
                  The repayment deadline has passed. CREDIT repayment is
                  unavailable; the lender can start capped default settlement.
                </p>
              )}
            {next.action ? (
              <div className="sheet-actions">
                {renderActionButton({ action: next.action })}
              </div>
            ) : next.panel === "recovery" ? (
              <button
                className="button primary"
                onClick={() => setPanel("recovery")}
              >
                Check request
              </button>
            ) : null}
            {renderTerms()}
            {renderSettlementFacts()}
            {renderHistoryFacts()}
            {desiredRole === "lender" &&
              market?.phase === "Offered" &&
              BigInt(market.available_liquidity_units) > 0n && (
                <button
                  className="button secondary"
                  disabled={!!guard("claim")}
                  title={guard("claim") ?? undefined}
                  onClick={() => askAction("claim")}
                >
                  Withdraw unused CREDIT
                </button>
              )}
            <details className="disclosure">
              <summary>Vault & verification</summary>
              <dl className="definitions">
                <Definition label="Vault">
                  {market?.vault ?? "Not derived"}
                </Definition>
                <Definition label="Proof">
                  {state?.proofStatus ?? "Not authenticated"}
                </Definition>
                {!settlement && (
                  <Definition label="Account nonce">
                    {state?.ethereum?.vaultNonce ?? "—"}
                  </Definition>
                )}
                <Definition label="NEAR chain time">
                  {timeLabel(state?.nearTimeSeconds)}
                </Definition>
                <Definition label="Vault status">
                  {settlement?.retired
                    ? "Retired · do not deposit"
                    : "Dedicated Rino-controlled vault"}
                </Definition>
              </dl>
              <p>
                Collateral is isolated to this position. External vault balances
                cannot be imported.
              </p>
              <button className="text-button" onClick={openEvidence}>
                Open evidence <ArrowUpRight size={14} />
              </button>
              <button
                className="text-button"
                onClick={() => setPanel("recovery")}
              >
                Request recovery
              </button>
            </details>
            {market?.phase === "Offered" && role === "borrower" && (
              <div className="sheet-actions">
                {renderActionButton({ action: "cancel", secondary: true })}
              </div>
            )}
            {local && (
              <details className="disclosure">
                <summary>Development controls</summary>
                <div className="sheet-actions">
                  {renderActionButton({
                    action: "advance-maturity",
                    secondary: true,
                  })}
                  {renderActionButton({
                    action: "challenge-forgery",
                    secondary: true,
                  })}
                  {renderActionButton({
                    action: "challenge-duplicate",
                    secondary: true,
                  })}
                </div>
              </details>
            )}
          </>
        )}
        {panel === "wallets" && (
          <>
            <p className="sheet-intro">
              Your loan account and collateral wallet, in one place.
            </p>
            {walletIntent.current && (
              <p className="wallet-context">
                Continue {actionNames[walletIntent.current].toLowerCase()} for{" "}
                <b>{descriptor.name}</b>.
              </p>
            )}
            {local ? (
              <section className="wallet-card">
                <h3>Development actor</h3>
                <p>
                  Owned local chains use dedicated test actors. No browser
                  wallet is required.
                </p>
                <div className="sheet-actions">
                  <button
                    className={`button ${role === "borrower" ? "primary" : "secondary"}`}
                    disabled={!!props.lock.current}
                    onClick={() => props.onRole("borrower")}
                  >
                    Borrower
                  </button>
                  <button
                    className={`button ${role === "lender" ? "primary" : "secondary"}`}
                    disabled={!!props.lock.current}
                    onClick={() => props.onRole("lender")}
                  >
                    Lender
                  </button>
                </div>
              </section>
            ) : (
              <div className="wallet-hub">
                <section className="wallet-card">
                  <div className="wallet-card-head">
                    <AssetIcon chain="near" />
                    <div>
                      <h3>Loan account</h3>
                      <p>NEAR testnet</p>
                    </div>
                    <Badge
                      label={
                        wallets.nearAccount ? "Connected" : "Required for loans"
                      }
                      tone={wallets.nearAccount ? "active" : "neutral"}
                    />
                  </div>
                  <p className="wallet-purpose">
                    Borrow, repay and manage CREDIT.
                  </p>
                  <p className="wallet-account">
                    {wallets.nearAccount || "Not connected"}
                  </p>
                  <div className="wallet-card-actions">
                    <button
                      className="button primary"
                      disabled={!config || !!props.lock.current}
                      onClick={() => setChoosingNear(true)}
                    >
                      {wallets.nearAccount ? "Choose account" : "Connect NEAR"}
                    </button>
                    {wallets.nearAccount && (
                      <button
                        className="button secondary"
                        disabled={!!props.lock.current}
                        onClick={() => void connect("disconnect-near")}
                      >
                        Disconnect NEAR
                      </button>
                    )}
                  </div>
                  {choosingNear && config && (
                    <NearWalletChoices
                      load={() => wallets.nearWalletOptions(config)}
                      onChoose={(id) => void connect("near", id)}
                    />
                  )}
                  <details className="disclosure">
                    <summary>Account required for this position</summary>
                    <p>
                      {role === "borrower"
                        ? config?.near.borrowerId
                        : config?.near.lenderId}
                    </p>
                    <p>
                      Changing views does not change your wallet signer.
                      Disconnect and select the required account when necessary.
                    </p>
                  </details>
                </section>
                <section className="wallet-card optional">
                  <div className="wallet-card-head">
                    <AssetIcon chain="ethereum" />
                    <div>
                      <h3>Collateral wallet</h3>
                      <p>Ethereum Sepolia</p>
                    </div>
                    <Badge
                      label={
                        !wallets.evmAccount
                          ? "Optional"
                          : wallets.evmChainId === 11155111
                            ? "Connected"
                            : "Wrong network"
                      }
                      tone={
                        wallets.evmAccount && wallets.evmChainId !== 11155111
                          ? "warning"
                          : "neutral"
                      }
                    />
                  </div>
                  <p className="wallet-purpose">
                    Only needed when you add ETH collateral.
                  </p>
                  <p className="wallet-account">
                    {wallets.evmAccount || "Connect when you make a deposit."}
                  </p>
                  <button
                    className="button secondary"
                    disabled={!!props.lock.current}
                    onClick={() =>
                      void connect(
                        wallets.evmAccount && wallets.evmChainId !== 11155111
                          ? "switch"
                          : "ethereum",
                      )
                    }
                  >
                    {wallets.evmAccount && wallets.evmChainId !== 11155111
                      ? "Switch to Sepolia"
                      : wallets.evmAccount
                        ? "Choose Ethereum account"
                        : "Connect Ethereum"}
                  </button>
                  {wallets.evmAccount && (
                    <button
                      className="button secondary"
                      disabled={!!props.lock.current}
                      onClick={() => void connect("disconnect-ethereum")}
                    >
                      Disconnect Ethereum
                    </button>
                  )}
                  <p className="wallet-purpose">
                    Disconnecting ends this app session. Manage wallet
                    permissions in your wallet.
                  </p>
                </section>
              </div>
            )}
            {pending === "wallet" && (
              <p className="inline-status" role="status">
                <RefreshCw className="spin" size={16} />
                Waiting for your wallet…
              </p>
            )}
          </>
        )}
        {panel === "networks" && (
          <>
            <p className="sheet-intro">
              Collateral on Ethereum. CREDIT on NEAR.
            </p>
            <dl className="definitions">
              <Definition label="Ethereum">
                {config?.ethereum.name ?? "Connecting"}
              </Definition>
              <Definition label="Chain ID">
                {config?.ethereum.chainId ?? "—"}
              </Definition>
              <Definition label="NEAR network">
                {config?.near.networkId ?? "—"}
              </Definition>
              <Definition label="CREDIT contract">
                {config?.near.controllerId ?? "—"}
              </Definition>
              <Definition label="Configured term">
                {durationLabel(config?.termSeconds)}
              </Definition>
            </dl>
            <details className="disclosure">
              <summary>Trust & environment</summary>
              <p>
                {local
                  ? "Local actors hold development keys; mock MPC/executor and synthetic RPC services are trusted."
                  : "Connected participants authorize financial actions. Configured RPC, MPC, executor services and developer full-access keys remain trusted."}
              </p>
              <ul>
                {config?.authority.map((value) => (
                  <li key={value}>{value}</li>
                ))}
              </ul>
              <p>
                Public TEE and financial execution require their own evidence.
                This interface is not hardware attestation.
              </p>
            </details>
            {renderTerms()}
          </>
        )}
        {panel === "new" && (
          <>
            <p className="sheet-intro">
              A separate Rino-controlled ETH vault for an available market.
            </p>
            {newRecords.length ? (
              <div className="new-market-list">
                {newRecords.map((record) => (
                  <button
                    className="market-option"
                    key={record.descriptor.id}
                    onClick={() =>
                      props.onSelect(
                        record.descriptor.id,
                        "review",
                        "initialize",
                      )
                    }
                  >
                    <AssetIcon chain="ethereum" />
                    <span>
                      <b>{record.descriptor.name}</b>
                      <small>New dedicated vault</small>
                    </span>
                    <ArrowRight size={18} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty in-sheet">
                <h3>No new positions available</h3>
                <p>
                  All available markets already have a vault. You can manage
                  your existing positions.
                </p>
              </div>
            )}
            <p className="sheet-note">
              A retired vault cannot be reused. Each market has its own CREDIT
              asset and loan.
            </p>
          </>
        )}
        {panel === "balances" && (
          <>
            <p className="sheet-intro">
              Each position has its own vault and CREDIT contract. Collateral is
              not shared between loans.
            </p>
            {(view === "lend"
              ? [
                  { label: "Committed", values: totals.committed },
                  { label: "Claimable", values: totals.claimable },
                ]
              : [{ label: "Outstanding debt", values: totals.debts }]
            ).map((group) => (
              <section key={group.label}>
                <h3>{group.label}</h3>
                {group.values.map((value) => (
                  <dl className="definitions" key={value.assetId}>
                    <Definition label={value.name}>
                      {credit(value.units.toString())} CREDIT
                    </Definition>
                    <Definition label="Asset identity">
                      {value.assetId}
                    </Definition>
                  </dl>
                ))}
                {!group.values.length && <p>0 CREDIT</p>}
              </section>
            ))}
            {view !== "lend" && !totals.debts.length && (
              <p>No outstanding CREDIT debt in the current portfolio.</p>
            )}
            <p className="sheet-note">
              Different CREDIT contracts are different assets. Their units are
              never added into one balance. Available borrowing is a count of
              eligible fixed offers across markets.
            </p>
          </>
        )}
        {panel === "review" && (
          <>
            <p className="sheet-intro">
              {descriptor.name} · {config?.near.controllerId}
            </p>
            <dl className="definitions">
              <Definition label="Action">{reviewName}</Definition>
              <Definition label="Signing account">
                {local
                  ? `Local ${role} actor`
                  : reviewAction === "fund" && role === "borrower"
                    ? wallets.evmAccount || "Ethereum wallet required"
                    : wallets.nearAccount || "NEAR account required"}
              </Definition>
              <Definition label="Network">
                {reviewAction === "fund" && role === "borrower" && !local
                  ? "Ethereum Sepolia"
                  : local
                    ? "Owned local chains"
                    : "NEAR testnet"}
              </Definition>
              {reviewAction === "initialize" ? (
                <Definition label="Collateral">
                  Empty dedicated vault
                </Definition>
              ) : reviewAction === "fund" && role === "borrower" ? (
                <>
                  <Definition label="ETH deposit">
                    {exactEth(fundingShortfall)} ETH
                  </Definition>
                  <Definition label="To vault">{market?.vault}</Definition>
                  <Definition label="Network gas">
                    Additional wallet ETH required
                  </Definition>
                </>
              ) : reviewAction === "fund" ? (
                <>
                  <Definition label="Lender escrow">
                    {credit(funding.escrowUnits.toString())} CREDIT
                  </Definition>
                  <Definition label="Borrower fee endowment">
                    {credit(funding.feeUnits.toString())} CREDIT
                  </Definition>
                  {local && (
                    <Definition label="Local ETH target">0.12 ETH</Definition>
                  )}
                </>
              ) : reviewAction === "repay" ? (
                <>
                  <Definition label="Full repayment">
                    {credit(market?.debt_units)} CREDIT
                  </Definition>
                  <Definition label="Repay before">
                    {timeLabel(market?.maturity)}
                  </Definition>
                </>
              ) : reviewAction === "borrow" ? (
                <>
                  <Definition label="You receive">
                    {credit(market?.terms.principal_units)} CREDIT
                  </Definition>
                  <Definition label="Total to repay">
                    {credit(market?.terms.debt_units)} CREDIT
                  </Definition>
                  <Definition label="Term after confirmation">
                    {durationLabel(market?.terms.term_seconds)}
                  </Definition>
                </>
              ) : reviewAction === "claim" ? (
                <Definition label="Claim">
                  {credit(claimable(own).toString())} CREDIT
                </Definition>
              ) : reviewAction === "settle" ? (
                <>
                  <Definition label="Release branch">
                    {settlement?.branch ?? market?.phase}
                  </Definition>
                  <Definition label="ETH held">
                    {exactEth(state?.ethereum?.vaultBalanceWei)} ETH
                  </Definition>
                  <Definition label="Fees paid from vault">
                    Exact fixed intent is checked before signing
                  </Definition>
                </>
              ) : null}
            </dl>
            <p className="sheet-note">
              {reviewAction === "repay"
                ? "Repayment clears the CREDIT debt. ETH remains in its vault until separately released."
                : reviewAction === "settle"
                  ? "Ethereum completion must be authenticated on NEAR before the vault is retired. Do not deposit during settlement."
                  : reviewAction === "initialize"
                    ? "This initializes an unused configured market. Adding ETH and funding CREDIT remain separate actions."
                    : reviewAction === "fund" && role === "lender"
                      ? "Funding may require separate fee-endowment and escrow transactions. An earlier confirmed transfer remains real if a later request fails."
                      : reviewAction === "fund"
                        ? "Only the exact current shortfall is funded. Approval alone does not confirm a deposit."
                        : "You will approve the current request. Balances change only after verified execution."}
            </p>
            {guard(reviewAction) && (
              <p className="warning-box">{guard(reviewAction)}</p>
            )}
            <div className="sheet-actions">
              {needsWallet(reviewAction) ? (
                <button
                  className="button primary"
                  onClick={() => {
                    walletIntent.current = reviewAction;
                    setPanel("wallets");
                  }}
                >
                  Connect required wallet
                </button>
              ) : (
                <button
                  className="button primary"
                  disabled={!!guard(reviewAction)}
                  onClick={() => {
                    setPanel("transaction");
                    void run(reviewAction);
                  }}
                >
                  Confirm action <ArrowRight size={16} />
                </button>
              )}
            </div>
            {renderTerms()}
          </>
        )}
        {panel === "transaction" && (
          <>
            <div
              className={`tx-symbol ${error || own.paused ? "warning" : ""}`}
            >
              {pending ? (
                <RefreshCw className="spin" size={28} />
              ) : error || own.paused ? (
                <Info size={28} />
              ) : (
                <Check size={28} />
              )}
            </div>
            <p className="sheet-intro" role="status">
              {error ||
                message ||
                (pending
                  ? "The original request remains attached to this position. Wallet approval and submission are not confirmed completion."
                  : "Current position state is shown below.")}
            </p>
            <dl className="definitions">
              <Definition label="Position">{descriptor.name}</Definition>
              <Definition label="Status">
                {positionStatus(own, role).label}
              </Definition>
              <Definition label="Loan phase">
                {market?.phase ?? "Not initialized"}
              </Definition>
              <Definition label="ETH release">
                {settlement ? (
                  <span data-testid="settlement-stage">
                    {settlementLabel(settlement.stage)}
                  </span>
                ) : (
                  "Not started"
                )}
              </Definition>
            </dl>
            <div className="sheet-actions">
              <button
                className="button primary"
                onClick={() => setPanel(own.paused ? "recovery" : "position")}
              >
                {own.paused ? "Check original request" : "View position"}
              </button>
              <button
                className="button secondary"
                onClick={() => setPanel(null)}
              >
                Back to dashboard
              </button>
            </div>
          </>
        )}
        {panel === "evidence" && renderEvidence()}
        {panel === "recovery" && (
          <>
            <p className="sheet-intro">
              Inspect the original request. Checking evidence never resubmits it
              or declares success.
            </p>
            <div className="sheet-actions">
              <button
                className="button secondary"
                disabled={!!pending || refreshing}
                onClick={() => void reconcile()}
              >
                {refreshing ? "Refreshing…" : "Refresh chain state"}
              </button>
              {uncertain && !continued && (
                <button
                  className="button secondary"
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
            <details className="disclosure">
              <summary>Settlement controls</summary>
              <p>{settlementLabel(settlement?.stage)}</p>
              <div className="sheet-actions">
                {renderActionButton({ action: "recover", secondary: true })}
                {role === "lender" &&
                  renderActionButton({ action: "claim", secondary: true })}
              </div>
            </details>
            <button className="text-button" onClick={openEvidence}>
              Open evidence <ArrowUpRight size={14} />
            </button>
          </>
        )}
      </Dialog>
    </>
  );
}

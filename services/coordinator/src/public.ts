/** Public testnet adapter. This module never constructs a signer; RPC credentials load only in public construction. */
import { JsonRpcProvider } from "near-api-js";
import { ReadCache } from "./read-cache.ts";
import { createPublicNearProvider } from "./public-near-provider.ts";
import { OperationJournal, type ExpectedStep } from "./operations.ts";
import { PublicOperations } from "./public-operations.ts";
import { ReceiptVerifier } from "./receipt-verifier.ts";
import type { OperationRequest } from "./operations-api.ts";
import type { OperationPreparation } from "./public-operations.ts";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { ROOT } from "./processes.ts";
import { Journal, SerialQueue, verifyRelay } from "./safety.ts";
import {
  publicArtifactHashes,
  type PublicArtifactHashes,
} from "./public-artifacts.ts";
import { collateralShortfall, collateralSufficient } from "./collateral.ts";
import { parseAlchemyEndpoint } from "../../../tooling/outlayer-secrets.mjs";
import type {
  ActionRequest,
  ActionResult,
  Config,
  Market,
  Settlement,
  SignedTransaction,
  State,
  Terms,
  WalletAction,
} from "./api.ts";
// Only this public, credential-free fallback may be supplied to browser connectors.
export const TESTNET_RPC_URL = "https://near-testnet.drpc.org";
function nearEndpoint(): string {
  const configured = process.env.NEAR_TESTNET_RPC_URL;
  if (configured === undefined) return TESTNET_RPC_URL;
  try {
    const url = new URL(configured);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.port ||
      configured.trim() !== configured
    )
      throw Error();
    return url.href;
  } catch {
    throw Error("Invalid NEAR testnet RPC endpoint");
  }
}
interface DeploymentFields {
  controllerId: string;
  borrowerId: string;
  lenderId: string;
  borrowerRecipient: string;
  lenderRecipient: string;
  operationDeposit: string;
  controllerCodeHash: string;
  collateralUrl: string;
  settlementUrl: string;
}
type Deployment = DeploymentFields &
  ({ version: 2 } | { version: 3; artifacts: PublicArtifactHashes });
async function ethereum(
  url: string,
  method: string,
  params: unknown[],
): Promise<any> {
  if (
    ![
      "eth_chainId",
      "eth_getBlockByNumber",
      "eth_getProof",
      "eth_getBalance",
      "eth_getTransactionCount",
      "eth_getTransactionReceipt",
      "eth_getTransactionByHash",
      "eth_sendRawTransaction",
    ].includes(method)
  )
    throw Error("public RPC method denied");
  try {
    const r = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!r.ok) throw Error(`public provider HTTP ${r.status}`);
    const reader = r.body!.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 262144) {
        await reader.cancel();
        throw Error("public RPC response bound");
      }
      parts.push(next.value);
    }
    const body = Buffer.concat(parts).toString();
    const v = JSON.parse(body);
    if (v.error || v.result === undefined)
      throw Error("public provider rejected required proof/receipt query");
    return v.result;
  } catch {
    throw Error("public provider unavailable or response rejected");
  }
}
export class PublicCoordinator {
  readonly queue = new SerialQueue(4);
  readonly #provider: JsonRpcProvider;
  readonly operations: PublicOperations;
  readonly #artifactHashes: PublicArtifactHashes;
  get provider(): JsonRpcProvider {
    return this.#provider;
  }
  get artifactHashes(): PublicArtifactHashes {
    return this.#artifactHashes;
  }
  private readonly readinessCache = new ReadCache(
    15000,
    () => this.readReadiness(),
    { failed: (value) => value.length > 0 },
  );
  private readonly stateCache = new ReadCache(5000, (options) =>
    this.readState(options.fresh !== false),
  );
  private invalidateReads(): void {
    this.readinessCache.invalidate();
    this.stateCache.invalidate();
  }
  private waiting: string = "";
  readonly #urls: readonly [string, string];
  private constructor(
    readonly deployment: Deployment,
    readonly journal: Journal,
    readonly directory: string,
    alchemyUrl: string,
    nearUrl: string,
    operations: OperationJournal,
    artifacts: PublicArtifactHashes,
  ) {
    this.#artifactHashes = artifacts;
    this.#provider = createPublicNearProvider(nearUrl);
    this.#urls = ["https://ethereum-sepolia-rpc.publicnode.com/", alchemyUrl];
    this.operations = new PublicOperations({
      journal: operations,
      verifier: new ReceiptVerifier({
        near: this.#provider,
        ethereum: (index, method, params) =>
          ethereum(this.#urls[index], method, params),
      }),
      binding: deployment,
      replacement: (expected, original, candidate) =>
        this.replacementNonce(expected, original, candidate),
      prepare: (request, beforeRelay) =>
        this.prepareOperation(request, beforeRelay),
      readiness: () => this.readiness({ fresh: false }),
      state: () => this.state({ fresh: true }),
    });
  }
  static async fromFile(
    path: string | undefined,
  ): Promise<PublicCoordinator | undefined> {
    if (!path) return undefined;
    const d = JSON.parse(await readFile(path, "utf8")) as Deployment;
    if (
      !d ||
      typeof d !== "object" ||
      Array.isArray(d) ||
      Object.keys(d).sort().join(",") !==
        `${d.version === 3 ? "artifacts," : ""}borrowerId,borrowerRecipient,collateralUrl,controllerCodeHash,controllerId,lenderId,lenderRecipient,operationDeposit,settlementUrl,version` ||
      (d.version !== 2 && d.version !== 3)
    )
      throw Error(
        "public deployment manifest schema rejected; use a complete version 2 or version 3 manifest binding borrowerRecipient, lenderRecipient and operationDeposit to the reviewed initialization payload; version 3 also requires artifact hashes",
      );
    if (
      typeof d.operationDeposit !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(d.operationDeposit) ||
      d.operationDeposit.length > 23 ||
      BigInt(d.operationDeposit) > 50000000000000000000000n
    )
      throw Error(
        "canonical operation deposit within constructor cap required",
      );
    if (
      [d.borrowerRecipient, d.lenderRecipient].some(
        (address) =>
          typeof address !== "string" ||
          !/^0x[0-9a-fA-F]{40}$/.test(address) ||
          /^0x0{40}$/.test(address),
      ) ||
      d.borrowerRecipient.toLowerCase() === d.lenderRecipient.toLowerCase()
    )
      throw Error("valid distinct Sepolia recipients required");
    for (const id of [d.controllerId, d.borrowerId, d.lenderId])
      if (!/^[a-z0-9._-]+\.testnet$/.test(id))
        throw Error("testnet account required");
    if (new Set([d.controllerId, d.borrowerId, d.lenderId]).size !== 3)
      throw Error("distinct public participants required");
    for (const value of [d.collateralUrl, d.settlementUrl]) {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        url.port
      )
        throw Error("reviewed HTTPS module required");
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(d.controllerCodeHash))
      throw Error("public controller code hash required");
    const artifacts = publicArtifactHashes(
      d.version,
      d.version === 3 ? d.artifacts : undefined,
      d.controllerCodeHash,
    );
    const { url: alchemyUrl } = parseAlchemyEndpoint(
      process.env.ALCHEMY_SEPOLIA_RPC_URL,
    );
    const nearUrl = nearEndpoint();
    const directory = resolve(
      ROOT,
      ".cache/public-coordinator",
      createHash("sha256").update(JSON.stringify(d)).digest("hex"),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new PublicCoordinator(
      d,
      await Journal.open(resolve(directory, "journal.json")),
      directory,
      alchemyUrl,
      nearUrl,
      await OperationJournal.open(resolve(directory, "operations.json"), {
        controllerId: d.controllerId,
      }),
      artifacts,
    );
  }
  async view<T = any>(method: string): Promise<T> {
    try {
      return (await this.provider.callFunction({
        contractId: this.deployment.controllerId,
        method,
        args: {},
        blockQuery: { finality: "final" },
      })) as T;
    } catch {
      throw Error("NEAR provider unavailable or response rejected");
    }
  }
  readiness(options: { fresh?: boolean } = {}): Promise<string[]> {
    return this.readinessCache.read(options);
  }
  private async readReadiness(): Promise<string[]> {
    try {
      const [status, account, config, market, chains] = await Promise.all([
        this.provider.viewNodeStatus(),
        this.provider.viewAccount({ accountId: this.deployment.controllerId }),
        this.view("get_config"),
        this.view<Market>("get_market"),
        Promise.all(this.#urls.map((u) => ethereum(u, "eth_chainId", []))),
      ]);
      const errors: string[] = [];
      if (status.chain_id !== "testnet" || chains.some((x) => x !== "0xaa36a7"))
        errors.push("Wrong public network");
      if (account.code_hash !== this.deployment.controllerCodeHash)
        errors.push(
          "Public controller code hash does not match reviewed manifest",
        );
      if (
        config.borrower !== this.deployment.borrowerId ||
        config.executor !== "outlayer.testnet" ||
        config.mpc !== "v1.signer-prod.testnet" ||
        config.wasm_url !== this.deployment.collateralUrl ||
        config.wasm_sha256 !== this.artifactHashes.collateral ||
        config.network !== "NearTestnet" ||
        config.operation_deposit !== this.deployment.operationDeposit ||
        market?.lender !== this.deployment.lenderId ||
        market?.borrower_recipient?.toLowerCase() !==
          this.deployment.borrowerRecipient.toLowerCase() ||
        market?.lender_recipient?.toLowerCase() !==
          this.deployment.lenderRecipient.toLowerCase() ||
        market?.terms.term_seconds !== "86400" ||
        market?.settlement_wasm_url !== this.deployment.settlementUrl ||
        market?.settlement_wasm_sha256 !== this.artifactHashes.settlement
      )
        errors.push("Public deployment immutable configuration mismatch");
      return errors;
    } catch {
      return [
        "Public deployment or fixed RPC providers unavailable; no local fixture fallback",
      ];
    }
  }
  state(options: { fresh?: boolean } = {}): Promise<State> {
    return this.stateCache.read(options);
  }
  private async readState(fresh: boolean): Promise<State> {
    try {
      return await this.readStateChecked(fresh);
    } catch {
      throw Error(
        "Public deployment or fixed RPC providers unavailable; no local fixture fallback",
      );
    }
  }
  private async readStateChecked(fresh: boolean): Promise<State> {
    const errors = await this.readiness({ fresh });
    if (errors.length) throw Error(errors.join("; "));
    const [market, settlement, proofStatus, evidence, total, block] =
      await Promise.all([
        this.view<Market>("get_market"),
        this.view<Settlement>("get_settlement"),
        this.view<string>("get_status"),
        this.view<Record<string, unknown> | null>("get_evidence"),
        this.view<string>("ft_total_supply"),
        this.provider.viewBlock({ finality: "final" }),
      ]);
    let eth: State["ethereum"] = null;
    if (market.vault) {
      const values = await Promise.all([
        ethereum(this.#urls[0], "eth_getBalance", [market.vault, "latest"]),
        ethereum(this.#urls[0], "eth_getTransactionCount", [
          market.vault,
          "latest",
        ]),
        ethereum(this.#urls[0], "eth_getBalance", [
          market.borrower_recipient,
          "latest",
        ]),
        ethereum(this.#urls[0], "eth_getBalance", [
          market.lender_recipient,
          "latest",
        ]),
        ethereum(this.#urls[0], "eth_getBlockByNumber", ["finalized", false]),
      ]);
      eth = {
        vaultBalanceWei: BigInt(values[0]).toString(),
        vaultNonce: BigInt(values[1]).toString(),
        borrowerBalanceWei: BigInt(values[2]).toString(),
        lenderBalanceWei: BigInt(values[3]).toString(),
        finalizedBlock: BigInt(values[4].number).toString(),
      };
    }
    return {
      apiVersion: 1,
      ready: true,
      market,
      settlement,
      proofStatus,
      evidence,
      ethereum: eth,
      totalSupplyUnits: total,
      nearTimeSeconds: (
        BigInt(block.header.timestamp_nanosec) / 1000000000n
      ).toString(),
      busy: this.queue.busy,
      pendingReason: this.waiting || settlement.pending_reason,
    };
  }
  private wallet(
    methodName: string,
    args: Record<string, unknown> = {},
    deposit = "0",
  ): WalletAction {
    return {
      chain: "near",
      receiverId: this.deployment.controllerId,
      methodName,
      args,
      deposit,
      gas: "300000000000000",
    };
  }
  private async bundle(options: {
    vault: string;
    to?: string;
    cacheNonce: string;
    expectedNonce: string;
    purpose: "collateral" | "prepare" | "confirm";
    minimumBlock?: bigint;
    maximumCheckpointBaseFee?: bigint;
    collateral?: { terms: Terms; liveBalance: unknown };
  }): Promise<any> {
    const { vault, to, cacheNonce, expectedNonce, purpose, collateral } =
      options;
    const minimumBlock = options.minimumBlock ?? 0n;
    const maximumBaseFee =
      purpose === "prepare" ? options.maximumCheckpointBaseFee : undefined;
    if (purpose === "prepare" && maximumBaseFee === undefined)
      throw Error("preparation checkpoint fee bound required");
    const affordableFee = (value: unknown) =>
      maximumBaseFee === undefined ||
      (typeof value === "string" &&
        value.length <= 78 &&
        /^(0|[1-9][0-9]*)$/.test(value) &&
        BigInt(value) <= maximumBaseFee);
    const file = resolve(
      this.directory,
      `capture-${to ?? "collateral"}-${cacheNonce}.json`,
    );
    // Selection hints never enter the protocol bundle. Workers authenticate the
    // original witness and controller rules independently of these local hints.
    const quantity = (value: unknown): bigint => {
      if (
        typeof value !== "string" ||
        value.length > 66 ||
        !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)
      )
        throw Error("malformed public checkpoint quantity");
      return BigInt(value);
    };
    const header = (value: any) => {
      if (
        !value ||
        typeof value !== "object" ||
        !/^0x[0-9a-fA-F]{64}$/.test(value.hash) ||
        !/^0x[0-9a-fA-F]{64}$/.test(value.stateRoot)
      )
        throw Error("malformed public checkpoint header");
      quantity(value.number);
      quantity(value.timestamp);
      return value;
    };
    const readHeads = async (tag: "latest" | "finalized") =>
      (
        await Promise.all(
          this.#urls.map((u) =>
            ethereum(u, "eth_getBlockByNumber", [tag, false]),
          ),
        )
      ).map(header);
    const commonHeight = (heads: any[]) =>
      heads.map((b) => quantity(b.number)).reduce((a, b) => (a < b ? a : b));
    const readCanonical = async (number: bigint) => {
      const tag = `0x${number.toString(16)}`;
      const headers = (
        await Promise.all(
          this.#urls.map((u) =>
            ethereum(u, "eth_getBlockByNumber", [tag, false]),
          ),
        )
      ).map(header);
      if (
        headers.some((b) => quantity(b.number) !== number) ||
        headers[0].hash !== headers[1].hash ||
        headers[0].stateRoot !== headers[1].stateRoot ||
        headers[0].timestamp !== headers[1].timestamp
      )
        throw Error("public checkpoint quorum mismatch");
      if (
        maximumBaseFee !== undefined &&
        quantity(headers[0].baseFeePerGas) !==
          quantity(headers[1].baseFeePerGas)
      )
        throw Error("public checkpoint base fee quorum mismatch");
      return headers[0];
    };
    const fresh = (timestamp: bigint) => {
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (timestamp > now)
        throw Error("public checkpoint timestamp is in the future");
      return now - timestamp <= 3600n;
    };
    const proofBytes = (proof: any): string[] => {
      if (
        !Array.isArray(proof?.accountProof) ||
        !proof.accountProof.length ||
        proof.accountProof.some(
          (p: unknown) =>
            typeof p !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(p),
        )
      )
        throw Error("malformed public account proof");
      return proof.accountProof;
    };
    const fundedLive =
      collateral &&
      collateralSufficient(collateral.terms, collateral.liveBalance);
    const inadequate = (balance: unknown) =>
      collateral &&
      fundedLive &&
      !collateralSufficient(collateral.terms, balance);
    let captured: any;
    try {
      captured = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (captured && !fresh(BigInt(captured.bundle.block_timestamp)))
      captured = undefined;
    if (
      captured &&
      (captured.vault !== vault ||
        captured.purpose !== purpose ||
        captured.expectedNonce !== expectedNonce ||
        captured.observedNonce !== expectedNonce ||
        BigInt(captured.bundle.block_number) < minimumBlock ||
        !affordableFee(captured.checkpointBaseFeeWei) ||
        inadequate(captured.balanceWei))
    )
      captured = undefined;
    if (!captured) {
      let unsuitable =
        "checkpoint below required receipt inclusion or accepted checkpoint";
      const captureAt = async (number: bigint) => {
        if (number < minimumBlock) return undefined;
        const b = await readCanonical(number);
        if (!fresh(quantity(b.timestamp))) {
          unsuitable = "checkpoint is stale";
          return undefined;
        }
        const checkpointBaseFeeWei =
          maximumBaseFee === undefined
            ? undefined
            : quantity(b.baseFeePerGas).toString();
        if (!affordableFee(checkpointBaseFeeWei)) {
          unsuitable =
            "checkpoint base fee exceeds the current preparation quote";
          return undefined;
        }
        const tag = `0x${number.toString(16)}`;
        // Alchemy supplies only untrusted witness bytes; both fixed providers
        // retain canonical-header and finalized-coverage authority.
        const p = await ethereum(this.#urls[1], "eth_getProof", [
          vault,
          [],
          tag,
        ]);
        const vaultProof = proofBytes(p);
        const observedNonce = quantity(p.nonce).toString();
        const balanceWei = collateral
          ? quantity(p.balance).toString()
          : undefined;
        if (observedNonce !== expectedNonce) {
          unsuitable = `checkpoint vault nonce does not match expected nonce ${expectedNonce}`;
          return undefined;
        }
        if (inadequate(balanceWei)) {
          unsuitable = "checkpoint predates sufficient collateral funding";
          return undefined;
        }
        const base = {
          block_number: number.toString(),
          block_hash: b.hash,
          state_root: b.stateRoot,
          block_timestamp: quantity(b.timestamp).toString(),
        };
        const bundle = to
          ? {
              ...base,
              vault_account_proof: vaultProof,
              beneficiary_account_proof: proofBytes(
                await ethereum(this.#urls[1], "eth_getProof", [to, [], tag]),
              ),
            }
          : { ...base, account_proof: vaultProof };
        return {
          vault,
          purpose,
          expectedNonce,
          observedNonce,
          ...(maximumBaseFee === undefined ? {} : { checkpointBaseFeeWei }),
          bundle,
          ...(collateral ? { balanceWei } : {}),
        };
      };
      captured = await captureAt(commonHeight(await readHeads("finalized")));
      if (!captured)
        captured = await captureAt(commonHeight(await readHeads("latest")));
      if (!captured) {
        this.waiting = `Awaiting suitable public checkpoint: ${unsuitable}`;
        throw Error(this.waiting);
      }
      await writeFile(file, JSON.stringify(captured), { mode: 0o600 });
    }
    const number = BigInt(captured.bundle.block_number);
    const finals = await readHeads("finalized");
    if (finals.some((b) => quantity(b.number) < number)) {
      this.waiting = `Captured block ${number}; awaiting both fixed providers finalized coverage before wallet request`;
      throw Error(this.waiting);
    }
    // Recheck exact height, root and age immediately before wallet creation.
    const b = await readCanonical(number);
    if (
      b.hash !== captured.bundle.block_hash ||
      b.stateRoot !== captured.bundle.state_root ||
      quantity(b.timestamp).toString() !== captured.bundle.block_timestamp
    )
      throw Error("captured public checkpoint no longer canonical");
    if (
      maximumBaseFee !== undefined &&
      (quantity(b.baseFeePerGas).toString() !== captured.checkpointBaseFeeWei ||
        !affordableFee(quantity(b.baseFeePerGas).toString()))
    )
      throw Error(
        "captured public checkpoint base fee changed or exceeds preparation quote",
      );
    if (!fresh(quantity(b.timestamp)))
      throw Error("public checkpoint expired before wallet request");
    this.waiting = "";
    return captured.bundle;
  }
  private async replacementNonce(
    expected: Extract<ExpectedStep, { chain: "ethereum"; kind: "funding" }>,
    original: string,
    candidate: string,
  ): Promise<"same-nonce" | "mismatch" | "unavailable"> {
    try {
      const values = await Promise.all(
        this.#urls.map((url) =>
          Promise.all(
            [original, candidate].map((hash) =>
              ethereum(url, "eth_getTransactionByHash", [hash]),
            ),
          ),
        ),
      );
      const normalize = (tx: any) => {
        if (
          !tx ||
          typeof tx !== "object" ||
          Array.isArray(tx) ||
          typeof tx.hash !== "string" ||
          !/^0x[0-9a-f]{64}$/i.test(tx.hash) ||
          typeof tx.from !== "string" ||
          !/^0x[0-9a-f]{40}$/i.test(tx.from) ||
          typeof tx.chainId !== "string" ||
          !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(tx.chainId) ||
          typeof tx.nonce !== "string" ||
          !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(tx.nonce)
        )
          throw Error("unavailable");
        return {
          hash: tx.hash.toLowerCase(),
          from: tx.from.toLowerCase(),
          chain: BigInt(tx.chainId).toString(),
          nonce: BigInt(tx.nonce).toString(),
        };
      };
      const pairs = values.map((txs) => txs.map(normalize));
      if (JSON.stringify(pairs[0]) !== JSON.stringify(pairs[1]))
        return "unavailable";
      if (
        pairs[0].some(
          (tx, i) =>
            tx.hash !== (i === 0 ? original : candidate) ||
            tx.from !== expected.intent.from.toLowerCase() ||
            tx.chain !== "11155111",
        )
      )
        return "mismatch";
      return pairs[0][0].nonce === pairs[0][1].nonce
        ? "same-nonce"
        : "mismatch";
    } catch {
      return "unavailable";
    }
  }
  private async prepareOperation(
    request: OperationRequest,
    beforeRelay: (expected: ExpectedStep) => Promise<void>,
  ): Promise<OperationPreparation> {
    if (request.action === "fund" && request.role === "borrower") {
      return this.queue.run(async () => {
        this.invalidateReads();
        try {
          const state = await this.state({ fresh: true });
          if (!request.evmSender || !state.market?.vault || !state.ethereum)
            throw Error("selected funding sender and vault required");
          const value = collateralShortfall(
            state.market.terms,
            state.ethereum.vaultBalanceWei,
          );
          if (value <= 0n) throw Error("collateral funding already sufficient");
          const heads = await Promise.all(
            this.#urls.map((url) =>
              ethereum(url, "eth_getBlockByNumber", ["latest", false]),
            ),
          );
          const heights = heads.map((head) => {
            if (
              typeof head?.number !== "string" ||
              !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i.test(head.number)
            )
              throw Error("funding head unavailable");
            return BigInt(head.number);
          });
          const funding = {
            chainId: "11155111" as const,
            from: request.evmSender,
            to: state.market.vault,
            valueWei: value.toString(),
            data: "0x" as const,
          };
          return {
            funding,
            state,
            steps: [
              {
                chain: "ethereum",
                kind: "funding",
                intent: funding,
                minimumBlock: heights
                  .reduce((a, b) => (a > b ? a : b))
                  .toString(),
              },
            ],
          };
        } finally {
          this.invalidateReads();
        }
      });
    }
    const block = await this.provider.viewBlock({ finality: "optimistic" });
    const height = block.header.height;
    if (!Number.isSafeInteger(height) || height < 0)
      throw Error("NEAR preparation floor unavailable");
    const result = await this.action(
      { action: request.action, role: request.role },
      beforeRelay,
    );
    const walletActions = result.walletActions ?? [];
    return {
      walletActions,
      state: result.state,
      steps: walletActions.map((action) => ({
        chain: "near",
        action,
        signerId:
          request.role === "borrower"
            ? this.deployment.borrowerId
            : this.deployment.lenderId,
        minimumBlock: String(height),
      })),
    };
  }
  async action(
    request: ActionRequest,
    beforeRelay?: (expected: ExpectedStep) => Promise<void>,
  ): Promise<ActionResult> {
    return this.queue.run(async () => {
      this.invalidateReads();
      try {
        const state = await this.state(),
          m = state.market!,
          s = state.settlement!,
          { action, role } = request;
        const borrower = ["initialize", "prove", "borrow", "repay", "cancel"];
        if (borrower.includes(action) && role !== "borrower")
          throw Error("borrower wallet required");
        if (["fund", "default", "claim"].includes(action) && role !== "lender")
          throw Error("lender wallet required");
        let walletActions: WalletAction[] = [];
        switch (action) {
          case "initialize":
            walletActions = [this.wallet("initialize_vault")];
            break;
          case "fund":
            if (BigInt(m.borrower_balance_units) < 1000000n)
              walletActions.push(
                this.wallet(
                  "ft_transfer",
                  {
                    receiver_id: m.borrower,
                    amount: (
                      1000000n - BigInt(m.borrower_balance_units)
                    ).toString(),
                  },
                  "1",
                ),
              );
            if (m.available_liquidity_units === "0")
              walletActions.push(this.wallet("fund_liquidity", {}, "1"));
            break;
          case "prove":
            if (!m.vault) throw Error("derive vault first");
            walletActions = [
              this.wallet("request_proof", {
                bundle: await this.bundle({
                  vault: m.vault,
                  cacheNonce: "0",
                  expectedNonce: "0",
                  purpose: "collateral",
                  collateral: {
                    terms: m.terms,
                    liveBalance: state.ethereum?.vaultBalanceWei,
                  },
                }),
              }),
            ];
            break;
          case "borrow":
          case "repay":
            walletActions = [this.wallet(action, {}, "1")];
            break;
          case "default":
            walletActions = [this.wallet("declare_default")];
            break;
          case "claim":
            walletActions = [this.wallet("claim_credit", {}, "1")];
            break;
          case "cancel":
            walletActions = [this.wallet("cancel")];
            break;
          case "recover":
          case "settle": {
            if (s.retired) break;
            if (s.pending) {
              if (BigInt(state.nearTimeSeconds!) > BigInt(s.pending.expires_at))
                walletActions = [this.wallet("expire_pending")];
              else throw Error(s.pending_reason);
              break;
            }
            if (!s.current_intent) {
              if (!m.vault) throw Error("vault required");
              const to =
                s.branch === "default" &&
                BigInt(s.remaining_lender_cap_wei) > 0n
                  ? m.lender_recipient
                  : m.borrower_recipient;
              const latest = await Promise.all(
                this.#urls.map((u) =>
                  ethereum(u, "eth_getBlockByNumber", ["latest", false]),
                ),
              );
              const fee = latest
                .map((b) => BigInt(b.baseFeePerGas) * 2n)
                .reduce((a, b) => (a > b ? a : b));
              if (fee <= 0n || fee > BigInt(m.terms.fee_cap_wei_per_gas))
                throw Error("current fee exceeds immutable cap");
              walletActions = [
                this.wallet("prepare_settlement", {
                  bundle: await this.bundle({
                    vault: m.vault,
                    to,
                    cacheNonce: s.expected_nonce,
                    expectedNonce: s.expected_nonce,
                    purpose: "prepare",
                    maximumCheckpointBaseFee: fee,
                    minimumBlock: BigInt(s.checkpoint_block_number ?? "0"),
                  }),
                  gas_price: fee.toString(),
                }),
              ];
              break;
            }
            const candidates = await this.view<SignedTransaction[]>(
              "get_signed_transactions",
            );
            if (!candidates.length) {
              walletActions = [this.wallet("request_signature")];
              break;
            }
            const candidate = candidates[0];
            await verifyRelay(
              candidate.raw,
              candidate.hash,
              m.vault!,
              s.current_intent.transfer,
            );
            let receipt: any = null;
            for (const candidate of candidates) {
              const observed = await Promise.all(
                this.#urls.map((u) =>
                  ethereum(u, "eth_getTransactionReceipt", [candidate.hash]),
                ),
              );
              if (
                observed[0] &&
                observed[1] &&
                observed[0].blockHash === observed[1].blockHash
              ) {
                receipt = observed[0];
                break;
              }
            }
            if (!receipt) {
              if (beforeRelay)
                await beforeRelay({
                  chain: "ethereum",
                  kind: "relay",
                  intent: {
                    chainId: "11155111",
                    from: m.vault!,
                    to: s.current_intent.transfer.to,
                    valueWei: s.current_intent.transfer.value,
                    data: "0x",
                  },
                  nonce: s.current_intent.transfer.nonce,
                  candidateHash: candidate.hash,
                });
              await this.journal.relay(
                candidate.hash,
                candidate.raw,
                async (raw) =>
                  ethereum(this.#urls[0], "eth_sendRawTransaction", [raw]),
              );
              throw Error(
                "Authorized raw transaction relayed; await receipt and repeat settlement; no new nonce authorized",
              );
            }
            walletActions = [
              this.wallet("confirm_settlement", {
                candidate_hash: receipt.transactionHash,
                bundle: {
                  checkpoint: await this.bundle({
                    vault: m.vault!,
                    to: s.current_intent.transfer.to,
                    cacheNonce: s.current_intent.transfer.nonce,
                    expectedNonce: (
                      BigInt(s.current_intent.transfer.nonce) + 1n
                    ).toString(),
                    purpose: "confirm",
                    minimumBlock: [
                      BigInt(receipt.blockNumber),
                      BigInt(s.current_intent.minimum_block_number),
                    ].reduce((a, b) => (a > b ? a : b)),
                  }),
                  transaction_index: BigInt(
                    receipt.transactionIndex,
                  ).toString(),
                },
                signature_json: null,
              }),
            ];
            break;
          }
          default:
            throw Error(
              "local-only fault/challenge control unavailable in public mode",
            );
        }
        return {
          ok: true,
          message: walletActions.length
            ? "Review and sign the fixed controller action with the selected participant wallet"
            : "No wallet action required",
          state,
          receiptIds: [],
          walletActions,
        };
      } finally {
        this.invalidateReads();
      }
    });
  }
}

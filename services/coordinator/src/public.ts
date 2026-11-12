/** Public testnet adapter. This module never constructs a signer; RPC credentials load only in public construction. */
import { JsonRpcProvider } from "near-api-js";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { ROOT } from "./processes.ts";
import { Journal, SerialQueue, verifyRelay } from "./safety.ts";
import { PINS } from "./local.ts";
import { collateralSufficient } from "./collateral.ts";
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
export const TESTNET_RPC_URL = "https://test.rpc.fastnear.com";
interface Deployment {
  version: 2;
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
  readonly provider = new JsonRpcProvider({
    url: TESTNET_RPC_URL,
  });
  private waiting: string = "";
  readonly #urls: readonly [string, string];
  private constructor(
    readonly deployment: Deployment,
    readonly journal: Journal,
    readonly directory: string,
    alchemyUrl: string,
  ) {
    this.#urls = ["https://ethereum-sepolia-rpc.publicnode.com/", alchemyUrl];
  }
  static async fromFile(
    path: string | undefined,
  ): Promise<PublicCoordinator | undefined> {
    if (!path) return undefined;
    const d = JSON.parse(await readFile(path, "utf8")) as Deployment;
    if (
      Object.keys(d).sort().join(",") !==
        "borrowerId,borrowerRecipient,collateralUrl,controllerCodeHash,controllerId,lenderId,lenderRecipient,operationDeposit,settlementUrl,version" ||
      d.version !== 2
    )
      throw Error(
        "public deployment manifest schema rejected; create a complete version 2 manifest binding borrowerRecipient, lenderRecipient and operationDeposit to the reviewed initialization payload",
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
    const { url: alchemyUrl } = parseAlchemyEndpoint(
      process.env.ALCHEMY_SEPOLIA_RPC_URL,
    );
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
    );
  }
  async view<T = any>(method: string): Promise<T> {
    return (await this.provider.callFunction({
      contractId: this.deployment.controllerId,
      method,
      args: {},
      blockQuery: { finality: "final" },
    })) as T;
  }
  async readiness(): Promise<string[]> {
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
        config.wasm_sha256 !== PINS.collateral ||
        config.network !== "NearTestnet" ||
        config.operation_deposit !== this.deployment.operationDeposit ||
        market?.lender !== this.deployment.lenderId ||
        market?.borrower_recipient?.toLowerCase() !==
          this.deployment.borrowerRecipient.toLowerCase() ||
        market?.lender_recipient?.toLowerCase() !==
          this.deployment.lenderRecipient.toLowerCase() ||
        market?.terms.term_seconds !== "86400" ||
        market?.settlement_wasm_url !== this.deployment.settlementUrl ||
        market?.settlement_wasm_sha256 !== PINS.settlement
      )
        errors.push("Public deployment immutable configuration mismatch");
      return errors;
    } catch {
      return [
        "Public deployment or fixed RPC providers unavailable; no local fixture fallback",
      ];
    }
  }
  async state(): Promise<State> {
    const errors = await this.readiness();
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
  private async bundle(
    vault: string,
    to?: string,
    nonce = "0",
    minimumBlock = 0n,
    collateral?: { terms: Terms; liveBalance: unknown },
  ): Promise<any> {
    const file = resolve(
      this.directory,
      `capture-${to ?? "collateral"}-${nonce}.json`,
    );
    let captured: any;
    try {
      captured = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (
      !captured ||
      captured.vault !== vault ||
      // Provider balance is only a cache invalidation hint. The worker and
      // controller still authenticate the unchanged account proof itself.
      (collateral &&
        !collateralSufficient(collateral.terms, captured.balanceWei) &&
        collateralSufficient(collateral.terms, collateral.liveBalance)) ||
      BigInt(captured.bundle.block_number) < minimumBlock ||
      now - BigInt(captured.bundle.block_timestamp) > 3600n
    ) {
      const latest = await Promise.all(
        this.#urls.map((u) =>
          ethereum(u, "eth_getBlockByNumber", ["latest", false]),
        ),
      );
      const number = latest
        .map((x) => BigInt(x.number))
        .reduce((a, b) => (a < b ? a : b));
      if (number < minimumBlock) {
        this.waiting = `Awaiting both fixed providers latest heads at receipt inclusion ${minimumBlock}`;
        throw Error(this.waiting);
      }
      const tag = `0x${number.toString(16)}`;
      const headers = await Promise.all(
        this.#urls.map((u) =>
          ethereum(u, "eth_getBlockByNumber", [tag, false]),
        ),
      );
      if (
        headers.some((header) => BigInt(header.number) !== number) ||
        headers[0].hash !== headers[1].hash ||
        headers[0].stateRoot !== headers[1].stateRoot
      )
        throw Error("public checkpoint quorum mismatch");
      const b = headers[0],
        p = await ethereum(this.#urls[0], "eth_getProof", [vault, [], tag]);
      const base = {
        block_number: number.toString(),
        block_hash: b.hash,
        state_root: b.stateRoot,
        block_timestamp: BigInt(b.timestamp).toString(),
      };
      const bundle = to
        ? {
            ...base,
            vault_account_proof: p.accountProof,
            beneficiary_account_proof: (
              await ethereum(this.#urls[0], "eth_getProof", [to, [], tag])
            ).accountProof,
          }
        : { ...base, account_proof: p.accountProof };
      captured = {
        vault,
        bundle,
        ...(!to ? { balanceWei: BigInt(p.balance).toString() } : {}),
      };
      await writeFile(file, JSON.stringify(captured), { mode: 0o600 });
    }
    const finals = await Promise.all(
      this.#urls.map((u) =>
        ethereum(u, "eth_getBlockByNumber", ["finalized", false]),
      ),
    );
    if (
      finals.some(
        (b) => BigInt(b.number) < BigInt(captured.bundle.block_number),
      )
    ) {
      this.waiting = `Captured block ${captured.bundle.block_number}; awaiting both fixed providers finalized coverage before wallet request`;
      throw Error(this.waiting);
    }
    // Recheck canonical header immediately before asking the wallet to create the job.
    const tag = `0x${BigInt(captured.bundle.block_number).toString(16)}`;
    const headers = await Promise.all(
      this.#urls.map((u) => ethereum(u, "eth_getBlockByNumber", [tag, false])),
    );
    if (
      headers.some(
        (b) =>
          b.hash !== captured.bundle.block_hash ||
          b.stateRoot !== captured.bundle.state_root,
      )
    )
      throw Error("captured public checkpoint no longer canonical");
    this.waiting = "";
    return captured.bundle;
  }
  async action(request: ActionRequest): Promise<ActionResult> {
    return this.queue.run(async () => {
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
              bundle: await this.bundle(m.vault, undefined, "0", 0n, {
                terms: m.terms,
                liveBalance: state.ethereum?.vaultBalanceWei,
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
              s.branch === "default" && BigInt(s.remaining_lender_cap_wei) > 0n
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
                bundle: await this.bundle(m.vault, to, s.expected_nonce),
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
                checkpoint: await this.bundle(
                  m.vault!,
                  s.current_intent.transfer.to,
                  s.current_intent.transfer.nonce,
                  BigInt(receipt.blockNumber),
                ),
                transaction_index: BigInt(receipt.transactionIndex).toString(),
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
    });
  }
}

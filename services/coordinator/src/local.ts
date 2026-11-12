import { Account, JsonRpcProvider, KeyPairSigner, actions } from "near-api-js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { type Hex } from "viem";
import { sign, setSignEntropy } from "viem/accounts";
import {
  Children,
  ROOT,
  assertOwned,
  rpc,
  sleep,
  hashFile,
  type LocalManifest,
} from "./processes.ts";
import {
  Journal,
  SerialQueue,
  verifyRelay,
  findIncludedAlias,
} from "./safety.ts";
import type {
  Market,
  Settlement,
  State,
  ActionRequest,
  ActionResult,
  SignedTransaction,
  Receipt,
} from "./api.ts";
export const PINS = {
  collateral:
    "be818d821f076d5e1dbf3650b03811b7658c85b14fd5c2fa7abce4ac87184c69",
  settlement:
    "552ddd26f2a0caaaad9c4e06ec08e24b24ab2c54c57d5b5b1991b03277f639a8",
  controller:
    "6c801cb682063af2ffb6e174ca4391722f57ee01663b08199774245c383f3da6",
};
const MOCK_MODULE = resolve(
  ROOT,
  "target/financial-services/wasm32-unknown-unknown/release/proofcredit_financial_services.wasm",
);
const MOCK_PIN =
  "04bd27d161d523e1a4f1d1c352dd0167fbdc94a8e792b3fcb611532be0d1b602";
export const MODULES = {
  collateral: resolve(
    ROOT,
    "target/wasm32-wasip2/release/proofcredit-proof-worker.wasm",
  ),
  settlement: resolve(
    ROOT,
    "target/wasm32-wasip2/release/proofcredit-settlement-worker.wasm",
  ),
  controller: resolve(
    ROOT,
    "target/wasm32-unknown-unknown/release/proofcredit_controller.wasm",
  ),
};
function rejectionReason(value: any): string | null {
  const failed = [
    value.transaction_outcome,
    ...(value.receipts_outcome ?? []),
  ].find((r: any) => r?.outcome.status.Failure);
  if (failed) return JSON.stringify(failed.outcome.status.Failure);
  if (value.status?.Failure) return JSON.stringify(value.status.Failure);
  return value.status?.SuccessValue === "ZmFsc2U="
    ? "Controller callback rejected dependency evidence"
    : null;
}
export class LocalCoordinator {
  /** Explicit internal lab fault; never accepted from HTTP or public mode. */
  labHoldNextSignature = false;
  labLoseNextBroadcastResponse = false;
  readonly queue = new SerialQueue(4);
  readonly provider: JsonRpcProvider;
  readonly accounts: Record<string, Account> = {};
  private constructor(
    readonly manifest: LocalManifest,
    readonly journal: Journal,
    readonly children: Children,
  ) {
    this.provider = new JsonRpcProvider({ url: manifest.nearUrl });
    const signer = KeyPairSigner.fromSecretKey(
      manifest.signer as `ed25519:${string}`,
    );
    for (const id of ["borrower", "lender", "controller", "executor", "mpc"])
      this.accounts[id] = new Account(id, this.provider, signer);
  }
  static async open(
    manifest: LocalManifest,
    children = new Children(),
  ): Promise<LocalCoordinator> {
    await assertOwned(manifest);
    for (const kind of ["collateral", "settlement", "controller"] as const)
      if ((await hashFile(MODULES[kind])) !== PINS[kind])
        throw Error(`${kind} artifact hash mismatch`);
    if ((await hashFile(MOCK_MODULE)) !== MOCK_PIN)
      throw Error("local mock artifact hash mismatch");
    return new LocalCoordinator(
      manifest,
      await Journal.open(resolve(manifest.dir, "journal.json")),
      children,
    );
  }
  async provision(): Promise<void> {
    await writeFile(
      resolve(this.manifest.dir, "artifacts.json"),
      JSON.stringify(
        {
          controller: PINS.controller,
          collateral: PINS.collateral,
          settlement: PINS.settlement,
          mock: await hashFile(
            resolve(
              ROOT,
              "target/financial-services/wasm32-unknown-unknown/release/proofcredit_financial_services.wasm",
            ),
          ),
          host: await hashFile(
            resolve(
              ROOT,
              "target/worker-host-native/debug/proofcredit-worker-host",
            ),
          ),
          anvil: await hashFile(resolve(ROOT, ".tools/anvil/1.7.1/anvil")),
          sandbox: await hashFile(
            resolve(ROOT, ".tools/near-sandbox/2.14.0/near-sandbox"),
          ),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const services = await readFile(
      resolve(
        ROOT,
        "target/financial-services/wasm32-unknown-unknown/release/proofcredit_financial_services.wasm",
      ),
    );
    for (const id of ["executor", "mpc"]) {
      await this.transaction(
        id,
        id,
        [actions.deployContract(services)],
        "deploy-local-service",
      );
      await this.call(id, id, "new", {
        controller: "controller",
        operator: id,
        public_key: this.manifest.mpcPublicKey,
      });
    }
    await this.transaction(
      "controller",
      "controller",
      [actions.deployContract(await readFile(MODULES.controller))],
      "deploy-controller",
    );
    await this.call("controller", "controller", "new", {
      borrower: "borrower",
      executor: "executor",
      wasm_url: "https://local.invalid/collateral.wasm",
      wasm_sha256: PINS.collateral,
      operation_deposit: "50000000000000000000000",
      network: { Sandbox: { mpc: "mpc" } },
      loan_config: {
        lender: "lender",
        borrower_recipient: this.manifest.borrowerRecipient,
        lender_recipient: this.manifest.lenderRecipient,
        settlement_wasm_url: "https://local.invalid/settlement.wasm",
        settlement_wasm_sha256: PINS.settlement,
      },
    });
  }
  async view<T = any>(
    contractId: string,
    method: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    return (await this.provider.callFunction({
      contractId,
      method,
      args,
      blockQuery: { finality: "final" },
    })) as T;
  }
  async now(): Promise<bigint> {
    return (
      BigInt(
        (await rpc(this.manifest.nearUrl, "block", { finality: "final" }))
          .header.timestamp_nanosec,
      ) / 1_000_000_000n
    );
  }
  async transaction(
    caller: string,
    receiver: string,
    txActions: any[],
    label: string,
  ): Promise<any> {
    await assertOwned(this.manifest);
    const result = await this.accounts[caller].signAndSendTransaction({
      receiverId: receiver,
      actions: txActions,
      waitUntil: "FINAL",
      throwOnFailure: false,
    });
    const value = result as any;
    const outcomes = [
      value.transaction_outcome,
      ...(value.receipts_outcome ?? []),
    ];
    const failed = outcomes.find((r: any) => r.outcome.status.Failure);
    const boolFalse = value.status?.SuccessValue === "ZmFsc2U=";
    const id = randomUUID();
    await mkdir(resolve(this.manifest.dir, "receipts"), { recursive: true });
    await writeFile(
      resolve(this.manifest.dir, "receipts", `${id}.json`),
      JSON.stringify(value, null, 2),
      { mode: 0o600 },
    );
    const gas = outcomes.reduce(
      (sum: bigint, r: any) => sum + BigInt(r.outcome.gas_burnt),
      0n,
    );
    await this.journal.receipt({
      id,
      chain: "near",
      action: label,
      status: failed || boolFalse ? "rejected" : "success",
      hash: value.transaction?.hash ?? null,
      blockNumber: null,
      gasUsed: gas.toString(),
      feeWei: null,
      detail: failed
        ? JSON.stringify(failed.outcome.status.Failure)
        : boolFalse
          ? "Controller callback rejected dependency evidence"
          : "Final NEAR receipt",
    });
    return value;
  }
  async call(
    caller: string,
    contract: string,
    method: string,
    args: Record<string, unknown> = {},
    deposit = 0n,
    allowRejected = false,
  ): Promise<any> {
    const result = await this.transaction(
      caller,
      contract,
      [actions.functionCall(method, args, 300_000_000_000_000n, deposit)],
      method,
    );
    const reason = rejectionReason(result);
    if (!allowRejected && reason)
      throw Error(`NEAR ${method} rejected: ${reason}`);
    return result;
  }
  async bundle(beneficiary?: string): Promise<any> {
    const b = await rpc(this.manifest.anvilUrl, "eth_getBlockByNumber", [
      "latest",
      false,
    ]);
    // Capture recent state first, then establish this dev node's actual finalized coverage.
    for (let n = 0; n < 128; n++) {
      const final = await rpc(this.manifest.anvilUrl, "eth_getBlockByNumber", [
        "finalized",
        false,
      ]);
      if (BigInt(final.number) >= BigInt(b.number)) break;
      await rpc(this.manifest.anvilUrl, "evm_mine", []);
    }
    const final = await rpc(this.manifest.anvilUrl, "eth_getBlockByNumber", [
      "finalized",
      false,
    ]);
    if (BigInt(final.number) < BigInt(b.number))
      throw Error("local finalized coverage unavailable");
    while ((await this.now()) < BigInt(b.timestamp)) {
      await rpc(this.manifest.nearUrl, "sandbox_fast_forward", {
        delta_height: 20,
      });
      await sleep(250);
    }
    const proof = await rpc(this.manifest.anvilUrl, "eth_getProof", [
      this.manifest.vault,
      [],
      b.number,
    ]);
    const base = {
      block_number: BigInt(b.number).toString(),
      block_hash: b.hash,
      state_root: b.stateRoot,
      block_timestamp: BigInt(b.timestamp).toString(),
    };
    if (!beneficiary) return { ...base, account_proof: proof.accountProof };
    const recipient = await rpc(this.manifest.anvilUrl, "eth_getProof", [
      beneficiary,
      [],
      b.number,
    ]);
    return {
      ...base,
      vault_account_proof: proof.accountProof,
      beneficiary_account_proof: recipient.accountProof,
    };
  }
  private async runWorker(
    kind: "collateral" | "settlement",
    input: string,
  ): Promise<string> {
    await assertOwned(this.manifest);
    if ((await hashFile(MODULES[kind])) !== PINS[kind])
      throw Error("worker module changed");
    const id = randomUUID(),
      inputPath = resolve(this.manifest.dir, `${id}-input.json`),
      reportPath = resolve(this.manifest.dir, `${id}-host.json`);
    await writeFile(inputPath, input, { mode: 0o600 });
    const child = this.children.spawn(
      resolve(ROOT, "target/worker-host-native/debug/proofcredit-worker-host"),
      [
        "--module",
        MODULES[kind],
        "--input",
        inputPath,
        "--mode",
        "local-sandbox",
        "--rpc-url",
        this.manifest.anvilUrl,
        "--near-time",
        String(await this.now()),
        "--report",
        reportPath,
      ],
      process.env,
      false,
    );
    const output = await new Promise<string>((res, rej) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        rej(Error("worker watchdog"));
      }, 130000);
      child.stdout!.on("data", (b: Buffer) => {
        size += b.length;
        if (size > 16384) {
          child.kill("SIGKILL");
          rej(Error("worker output bound"));
        }
        chunks.push(b);
      });
      child.once("error", (e) => {
        clearTimeout(timeout);
        rej(e);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        code === 0
          ? res(Buffer.concat(chunks).toString())
          : rej(Error(`worker host exit ${code}`));
      });
    });
    await writeFile(resolve(this.manifest.dir, `${id}-stdout.json`), output, {
      mode: 0o600,
    });
    const status = JSON.parse(output).status;
    await this.journal.receipt({
      id,
      chain: "worker",
      action: `${kind}-worker`,
      status: status === "verified" ? "success" : "rejected",
      hash: null,
      blockNumber: null,
      gasUsed: null,
      feeWei: null,
      detail: `Actual WASI bytes via TLS; ${status}; local two routes share Anvil`,
    });
    return output;
  }
  private async serveJob(service: string, record: any): Promise<void> {
    const args = record.args;
    await writeFile(
      resolve(this.manifest.dir, `${service}-${record.index}-job.json`),
      JSON.stringify(record, null, 2),
      { mode: 0o600 },
    );
    if (record.predecessor !== "controller")
      throw Error("foreign mock request");
    let output: string;
    const packetKey = `${service}:${record.index}`;
    if (record.kind === "execution") {
      const source = args.source?.WasmUrl;
      const kind =
        source?.hash === PINS.collateral
          ? "collateral"
          : source?.hash === PINS.settlement
            ? "settlement"
            : null;
      if (
        !kind ||
        source.url !== `https://local.invalid/${kind}.wasm` ||
        source.build_target !== "wasm32-wasip2" ||
        args.resource_limits?.max_execution_seconds !== 60 ||
        args.resource_limits?.max_instructions !== 1000000000 ||
        args.resource_limits?.max_memory_mb !== 128 ||
        args.payer_account_id !== "controller" ||
        args.secrets_ref !== null ||
        args.params !== null ||
        args.response_format !== "Json" ||
        record.deposit !== "50000000000000000000000"
      )
        throw Error("executor immutable ABI mismatch");
      output = await this.runWorker(kind, args.input_data);
    } else if (record.kind === "signature") {
      const s = await this.view<Settlement>("controller", "get_settlement");
      const digest = s.current_intent?.signing_digest;
      if (
        record.deposit !== "1" ||
        args.request?.path !== "proofcredit:sepolia:v1:0" ||
        args.request.domain_id !== 0 ||
        !digest ||
        args.request.payload_v2?.Ecdsa !== digest.slice(2)
      )
        throw Error("MPC request differs from frozen on-chain intent");
      // Generated runtime mock key; never a generic signing API.
      if (this.journal.data.packets[packetKey])
        output = this.journal.data.packets[packetKey];
      else {
        if (Object.keys(this.journal.data.packets).length >= 128)
          throw Error("local packet journal bound");
        setSignEntropy(true);
        const sig = await sign({
          hash: digest as Hex,
          privateKey: this.manifest.mpcKey,
          to: "object",
        });
        output = JSON.stringify({
          scheme: "Secp256k1",
          big_r: { affine_point: `0${2 + sig.yParity!}${sig.r.slice(2)}` },
          s: { scalar: sig.s.slice(2) },
          recovery_id: sig.yParity,
        });
        this.journal.data.packets[packetKey] = output;
        await this.journal.save();
      }
    } else throw Error("unknown local service job");
    if (record.kind === "signature" && this.labHoldNextSignature) {
      this.labHoldNextSignature = false;
      return;
    }
    await this.call(service, service, "resume", {
      index: record.index,
      output,
      fail: false,
    });
  }
  async withBridge<T>(action: () => Promise<T>): Promise<T> {
    const baseline: Record<string, number> = {};
    for (const service of ["executor", "mpc"])
      baseline[service] = (
        await this.view<any[]>(service, "get_records")
      ).length;
    let settled = false;
    const result = action().finally(() => {
      settled = true;
    });
    result.catch(() => {});
    const deadline = Date.now() + 150000;
    while (!settled && Date.now() < deadline) {
      for (const service of ["executor", "mpc"]) {
        const records = await this.view<any[]>(service, "get_records");
        while (baseline[service] < records.length) {
          await this.serveJob(service, records[baseline[service]++]);
        }
      }
      if (!settled) await sleep(100);
    }
    if (!settled)
      throw Error(
        "financial operation deadline; on-chain pending remains locked",
      );
    return result;
  }
  async state(): Promise<State> {
    await assertOwned(this.manifest);
    const [market, settlement, proofStatus, evidence, total, now] =
      await Promise.all([
        this.view<Market>("controller", "get_market"),
        this.view<Settlement>("controller", "get_settlement"),
        this.view<string>("controller", "get_status"),
        this.view<Record<string, unknown> | null>("controller", "get_evidence"),
        this.view<string>("controller", "ft_total_supply"),
        this.now(),
      ]);
    const [balance, nonce, borrower, lender, block] = await Promise.all([
      rpc(this.manifest.anvilUrl, "eth_getBalance", [
        this.manifest.vault,
        "latest",
      ]),
      rpc(this.manifest.anvilUrl, "eth_getTransactionCount", [
        this.manifest.vault,
        "latest",
      ]),
      rpc(this.manifest.anvilUrl, "eth_getBalance", [
        this.manifest.borrowerRecipient,
        "latest",
      ]),
      rpc(this.manifest.anvilUrl, "eth_getBalance", [
        this.manifest.lenderRecipient,
        "latest",
      ]),
      rpc(this.manifest.anvilUrl, "eth_getBlockByNumber", ["finalized", false]),
    ]);
    return {
      apiVersion: 1,
      ready: true,
      market,
      settlement,
      proofStatus,
      evidence,
      totalSupplyUnits: total,
      nearTimeSeconds: now.toString(),
      busy: this.queue.busy,
      pendingReason: settlement?.pending_reason ?? market?.pending_reason ?? "",
      ethereum: {
        vaultBalanceWei: BigInt(balance).toString(),
        vaultNonce: BigInt(nonce).toString(),
        borrowerBalanceWei: BigInt(borrower).toString(),
        lenderBalanceWei: BigInt(lender).toString(),
        finalizedBlock: BigInt(block.number).toString(),
      },
    };
  }
  async fundEth(value = 120_000_000_000_000_000n): Promise<string> {
    await assertOwned(this.manifest);
    const s = await this.view<Settlement>("controller", "get_settlement");
    if (s.retired || s.pending || s.current_intent)
      throw Error("pending/retired vault funding denied");
    const hash = await rpc(this.manifest.anvilUrl, "eth_sendTransaction", [
      {
        from: this.manifest.funder,
        to: this.manifest.vault,
        value: `0x${value.toString(16)}`,
      },
    ]);
    await this.waitReceipt(hash, "fund");
    return hash;
  }
  async waitReceipt(hash: string, label: string): Promise<any> {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const r = await rpc(this.manifest.anvilUrl, "eth_getTransactionReceipt", [
        hash,
      ]);
      if (r) {
        const id = randomUUID();
        await writeFile(
          resolve(this.manifest.dir, `${id}-evm-receipt.json`),
          JSON.stringify(r, null, 2),
          { mode: 0o600 },
        );
        await this.journal.receipt({
          id,
          chain: "ethereum",
          action: label,
          status: r.status === "0x1" ? "success" : "rejected",
          hash,
          blockNumber: BigInt(r.blockNumber).toString(),
          gasUsed: BigInt(r.gasUsed).toString(),
          feeWei: (BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice)).toString(),
          detail:
            "Actual owned Anvil receipt; local finalized tags are development assumptions",
        });
        return r;
      }
      await sleep(100);
    }
    throw Error("Ethereum receipt missing; intent remains locked");
  }
  async settle(role = "borrower", loseResponse = false): Promise<void> {
    for (let leg = 0; leg < 8; leg++) {
      let s = await this.view<Settlement>("controller", "get_settlement");
      const market = await this.view<Market>("controller", "get_market");
      if (s.retired) return;
      if (s.pending) throw Error(s.pending_reason);
      if (!s.current_intent) {
        const to =
          s.branch === "default" && BigInt(s.remaining_lender_cap_wei) > 0n
            ? market.lender_recipient
            : market.borrower_recipient;
        const latest = await rpc(
          this.manifest.anvilUrl,
          "eth_getBlockByNumber",
          ["latest", false],
        );
        const f =
          BigInt(latest.baseFeePerGas) > 2_000_000_000n
            ? BigInt(latest.baseFeePerGas)
            : 2_000_000_000n;
        if (f > 100_000_000_000n) throw Error("live fee exceeds immutable cap");
        const bundle = await this.bundle(to);
        await this.withBridge(() =>
          this.call(role, "controller", "prepare_settlement", {
            bundle,
            gas_price: f.toString(),
          }),
        );
      }
      s = await this.view<Settlement>("controller", "get_settlement");
      if (s.retired) return;
      if (s.stage === "NeedsTopup") throw Error(s.pending_reason);
      if (s.candidate_count === 0)
        await this.withBridge(() =>
          this.call(role, "controller", "request_signature"),
        );
      s = await this.view<Settlement>("controller", "get_settlement");
      const candidates = await this.view<SignedTransaction[]>(
        "controller",
        "get_signed_transactions",
      );
      const candidate = candidates[0];
      if (!candidate || !s.current_intent)
        throw Error("no verified signed transaction");
      await verifyRelay(
        candidate.raw,
        candidate.hash,
        this.manifest.vault,
        s.current_intent.transfer,
      );
      const included = await findIncludedAlias(
        candidates,
        Object.values(this.journal.data.packets),
        s.current_intent.transfer,
        this.manifest.vault,
        (hash) =>
          rpc(this.manifest.anvilUrl, "eth_getTransactionReceipt", [hash]),
      );
      let receipt: any = included?.receipt ?? null;
      if (!receipt) {
        await this.journal.relay(candidate.hash, candidate.raw, async (raw) => {
          const h = await rpc(
            this.manifest.anvilUrl,
            "eth_sendRawTransaction",
            [raw],
          );
          if (loseResponse) {
            loseResponse = false;
            throw Error("controlled local lost broadcast response");
          }
          return h;
        });
        receipt = await this.waitReceipt(candidate.hash, "settlement-transfer");
      }
      const checkpoint = await this.bundle(s.current_intent.transfer.to);
      await this.withBridge(() =>
        this.call(role, "controller", "confirm_settlement", {
          candidate_hash: receipt.transactionHash,
          bundle: {
            checkpoint,
            transaction_index: BigInt(receipt.transactionIndex).toString(),
          },
          signature_json: included?.signatureJson ?? null,
        }),
      );
      if (this.journal.data.broadcasts[receipt.transactionHash]) {
        this.journal.data.broadcasts[receipt.transactionHash].status =
          "confirmed";
        await this.journal.save();
      }
    }
    throw Error("settlement leg bound reached");
  }
  async advanceTo(target: bigint): Promise<void> {
    await assertOwned(this.manifest);
    const deadline = Date.now() + 120000;
    const observations: Array<Record<string, string>> = [];
    let delta = 100;
    while ((await this.now()) < target) {
      if (Date.now() > deadline) throw Error("owned clock advance timeout");
      const before = await this.now();
      const height = Number(
        (await rpc(this.manifest.nearUrl, "status", [])).sync_info
          .latest_block_height,
      );
      await rpc(this.manifest.nearUrl, "sandbox_fast_forward", {
        delta_height: delta,
      });
      const waitUntil = Date.now() + 20000;
      while (
        Number(
          (await rpc(this.manifest.nearUrl, "status", [])).sync_info
            .latest_block_height,
        ) <
        height + delta
      ) {
        if (Date.now() > waitUntil)
          throw Error("Sandbox fast-forward height not reached");
        await sleep(100);
      }
      while (
        Number(
          (await rpc(this.manifest.nearUrl, "block", { finality: "final" }))
            .header.height,
        ) <
        height + delta
      ) {
        if (Date.now() > waitUntil)
          throw Error("Sandbox final clock checkpoint not reached");
        await sleep(100);
      }
      const after = await this.now();
      observations.push({
        before: before.toString(),
        after: after.toString(),
        blocks: String(delta),
      });
      await writeFile(
        resolve(this.manifest.dir, "clock-progress.json"),
        JSON.stringify({ target: target.toString(), observations }),
        { mode: 0o600 },
      );
      const elapsed = after - before;
      // Derive the next step from this owned chain's observed clock movement.
      if (elapsed > 0n && after < target)
        delta = Math.min(
          2000,
          Number(((target - after) * BigInt(delta) + elapsed - 1n) / elapsed) +
            10,
        );
    }
    await writeFile(
      resolve(this.manifest.dir, `clock-${randomUUID()}.json`),
      JSON.stringify({ target: target.toString(), observations }),
      { mode: 0o600 },
    );
    const now = await this.now(),
      latest = await rpc(this.manifest.anvilUrl, "eth_getBlockByNumber", [
        "latest",
        false,
      ]);
    if (now > BigInt(latest.timestamp)) {
      await rpc(this.manifest.anvilUrl, "evm_setNextBlockTimestamp", [
        Number(now),
      ]);
      await rpc(this.manifest.anvilUrl, "evm_mine", []);
    }
  }
  async action(request: ActionRequest): Promise<ActionResult> {
    return this.queue.run(async () => {
      const start = this.journal.data.receipts.length;
      const { action, role } = request;
      const expected: Partial<Record<ActionRequest["action"], string>> = {
        initialize: "borrower",
        fund: "lender",
        prove: "borrower",
        borrow: "borrower",
        repay: "borrower",
        default: "lender",
        cancel: "borrower",
        claim: "lender",
        "challenge-forgery": "borrower",
        "challenge-duplicate": "borrower",
        "advance-maturity": "lender",
      };
      if (expected[action] && expected[action] !== role)
        throw Error(`action requires ${expected[action]} role`);
      switch (action) {
        case "initialize":
          await this.call(role, "controller", "initialize_vault");
          break;
        case "fund": {
          const market = await this.view<Market>("controller", "get_market");
          if (market.phase !== "Offered" || !market.vault)
            throw Error("derive offered vault first");
          if (market.borrower_balance_units === "0")
            await this.call(
              "lender",
              "controller",
              "ft_transfer",
              { receiver_id: "borrower", amount: "1000000" },
              1n,
            );
          if (market.available_liquidity_units === "0")
            await this.call("lender", "controller", "fund_liquidity", {}, 1n);
          if (
            BigInt(
              await rpc(this.manifest.anvilUrl, "eth_getBalance", [
                this.manifest.vault,
                "latest",
              ]),
            ) === 0n
          )
            await this.fundEth();
          break;
        }
        case "prove": {
          const bundle = await this.bundle();
          await this.withBridge(() =>
            this.call(role, "controller", "request_proof", { bundle }),
          );
          break;
        }
        case "borrow":
        case "repay":
          await this.call(role, "controller", action, {}, 1n);
          break;
        case "claim":
          await this.call(role, "controller", "claim_credit", {}, 1n);
          break;
        case "default":
          await this.call(role, "controller", "declare_default");
          break;
        case "cancel":
          await this.call(role, "controller", "cancel");
          break;
        case "settle": {
          const lose = this.labLoseNextBroadcastResponse;
          this.labLoseNextBroadcastResponse = false;
          await this.settle(role, lose);
          break;
        }
        case "recover": {
          const s = await this.view<Settlement>("controller", "get_settlement");
          if (s.pending) {
            if ((await this.now()) <= BigInt(s.pending.expires_at))
              throw Error(s.pending_reason);
            await this.call(role, "controller", "expire_pending");
          }
          await this.settle(role);
          break;
        }
        case "advance-maturity": {
          const market = await this.view<Market>("controller", "get_market");
          if (!market.maturity || market.phase !== "Active")
            throw Error("active maturity required");
          await this.advanceTo(BigInt(market.maturity));
          break;
        }
        case "challenge-forgery": {
          const before = await this.view<Market>("controller", "get_market");
          const bundle = await this.bundle();
          bundle.account_proof[0] =
            bundle.account_proof[0].slice(0, -2) +
            (bundle.account_proof[0].endsWith("00") ? "01" : "00");
          const challenged = await this.withBridge(() =>
            this.call(
              "borrower",
              "controller",
              "request_proof",
              { bundle },
              0n,
              true,
            ),
          );
          if (!rejectionReason(challenged))
            throw Error("forged proof unexpectedly accepted");
          const after = await this.view<Market>("controller", "get_market");
          for (const k of [
            "borrower_balance_units",
            "lender_balance_units",
            "escrow_balance_units",
            "debt_units",
          ] as const)
            if (before[k] !== after[k])
              throw Error("forged proof changed balances");
          break;
        }
        case "challenge-duplicate": {
          const before = await this.view<Market>("controller", "get_market");
          if (before.phase !== "Active") throw Error("borrow first");
          const challenged = await this.call(
            "borrower",
            "controller",
            "borrow",
            {},
            1n,
            true,
          );
          if (!rejectionReason(challenged))
            throw Error("duplicate borrow unexpectedly accepted");
          const after = await this.view<Market>("controller", "get_market");
          if (
            after.borrower_balance_units !== before.borrower_balance_units ||
            after.debt_units !== before.debt_units
          )
            throw Error("duplicate moved principal");
          break;
        }
      }
      return {
        ok: true,
        message: action.startsWith("challenge-")
          ? "Actual contract rejected challenge; balances unchanged"
          : `Confirmed ${action}`,
        state: await this.state(),
        receiptIds: this.journal.data.receipts.slice(start).map((r) => r.id),
      };
    });
  }
}

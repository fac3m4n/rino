import { open, readFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  keccak256,
  parseTransaction,
  serializeTransaction,
  recoverTransactionAddress,
  type Hex,
} from "viem";
import type { ActionRequest, Receipt, TransferIntent } from "./api.ts";
export function loopbackUrl(value: string): URL {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    !u.port ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw Error("owned numeric loopback root URL required");
  return u;
}
export async function verifyRelay(
  raw: string,
  hash: string,
  vault: string,
  intent: TransferIntent,
): Promise<string> {
  if (!/^0x[0-9a-f]+$/.test(raw) || keccak256(raw as Hex) !== hash)
    throw Error("raw hash mismatch");
  const tx = parseTransaction(raw as Hex);
  if (
    tx.type !== "eip1559" ||
    tx.chainId !== 11155111 ||
    intent.chain_id !== "11155111" ||
    BigInt(tx.nonce ?? -1) !== BigInt(intent.nonce) ||
    tx.to?.toLowerCase() !== intent.to ||
    tx.value !== BigInt(intent.value) ||
    tx.gas !== 21000n ||
    intent.gas_limit !== "21000" ||
    tx.maxFeePerGas !== BigInt(intent.gas_price) ||
    tx.maxPriorityFeePerGas !== BigInt(intent.gas_price) ||
    (tx.data && tx.data !== "0x") ||
    (tx.accessList?.length ?? 0) !== 0
  )
    throw Error("signed payload differs from fixed intent");
  if (
    (
      await recoverTransactionAddress({
        serializedTransaction: raw as `0x02${string}`,
      })
    ).toLowerCase() !== vault.toLowerCase()
  )
    throw Error("wrong vault sender");
  return hash;
}
export interface JournalData {
  version: 1;
  broadcasts: Record<
    string,
    {
      raw: string;
      status: "prepared" | "uncertain" | "broadcast" | "confirmed";
    }
  >;
  receipts: Receipt[];
  packets: Record<string, string>;
}
export class Journal {
  private saves: Promise<void> = Promise.resolve();
  private constructor(
    readonly path: string,
    public data: JournalData,
  ) {}
  static async open(path: string): Promise<Journal> {
    let data: JournalData = {
      version: 1,
      broadcasts: {},
      receipts: [],
      packets: {},
    };
    try {
      data = JSON.parse(await readFile(path, "utf8"));
      if (
        data.version !== 1 ||
        !data.broadcasts ||
        !Array.isArray(data.receipts) ||
        !data.packets ||
        data.receipts.length > 512 ||
        Object.keys(data.broadcasts).length > 64 ||
        Object.keys(data.packets).length > 128
      )
        throw Error("invalid journal");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return new Journal(path, data);
  }
  async save(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    const saving = this.saves.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${process.pid}.tmp`;
      const fd = await open(temp, "w", 0o600);
      try {
        await fd.writeFile(snapshot);
        await fd.sync();
      } finally {
        await fd.close();
      }
      await rename(temp, this.path);
      const dir = await open(dirname(this.path), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    });
    this.saves = saving.catch(() => {});
    return saving;
  }
  async relay(
    hash: string,
    raw: string,
    send: (raw: string) => Promise<string>,
  ): Promise<string> {
    const existing = this.data.broadcasts[hash];
    if (existing && existing.raw !== raw) throw Error("journal raw conflict");
    if (Object.keys(this.data.broadcasts).length >= 64 && !existing)
      throw Error("journal broadcast bound");
    this.data.broadcasts[hash] ??= { raw, status: "prepared" };
    await this.save();
    try {
      const result = await send(raw);
      if (result !== hash) throw Error("broadcast response hash mismatch");
      this.data.broadcasts[hash].status = "broadcast";
      await this.save();
      return result;
    } catch (e) {
      this.data.broadcasts[hash].status = "uncertain";
      await this.save();
      throw e;
    }
  }
  async receipt(r: Receipt): Promise<void> {
    if (this.data.receipts.length >= 512) throw Error("receipt journal bound");
    this.data.receipts.push(r);
    await this.save();
  }
}
const ACTIONS = [
  "initialize",
  "fund",
  "prove",
  "borrow",
  "repay",
  "default",
  "cancel",
  "settle",
  "claim",
  "challenge-forgery",
  "challenge-duplicate",
  "advance-maturity",
  "recover",
];
export function parseAction(body: unknown): ActionRequest {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw Error("invalid action object");
  const b = body as Record<string, unknown>;
  if (
    Object.keys(b).sort().join(",") !== "action,role" ||
    typeof b.action !== "string" ||
    !ACTIONS.includes(b.action) ||
    (b.role !== "borrower" && b.role !== "lender")
  )
    throw Error("action/role/argument not allowed");
  return b as unknown as ActionRequest;
}
export function guardTransport(i: {
  host: string;
  origin: string;
  contentType: string;
  csrf: string;
  expectedOrigin: string;
  expectedCsrf: string;
  body: unknown;
}): void {
  const expected = new URL(i.expectedOrigin);
  if (
    i.host !== expected.host ||
    i.origin !== expected.origin ||
    i.contentType.split(";")[0].trim() !== "application/json"
  )
    throw Error("origin/host/content type denied");
  const a = Buffer.from(i.csrf),
    b = Buffer.from(i.expectedCsrf);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw Error("CSRF denied");
}
export function guardRequest(i: Parameters<typeof guardTransport>[0]): void {
  guardTransport(i);
  parseAction(i.body);
}
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private count = 0;
  constructor(readonly limit = 4) {}
  get busy() {
    return this.count > 0;
  }
  async run<T>(f: () => Promise<T>): Promise<T> {
    if (this.count >= this.limit) throw Error("operation queue full");
    this.count++;
    const result = this.tail.then(f);
    this.tail = result.catch(() => {});
    try {
      return await result;
    } finally {
      this.count--;
    }
  }
}
export async function findIncludedAlias(
  stored: Array<{ raw: string; hash: string }>,
  packets: string[],
  intent: TransferIntent,
  vault: string,
  query: (hash: string) => Promise<any>,
): Promise<{
  hash: string;
  signatureJson: string | null;
  receipt: any;
} | null> {
  if (stored.length > 4 || packets.length > 128)
    throw Error("alias reconciliation bound");
  const seen = new Set<string>();
  for (const candidate of stored) {
    await verifyRelay(candidate.raw, candidate.hash, vault, intent);
    seen.add(candidate.hash);
    const receipt = await query(candidate.hash);
    if (receipt) {
      if (receipt.transactionHash !== candidate.hash)
        throw Error("receipt alias hash mismatch");
      return { hash: candidate.hash, signatureJson: null, receipt };
    }
  }
  if (BigInt(intent.nonce) > BigInt(Number.MAX_SAFE_INTEGER))
    throw Error("unsupported client nonce range");
  for (const packet of packets) {
    let raw: Hex, hash: Hex;
    try {
      const p = JSON.parse(packet);
      if (
        packet.length > 1024 ||
        p.scheme !== "Secp256k1" ||
        !/^0[23][0-9a-f]{64}$/.test(p.big_r?.affine_point) ||
        !/^[0-9a-f]{64}$/.test(p.s?.scalar) ||
        ![0, 1].includes(p.recovery_id)
      )
        continue;
      raw = serializeTransaction(
        {
          type: "eip1559",
          chainId: 11155111,
          nonce: Number(intent.nonce),
          to: intent.to as Hex,
          value: BigInt(intent.value),
          gas: BigInt(intent.gas_limit),
          maxFeePerGas: BigInt(intent.gas_price),
          maxPriorityFeePerGas: BigInt(intent.gas_price),
          data: "0x",
          accessList: [],
        },
        {
          r: `0x${p.big_r.affine_point.slice(2)}`,
          s: `0x${p.s.scalar}`,
          yParity: p.recovery_id,
        },
      );
      hash = keccak256(raw);
      // Other completed intents may remain in the bounded crash journal.
      await verifyRelay(raw, hash, vault, intent);
    } catch {
      continue;
    }
    if (seen.has(hash)) continue;
    seen.add(hash);
    const receipt = await query(hash);
    if (receipt) {
      if (receipt.transactionHash !== hash)
        throw Error("receipt alias hash mismatch");
      return { hash, signatureJson: packet, receipt };
    }
  }
  return null;
}

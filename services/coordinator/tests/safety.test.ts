import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256 } from "viem";
import {
  Journal,
  verifyRelay,
  guardRequest,
  guardTransport,
  SerialQueue,
} from "../src/safety.ts";
async function fixture(chainId = 11155111) {
  const account = privateKeyToAccount(generatePrivateKey());
  const tx = {
    chainId,
    nonce: 0,
    gas: 21000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 2n,
    to: "0x1111111111111111111111111111111111111111" as const,
    value: 100n,
    type: "eip1559" as const,
  };
  const raw = await account.signTransaction(tx);
  return {
    raw,
    hash: keccak256(raw),
    vault: account.address,
    intent: {
      chain_id: "11155111",
      nonce: "0",
      to: tx.to,
      value: "100",
      gas_limit: "21000",
      gas_price: "2",
    },
  };
}
describe("relay custody boundary", () => {
  it("accepts independently signed exact controller bytes, rejects chain/payload/hash/sender tampering", async () => {
    const f = await fixture();
    await expect(verifyRelay(f.raw, f.hash, f.vault, f.intent)).resolves.toBe(
      f.hash,
    );
    for (const bad of [
      { ...f, intent: { ...f.intent, nonce: "1" } },
      { ...f, intent: { ...f.intent, value: "101" } },
      { ...f, intent: { ...f.intent, gas_price: "3" } },
      { ...f, hash: `0x${"00".repeat(32)}` },
      { ...f, vault: f.intent.to },
      await fixture(1),
    ])
      await expect(
        verifyRelay(bad.raw, bad.hash, bad.vault, bad.intent),
      ).rejects.toThrow();
  });
  it("fsyncs public signed bytes before send and recovers identical raw on restart after lost response", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rino-journal-"));
    const path = join(dir, "journal.json");
    const j = await Journal.open(path);
    const f = await fixture();
    let count = 0;
    await expect(
      j.relay(f.hash, f.raw, async (raw) => {
        expect(
          JSON.parse(await readFile(path, "utf8")).broadcasts[f.hash].raw,
        ).toBe(raw);
        count++;
        throw Error("lost response");
      }),
    ).rejects.toThrow("lost response");
    const reloaded = await Journal.open(path);
    expect(reloaded.data.broadcasts[f.hash].raw).toBe(f.raw);
    await reloaded.relay(f.hash, f.raw, async (raw) => {
      expect(raw).toBe(f.raw);
      count++;
      return f.hash;
    });
    expect(count).toBe(2);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(
      reloaded.relay(f.hash, `${f.raw}00`, async () => f.hash),
    ).rejects.toThrow();
  });
});
it("denies CSRF, DNS rebinding, untrusted origins, unknown arguments and role/action injection", () => {
  const good = {
    host: "127.0.0.1:3000",
    origin: "http://127.0.0.1:3000",
    contentType: "application/json",
    csrf: "secret",
    expectedOrigin: "http://127.0.0.1:3000",
    expectedCsrf: "secret",
    body: { action: "borrow", role: "borrower" },
  };
  expect(() => guardRequest(good)).not.toThrow();
  for (const patch of [
    { host: "evil.test:3000" },
    { origin: "https://evil.test" },
    { csrf: "" },
    { contentType: "text/plain" },
    { body: { action: "sign", role: "borrower" } },
    {
      body: { action: "borrow", role: "borrower", rpcUrl: "https://evil.test" },
    },
    { body: { action: "borrow", role: "operator" } },
  ])
    expect(() => guardRequest({ ...good, ...patch })).toThrow();
});
it("serializes bounded operations and releases queue after a rejected action", async () => {
  const q = new SerialQueue(2);
  const order: number[] = [];
  const a = q.run(async () => {
    await new Promise((r) => setTimeout(r, 5));
    order.push(1);
    throw Error("denied");
  });
  const b = q.run(async () => {
    order.push(2);
    return 2;
  });
  await expect(q.run(async () => 3)).rejects.toThrow("queue");
  await expect(a).rejects.toThrow("denied");
  expect(await b).toBe(2);
  expect(order).toEqual([1, 2]);
});
it("serializes concurrent durable saves so bridge receipts and broadcast bytes survive restart", async () => {
  const path = join(
    await mkdtemp(join(tmpdir(), "rino-concurrent-")),
    "journal.json",
  );
  const j = await Journal.open(path);
  await Promise.all(
    Array.from({ length: 24 }, (_, i) =>
      j.receipt({
        id: String(i),
        chain: "near",
        action: "bridge",
        status: "success",
        hash: null,
        blockNumber: null,
        gasUsed: "1",
        feeWei: null,
        detail: "actual resume journal concurrency",
      }),
    ),
  );
  const reload = await Journal.open(path);
  expect(reload.data.receipts.length).toBe(24);
  expect(new Set(reload.data.receipts.map((r) => r.id)).size).toBe(24);
});
it("reconciles an included fifth equivalent packet with four occupied relay slots without broadcasting it", async () => {
  const { setSignEntropy, sign } = await import("viem/accounts");
  const { serializeTransaction } = await import("viem");
  const { findIncludedAlias } = await import("../src/safety.ts");
  const key = generatePrivateKey(),
    account = privateKeyToAccount(key);
  const tx = {
    chainId: 11155111,
    nonce: 0,
    gas: 21000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 2n,
    to: "0x1111111111111111111111111111111111111111" as const,
    value: 100n,
    type: "eip1559" as const,
  };
  const digest = keccak256(serializeTransaction(tx));
  const all: Array<{
    raw: `0x${string}`;
    hash: `0x${string}`;
    packet: string;
  }> = [];
  for (let i = 0; i < 5; i++) {
    setSignEntropy(true);
    const sig = await sign({ hash: digest, privateKey: key, to: "object" });
    const raw = serializeTransaction(tx, sig);
    all.push({
      raw,
      hash: keccak256(raw),
      packet: JSON.stringify({
        scheme: "Secp256k1",
        big_r: { affine_point: `0${2 + sig.yParity!}${sig.r.slice(2)}` },
        s: { scalar: sig.s.slice(2) },
        recovery_id: sig.yParity,
      }),
    });
  }
  const intent = {
    chain_id: "11155111",
    nonce: "0",
    to: tx.to,
    value: "100",
    gas_limit: "21000",
    gas_price: "2",
  };
  const result = await findIncludedAlias(
    all.slice(0, 4),
    all.map((x) => x.packet),
    intent,
    account.address,
    async (hash) => (hash === all[4].hash ? { transactionHash: hash } : null),
  );
  expect(result?.hash).toBe(all[4].hash);
  expect(result?.signatureJson).toBe(all[4].packet);
  await expect(
    findIncludedAlias(
      all.slice(0, 4),
      all.map((x) => x.packet),
      { ...intent, value: "101" },
      account.address,
      async () => null,
    ),
  ).rejects.toThrow("payload");
});

it("guards metadata transport without applying the legacy financial action parser", () => {
  const input = {
    host: "127.0.0.1:3000",
    origin: "http://127.0.0.1:3000",
    contentType: "application/json",
    csrf: "token",
    expectedOrigin: "http://127.0.0.1:3000",
    expectedCsrf: "token",
    body: { step: 0, event: "submission-started" },
  };
  expect(() => guardTransport(input)).not.toThrow();
  expect(() => guardRequest(input)).toThrow();
  for (const patch of [
    { host: "evil.test" },
    { origin: "https://evil.test" },
    { contentType: "text/plain" },
    { csrf: "wrong" },
  ])
    expect(() => guardTransport({ ...input, ...patch })).toThrow();
});

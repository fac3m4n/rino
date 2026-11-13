import { afterEach, describe, expect, it, vi } from "vitest";
import {
  open,
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OperationJournal,
  operationView,
  parseOperationRequest,
  parseOperationObservation,
  parseOperationImport,
  parseEmptyObject,
  type StoredOperation,
  type ExpectedStep,
} from "../src/operations.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const id = "12345678-1234-4234-8234-123456789abc";
const request = { id, action: "fund" as const, role: "lender" as const };
const binding = { controllerId: "controller.testnet" };
const hash = "11111111111111111111111111111111";
const near = (methodName = "fund_liquidity"): ExpectedStep => ({
  chain: "near",
  signerId: "lender.testnet",
  minimumBlock: "100",
  action: {
    chain: "near",
    receiverId: binding.controllerId,
    methodName,
    args: {},
    gas: "30000000000000",
    deposit: "0",
  },
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "proofcredit-operations-"));
  dirs.push(dir);
  const path = join(dir, "operations.json");
  return { dir, path, journal: await OperationJournal.open(path, binding) };
}
async function prepared(journal: OperationJournal, second = false) {
  await journal.start(request);
  return journal.update(id, (r) => {
    r.preparation = { phase: "prepared", detail: "prepared" };
    r.steps = [
      { expected: near(), started: false, hashes: [] },
      ...(second
        ? [{ expected: near("ft_transfer"), started: false, hashes: [] }]
        : []),
    ];
  });
}

// Missing durable writes, immutable identity or defensive copies lose/corrupt real recovery state.
describe("durable operation recovery", () => {
  it("reloads a started operation without fabricating a hash or success", async () => {
    const { journal, path } = await fixture();
    await prepared(journal);
    await journal.update(id, (r) => {
      r.steps[0].started = true;
    });
    const reopened = await OperationJournal.open(path, binding);
    expect(reopened.list()[0]).toMatchObject({
      stage: "needs-check",
      unresolved: true,
      steps: [{ started: true, hashes: [] }],
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it("does not repeat preparation for an identical id and rejects conflicting identities", async () => {
    const { journal } = await fixture();
    const first = await journal.start(request);
    await journal.update(id, (r) => {
      r.continued = true;
    });
    const again = await journal.start(request);
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.record.continued).toBe(true);
    await expect(
      journal.start({ ...request, action: "claim" }),
    ).rejects.toThrow();
  });
  it("returns defensive copies from every record and public read", async () => {
    const { journal } = await fixture();
    const started = await journal.start(request);
    started.record.request.role = "borrower";
    await prepared(journal);
    journal.get(id)!.steps[0].started = true;
    journal.records()[0].continued = true;
    journal.list()[0].detail = "secret";
    expect(journal.get(id)!.request.role).toBe("lender");
    expect(journal.get(id)!.steps[0].started).toBe(false);
    expect(journal.get(id)!.continued).toBe(false);
    expect(journal.list()[0].detail).not.toBe("secret");
  });
  it("keeps the old disk and memory snapshot after atomic-save failure and permits later recovery", async () => {
    const { journal, path } = await fixture();
    await prepared(journal);
    const old = await readFile(path, "utf8");
    const blocker = `${path}.${process.pid}.tmp`;
    await mkdir(blocker);
    await expect(
      journal.update(id, (r) => {
        r.continued = true;
      }),
    ).rejects.toThrow();
    expect(journal.get(id)!.continued).toBe(false);
    expect(await readFile(path, "utf8")).toBe(old);
    await rm(blocker, { recursive: true });
    await journal.update(id, (r) => {
      r.continued = true;
    });
    expect(
      (await OperationJournal.open(path, binding)).get(id)!.continued,
    ).toBe(true);
  });
  it("isolates retained update callback references after durable commit", async () => {
    const { journal, path } = await fixture();
    await prepared(journal);
    let retained: StoredOperation | undefined;
    await journal.update(id, (r) => {
      r.continued = true;
      retained = r;
    });
    retained!.steps[0].started = true;
    retained!.request.role = "borrower";
    expect(journal.get(id)!.steps[0].started).toBe(false);
    expect(journal.get(id)!.request.role).toBe("lender");
    expect(
      (await OperationJournal.open(path, binding)).get(id)!.steps[0].started,
    ).toBe(false);
  });
  it("matches identical request identities independently of object property order", async () => {
    const { journal } = await fixture();
    await journal.start(request);
    expect(
      (await journal.start({ role: "lender", action: "fund", id })).created,
    ).toBe(false);
  });
  it("marks interrupted preparation on reopen without preparing or fabricating submission", async () => {
    const { journal, path } = await fixture();
    await journal.start(request);
    const reopened = await OperationJournal.open(path, binding);
    expect(reopened.get(id)!.preparation.phase).toBe("interrupted");
    expect(reopened.list()[0]).toMatchObject({
      stage: "needs-check",
      unresolved: true,
      steps: [],
    });
    expect((await reopened.start(request)).created).toBe(false);
  });
  it("rolls back a renamed snapshot when the durability directory sync fails", async () => {
    const { journal, path, dir } = await fixture();
    await prepared(journal);
    const before = await readFile(path, "utf8");
    const handle = await open(dir, "r");
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const original = prototype.sync;
    let failed = false;
    const spy = vi.spyOn(prototype, "sync").mockImplementation(async function (
      this: typeof handle,
    ) {
      if (!failed && (await this.stat()).isDirectory()) {
        failed = true;
        throw Error("injected directory durability failure");
      }
      return original.call(this);
    });
    try {
      await expect(
        journal.update(id, (r) => {
          r.continued = true;
        }),
      ).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(failed).toBe(true);
    expect(await readFile(path, "utf8")).toBe(before);
    expect(journal.get(id)!.continued).toBe(false);
    await journal.update(id, (r) => {
      r.continued = true;
    });
    expect(
      (await OperationJournal.open(path, binding)).get(id)!.continued,
    ).toBe(true);
  });
  it("serializes read-modify-write updates rather than losing queued observations", async () => {
    const { journal, path } = await fixture();
    await prepared(journal);
    await Promise.all([
      journal.update(id, (r) => {
        r.steps[0].started = true;
      }),
      journal.update(id, (r) => {
        r.continued = true;
      }),
    ]);
    expect((await OperationJournal.open(path, binding)).get(id)).toMatchObject({
      continued: true,
      steps: [{ started: true }],
    });
  });
  it("rejects a different deployment, corrupt structure and oversize files", async () => {
    const { journal, path } = await fixture();
    await journal.start(request);
    await expect(
      OperationJournal.open(path, { controllerId: "another.testnet" }),
    ).rejects.toThrow();
    await writeFile(path, '{"version":1}');
    await expect(OperationJournal.open(path, binding)).rejects.toThrow();
    await writeFile(path, " ".repeat(8 * 1024 * 1024 + 1));
    await expect(OperationJournal.open(path, binding)).rejects.toThrow();
  });
  it("preserves all 64 unresolved records and rejects a 65th without eviction", async () => {
    const { journal, path } = await fixture();
    for (let i = 0; i < 64; i++)
      await journal.start({
        ...request,
        id: `12345678-1234-4234-8234-${i.toString(16).padStart(12, "0")}`,
      });
    await expect(journal.start(request)).rejects.toThrow();
    expect((await OperationJournal.open(path, binding)).list()).toHaveLength(
      64,
    );
  });
});

// A verified first step must not erase a later unknown step or imply complete settlement.
describe("independent verified step reduction", () => {
  it("keeps a two-step partial operation unresolved across reload", async () => {
    const { journal, path } = await fixture();
    await prepared(journal, true);
    await journal.update(id, (r) => {
      r.steps[0].hashes = [
        {
          hash,
          status: "succeeded",
          detail: "Transaction verified successfully.",
        },
      ];
      r.steps[1].started = true;
    });
    expect(
      (await OperationJournal.open(path, binding)).list()[0],
    ).toMatchObject({
      stage: "partial",
      unresolved: true,
      steps: [{ status: "succeeded" }, { status: "needs-check" }],
    });
  });
  it("distinguishes unsuccessful callback acceptance from a still-pending transaction", async () => {
    const { journal } = await fixture();
    await prepared(journal, true);
    await journal.update(id, (r) => {
      r.steps[0].hashes = [
        { hash, status: "failed", detail: "Transaction execution failed." },
      ];
      r.steps[1].started = true;
      r.steps[1].hashes = [
        {
          hash: "21111111111111111111111111111111111111111111",
          status: "pending",
          detail: "Transaction pending verification.",
        },
      ];
    });
    expect(journal.list()[0]).toMatchObject({
      stage: "partial",
      unresolved: true,
      steps: [{ status: "failed" }, { status: "processing" }],
    });
  });
  it("renders complete verified failure as resolved but wallet rejection as an observation", async () => {
    const { journal } = await fixture();
    await prepared(journal);
    await journal.update(id, (r) => {
      r.steps[0].observation = "wallet-rejected";
      r.steps[0].diagnostic = { category: "rejected" };
    });
    expect(journal.list()[0]).toMatchObject({
      stage: "awaiting-wallet",
      unresolved: false,
    });
    await journal.update(id, (r) => {
      r.steps[0].hashes = [
        { hash, status: "failed", detail: "Transaction execution failed." },
      ];
    });
    expect(journal.list()[0]).toMatchObject({
      stage: "failed",
      unresolved: false,
    });
    expect(journal.receipts()[0]).toMatchObject({ hash, status: "rejected" });
  });
  it("retains an unresolved later step even after explicit continuation", async () => {
    const { journal } = await fixture();
    await prepared(journal);
    await journal.update(id, (r) => {
      r.steps[0].started = true;
      r.continued = true;
    });
    expect(journal.list()[0]).toMatchObject({
      continued: true,
      unresolved: true,
      stage: "needs-check",
    });
  });
  it("omits proof context and malicious extra fields from public views", async () => {
    const { journal } = await fixture();
    const r = await prepared(journal);
    r.steps[0].expected = near();
    if (r.steps[0].expected.chain === "near")
      r.steps[0].expected.action.args = { proof: "private-proof-bytes" };
    (r as unknown as Record<string, unknown>).raw = "credential-secret";
    (r as unknown as Record<string, unknown>).error =
      "https://credential@provider/";
    const view = JSON.stringify(operationView(r));
    expect(view).not.toContain("private-proof");
    expect(view).not.toContain("credential");
    expect(view).not.toContain("provider");
  });
});

// Reusing a historical hash or editing context must never resolve another operation.
describe("journal integrity boundaries", () => {
  it("forbids global hash reuse, verified verdict overwrite and prepared context changes", async () => {
    const { journal } = await fixture();
    await prepared(journal);
    await journal.update(id, (r) => {
      r.steps[0].hashes = [
        {
          hash,
          status: "succeeded",
          detail: "Transaction verified successfully.",
        },
      ];
    });
    const other = "12345678-1234-4234-8234-123456789abd";
    await journal.start({ ...request, id: other });
    await expect(
      journal.update(other, (r) => {
        r.preparation = { phase: "prepared", detail: "prepared" };
        r.steps = [
          {
            expected: near(),
            started: true,
            hashes: [
              { hash, status: "hint", detail: "Transaction hash recorded." },
            ],
          },
        ];
      }),
    ).rejects.toThrow();
    for (const change of [
      (r: StoredOperation) => {
        r.steps[0].hashes[0].status = "pending";
      },
      (r: StoredOperation) => {
        if (r.steps[0].expected.chain === "near")
          r.steps[0].expected.minimumBlock = "99";
      },
      (r: StoredOperation) => {
        r.request.role = "borrower";
      },
      (r: StoredOperation) => {
        r.steps = [];
      },
    ])
      await expect(journal.update(id, change)).rejects.toThrow();
    expect(journal.list()[0].stage).toBe("succeeded");
  });
  it("rejects more than two steps, multiple NEAR hashes, missing Ethereum floors and oversize context", async () => {
    const { journal } = await fixture();
    await journal.start(request);
    const eth = {
      chain: "ethereum",
      kind: "funding",
      intent: {
        chainId: "11155111",
        from: `0x${"1".repeat(40)}`,
        to: `0x${"2".repeat(40)}`,
        valueWei: "1",
        data: "0x",
      },
    };
    for (const steps of [
      Array.from({ length: 3 }, () => ({
        expected: near(),
        started: false,
        hashes: [],
      })),
      [
        {
          expected: near(),
          started: true,
          hashes: [
            { hash, status: "hint", detail: "Transaction hash recorded." },
            {
              hash: "21111111111111111111111111111111111111111111",
              status: "hint",
              detail: "Transaction hash recorded.",
            },
          ],
        },
      ],
      [{ expected: eth, started: false, hashes: [] }],
      [
        {
          expected: {
            ...near(),
            action: {
              ...(near() as Extract<ExpectedStep, { chain: "near" }>).action,
              args: { proof: "x".repeat(96 * 1024) },
            },
          },
          started: false,
          hashes: [],
        },
      ],
    ])
      await expect(
        journal.update(id, (r) => {
          r.steps = steps as StoredOperation["steps"];
        }),
      ).rejects.toThrow();
    expect(journal.get(id)!.steps).toEqual([]);
  });
  it("reserves the exact already-authorized relay candidate across operations even before a hash hint", async () => {
    const { journal } = await fixture();
    await journal.start(request);
    const candidateHash = `0x${"1".repeat(64)}`;
    const expected: ExpectedStep = {
      chain: "ethereum",
      kind: "relay",
      nonce: "1",
      candidateHash,
      intent: {
        chainId: "11155111",
        from: `0x${"1".repeat(40)}`,
        to: `0x${"2".repeat(40)}`,
        valueWei: "1",
        data: "0x",
      },
    };
    await journal.update(id, (r) => {
      r.steps = [{ expected, started: true, hashes: [] }];
    });
    const other = "12345678-1234-4234-8234-123456789abd";
    await journal.start({ ...request, id: other });
    await expect(
      journal.update(other, (r) => {
        r.steps = [{ expected, started: false, hashes: [] }];
      }),
    ).rejects.toThrow();
    await expect(
      journal.update(id, (r) => {
        r.steps[0].hashes = [
          {
            hash: `0x${"2".repeat(64)}`,
            status: "hint",
            detail: "Transaction hash recorded.",
          },
        ];
      }),
    ).rejects.toThrow();
  });
  it("refuses structurally valid files with too many records or unsafe persisted diagnostics", async () => {
    const { journal, path } = await fixture();
    await prepared(journal);
    const data = JSON.parse(await readFile(path, "utf8"));
    const original = JSON.stringify(data);
    data.operations = Array.from({ length: 65 }, (_, i) => ({
      ...data.operations[0],
      request: {
        ...request,
        id: `12345678-1234-4234-8234-${i.toString(16).padStart(12, "0")}`,
      },
    }));
    await writeFile(path, JSON.stringify(data));
    await expect(OperationJournal.open(path, binding)).rejects.toThrow();
    const unsafe = JSON.parse(original);
    unsafe.operations[0].steps[0].diagnostic = {
      category: "unknown",
      message: "https://secret@rpc",
    };
    await writeFile(path, JSON.stringify(unsafe));
    await expect(OperationJournal.open(path, binding)).rejects.toThrow();
  });
  it("rejects more than four Ethereum candidates without dropping known hashes", async () => {
    const { journal } = await fixture();
    await journal.start({
      ...request,
      role: "borrower",
      evmSender: `0x${"1".repeat(40)}`,
    });
    await expect(
      journal.update(id, (r) => {
        r.steps = [
          {
            expected: {
              chain: "ethereum",
              kind: "funding",
              minimumBlock: "100",
              intent: {
                chainId: "11155111",
                from: `0x${"1".repeat(40)}`,
                to: `0x${"2".repeat(40)}`,
                valueWei: "1",
                data: "0x",
              },
            },
            started: true,
            hashes: Array.from({ length: 5 }, (_, i) => ({
              hash: `0x${i.toString(16).padStart(64, "0")}`,
              status: "hint",
              detail: "Transaction hash recorded.",
            })),
          },
        ];
      }),
    ).rejects.toThrow();
  });
});

// Strict schemas prevent observation payloads from becoming authority or secret storage.
describe("bounded strict operation parsers", () => {
  it("accepts only the locked request, hash observation, historical import and empty payload shapes", () => {
    expect(parseOperationRequest(request)).toEqual(request);
    expect(parseOperationObservation({ step: 0, event: "hash", hash })).toEqual(
      { step: 0, event: "hash", hash },
    );
    expect(parseOperationImport({ ...request, hash })).toEqual({
      ...request,
      hash,
    });
    expect(parseEmptyObject({})).toEqual({});
  });
  it("rejects malformed identity, extra financial authority and non-funding sender hints", () => {
    for (const bad of [
      { ...request, id: id.toUpperCase() },
      { ...request, id: "bad" },
      { ...request, id: id.replace("4234", "1234") },
      { ...request, role: "operator" },
      { ...request, action: "sign" },
      { ...request, valueWei: "1" },
      { ...request, evmSender: `0x${"1".repeat(40)}` },
      {
        ...request,
        action: "borrow",
        role: "borrower",
        evmSender: `0x${"1".repeat(40)}`,
      },
    ])
      expect(() => parseOperationRequest(bad)).toThrow();
  });
  it("rejects arbitrary errors, URLs, incompatible hash events and out-of-range steps", () => {
    for (const bad of [
      { step: 2, event: "submission-started" },
      { step: 0, event: "hash" },
      { step: 0, event: "hash", hash: "https://rpc" },
      { step: 0, event: "submission-started", hash },
      {
        step: 0,
        event: "wallet-unknown",
        diagnostic: { category: "timeout", message: "secret" },
      },
      {
        step: 0,
        event: "wallet-unknown",
        diagnostic: { category: "unknown", name: "https://credential@rpc" },
      },
      { step: 0, event: "wallet-unknown", status: "succeeded" },
      {
        step: 0,
        event: "wallet-unknown",
        diagnostic: { category: "unknown", code: "x".repeat(2048) },
      },
    ])
      expect(() => parseOperationObservation(bad)).toThrow();
    expect(() =>
      parseOperationImport({ ...request, hash: `0x${"1".repeat(64)}` }),
    ).toThrow();
    expect(() => parseEmptyObject({ role: "borrower" })).toThrow();
  });
});

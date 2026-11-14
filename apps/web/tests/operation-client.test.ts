import { afterEach, expect, it, vi } from "vitest";
import type { OperationView } from "@rino/coordinator/api";
import {
  OperationClient,
  mergeOperations,
  operationPaused,
  parseOperations,
} from "../src/operation-client";
import { configFixture, operationFixture } from "./fixtures";
const id = "11111111-1111-4111-8111-111111111111";
const hash = "11111111111111111111111111111111";
const config = {
  ...configFixture,
  mode: "public" as const,
  capabilities: { operations: true as const },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("keeps the original ID visible when create delivery is lost and never retries preparation", async () => {
  const visible: OperationView[] = [];
  const requests: unknown[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    throw Error("lost response");
  });
  const client = new OperationClient(config, (op) => visible.push(op));
  await expect(client.create("prove", "borrower")).rejects.toThrow();
  expect(requests).toHaveLength(1);
  expect(visible).toHaveLength(1);
  expect(visible[0]).toMatchObject({
    id: (requests[0] as { id: string }).id,
    action: "prove",
    stage: "preparing",
  });
  expect(operationPaused(visible)).toBe(true);
});
it("never opens a wallet request when submission-started acknowledgement is lost", async () => {
  let sends = 0;
  vi.stubGlobal("fetch", async () => {
    throw Error("lost metadata");
  });
  const client = new OperationClient(config, () => {});
  await expect(
    client.wallet(operationFixture, async (progress) => {
      await progress({ step: 0, event: "submission-started" });
      sends++;
    }),
  ).rejects.toThrow();
  expect(sends).toBe(0);
});
it("rotates CSRF only once for idempotent metadata with the same original operation", async () => {
  const requests: { url: string; token?: string }[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init: RequestInit) => {
    const token = (init.headers as Record<string, string>)["X-Rino-CSRF"];
    requests.push({ url: String(url), token });
    if (String(url).includes("config"))
      return Response.json({ ...config, csrfToken: "rotated" });
    if (token !== "rotated")
      return Response.json({ error: "ACTION_REJECTED" }, { status: 400 });
    return Response.json(operationFixture);
  });
  await new OperationClient(config, () => {}).observe(operationFixture, {
    step: 0,
    event: "wallet-unknown",
  });
  expect(requests).toEqual([
    { url: `/api/operations/${id}/observe`, token: config.csrfToken },
    { url: "/api/config?fresh=1", token: undefined },
    { url: `/api/operations/${id}/observe`, token: "rotated" },
  ]);
});
it("rejects a changed-token config on a changed network before replaying an observation", async () => {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (url: unknown) => {
    paths.push(String(url));
    return String(url).includes("config")
      ? Response.json({
          ...config,
          csrfToken: "rotated",
          near: { ...config.near, networkId: "mainnet" },
        })
      : paths.length === 1
        ? Response.json({ error: "ACTION_REJECTED" }, { status: 400 })
        : Response.json(operationFixture);
  });
  await expect(
    new OperationClient(config, () => {}).observe(operationFixture, {
      step: 0,
      event: "wallet-unknown",
    }),
  ).rejects.toThrow();
  expect(paths).toEqual([
    `/api/operations/${id}/observe`,
    "/api/config?fresh=1",
  ]);
});
it("never regresses deliberate continuation on an equal-timestamp stale read", () => {
  const current = { ...operationFixture, continued: true };
  const [merged] = mergeOperations([current], [operationFixture]);
  expect(merged.continued).toBe(true);
  expect(operationPaused([merged])).toBe(false);
});
it("joins equal-timestamp immutable partial-step evidence without regressing status or pause", () => {
  const first = {
    ...operationFixture,
    stage: "partial" as const,
    steps: [
      {
        ...operationFixture.steps[0],
        status: "succeeded" as const,
        hashes: [
          { hash, status: "succeeded" as const, detail: "Verified step" },
        ],
      },
      { ...operationFixture.steps[0], index: 1 },
    ],
  };
  const stale = {
    ...operationFixture,
    steps: [
      operationFixture.steps[0],
      { ...operationFixture.steps[0], index: 1 },
    ],
  };
  const [merged] = mergeOperations([first], [stale]);
  expect(merged.steps[0]).toEqual(first.steps[0]);
  expect(merged).toMatchObject({ stage: "partial", unresolved: true });
  expect(operationPaused([merged])).toBe(true);
  const completed = {
    ...stale,
    stage: "partial" as const,
    steps: [
      stale.steps[0],
      {
        ...stale.steps[1],
        status: "failed" as const,
        hashes: [
          {
            hash: "11111111111111111111111111111112",
            status: "failed" as const,
            detail: "Verified failure",
          },
        ],
      },
    ],
  };
  const [joined] = mergeOperations([merged], [completed]);
  expect(joined.steps.map((step) => step.status)).toEqual([
    "succeeded",
    "failed",
  ]);
  expect(joined).toMatchObject({ stage: "partial", unresolved: true });
  expect(operationPaused([joined])).toBe(true);
  // Only the server's completed view clears any remaining preparation ambiguity.
  const authoritative = {
    ...completed,
    unresolved: false,
    steps: [first.steps[0], completed.steps[1]],
  };
  const [checked] = mergeOperations([joined], [authoritative]);
  expect(checked).toMatchObject({ stage: "partial", unresolved: false });
  expect(operationPaused([checked])).toBe(false);
  const [afterStale] = mergeOperations([checked], [stale]);
  expect(afterStale.steps).toEqual(checked.steps);
  expect(afterStale).toMatchObject({ stage: "partial", unresolved: false });
  expect(operationPaused([afterStale])).toBe(false);
  const [afterContinuation] = mergeOperations(
    [{ ...checked, continued: true }],
    [stale],
  );
  expect(afterContinuation.continued).toBe(true);
  expect(operationPaused([afterContinuation])).toBe(false);
});
it("clears succeeded-stage preparation ambiguity after the server completes that operation", () => {
  const ambiguous = {
    ...operationFixture,
    stage: "succeeded" as const,
    unresolved: true,
    steps: [
      {
        ...operationFixture.steps[0],
        status: "succeeded" as const,
        hashes: [
          { hash, status: "succeeded" as const, detail: "Verified callback" },
        ],
      },
    ],
  };
  expect(operationPaused([ambiguous])).toBe(true);
  const authoritative = { ...ambiguous, unresolved: false };
  const [completed] = mergeOperations([ambiguous], [authoritative]);
  expect(completed).toMatchObject({ stage: "succeeded", unresolved: false });
  expect(completed.steps).toEqual(authoritative.steps);
  expect(operationPaused([completed])).toBe(false);
  const [afterStale] = mergeOperations([completed], [ambiguous]);
  expect(afterStale.unresolved).toBe(false);
});
it("does not freeze a partial batch with a merely prepared unstarted step", () => {
  const prepared = {
    ...operationFixture,
    stage: "partial" as const,
    unresolved: false,
    steps: [
      {
        ...operationFixture.steps[0],
        status: "succeeded" as const,
        hashes: [
          { hash, status: "succeeded" as const, detail: "Verified first step" },
        ],
      },
      {
        ...operationFixture.steps[0],
        index: 1,
        started: false,
        status: "prepared" as const,
      },
    ],
  };
  const interrupted = {
    ...prepared,
    unresolved: true,
    steps: [
      prepared.steps[0],
      { ...prepared.steps[1], started: true, status: "needs-check" as const },
    ],
  };
  const [merged] = mergeOperations([prepared], [interrupted]);
  expect(merged).toMatchObject({ stage: "partial", unresolved: true });
  expect(merged.steps[1]).toMatchObject({
    started: true,
    status: "needs-check",
  });
  expect(operationPaused([merged])).toBe(true);
});
it("does not replay metadata for unchanged-token rejection or create for any token rejection", async () => {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (url: unknown) => {
    paths.push(String(url));
    return String(url).includes("config")
      ? Response.json(config)
      : Response.json({ error: "ACTION_REJECTED" }, { status: 400 });
  });
  const client = new OperationClient(config, () => {});
  await expect(
    client.observe(operationFixture, { step: 0, event: "wallet-unknown" }),
  ).rejects.toThrow();
  await expect(client.create("prove", "borrower")).rejects.toThrow();
  expect(paths).toEqual([
    `/api/operations/${id}/observe`,
    "/api/config?fresh=1",
    "/api/operations",
  ]);
});
it("bounds hanging wallet observation without cancelling or replaying and attaches a late hash only to its original operation", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const bodies: { path: string; body: unknown }[] = [];
  const visible: OperationView[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init: RequestInit) => {
    bodies.push({ path: String(url), body: JSON.parse(String(init.body)) });
    return Response.json(operationFixture);
  });
  const client = new OperationClient(config, (op) => visible.push(op));
  let sends = 0;
  const delivery = client
    .wallet(operationFixture, async (progress) => {
      await progress({ step: 0, event: "submission-started" });
      sends++;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await progress({ step: 0, event: "hash", hash });
    })
    .catch((error) => error);
  await vi.advanceTimersByTimeAsync(180000);
  expect(await delivery).toMatchObject({
    uncertainMutation: true,
    diagnostic: { category: "timeout" },
  });
  client.dispose();
  const before = visible.length;
  finish();
  await vi.advanceTimersByTimeAsync(0);
  expect(sends).toBe(1);
  expect(visible).toHaveLength(before);
  expect(bodies.at(-1)).toEqual({
    path: `/api/operations/${id}/observe`,
    body: { step: 0, event: "hash", hash },
  });
});
it("retains a later unknown batch step when an earlier step succeeds and historical receipts arrive", () => {
  const partial = {
    ...operationFixture,
    stage: "partial" as const,
    steps: [
      {
        ...operationFixture.steps[0],
        status: "succeeded" as const,
        hashes: [{ hash, status: "succeeded" as const, detail: "Verified" }],
      },
      { ...operationFixture.steps[0], index: 1 },
    ],
  };
  const historical = {
    ...operationFixture,
    id: "22222222-2222-4222-8222-222222222222",
    historical: true,
    stage: "succeeded" as const,
    unresolved: false,
  };
  expect(operationPaused(mergeOperations([partial], [historical]))).toBe(true);
  expect(operationPaused([{ ...partial, continued: true }, historical])).toBe(
    false,
  );
  expect(
    mergeOperations(
      [
        {
          ...operationFixture,
          updatedAt: "3",
          stage: "failed",
          unresolved: false,
        },
      ],
      [operationFixture],
    )[0].stage,
  ).toBe("failed");
});
it("rejects unknown fields and foreign controller bindings in operation recovery", () => {
  expect(() =>
    parseOperations(
      [{ ...operationFixture, rawError: "secret" }],
      config.near.controllerId,
    ),
  ).toThrow();
  expect(() => parseOperations([operationFixture], "another.test")).toThrow();
});
it("restores a lost-create ID from bounded public hints without creating or opening a wallet", async () => {
  let stored: string | null = null;
  const storage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => {
      stored = value;
    },
  };
  let requests = 0;
  vi.stubGlobal("fetch", async () => {
    requests++;
    throw Error("lost create delivery");
  });
  const first: OperationView[] = [];
  await new OperationClient(config, (op) => first.push(op), storage)
    .create("prove", "borrower")
    .catch(() => {});
  const restored: OperationView[] = [];
  const client = new OperationClient(
    config,
    (op) => restored.push(op),
    storage,
  );
  await client.recoverHints([]);
  expect(restored).toHaveLength(1);
  expect(restored[0].id).toBe(first[0].id);
  expect(operationPaused(restored)).toBe(true);
  expect(requests).toBe(1);
});
it("coalesces concurrent manual and automatic checks for the same original operation", async () => {
  let resolve!: (response: Response) => void;
  let reads = 0;
  const response = new Promise<Response>((done) => {
    resolve = done;
  });
  vi.stubGlobal("fetch", () => {
    reads++;
    return response.then((value) => value.clone());
  });
  const client = new OperationClient(config, () => {});
  const first = client.check(operationFixture),
    second = client.check(operationFixture);
  resolve(Response.json(operationFixture));
  await Promise.all([first, second]);
  expect(reads).toBe(1);
});
it("persists only safe diagnostics for the exact attempted step, never guessing from aggregate hashes", async () => {
  const op = {
    ...operationFixture,
    steps: [
      operationFixture.steps[0],
      { ...operationFixture.steps[0], index: 1 },
    ],
  };
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json(op);
  });
  const client = new OperationClient(config, () => {});
  await client
    .wallet(op, async (progress) => {
      await progress({ step: 1, event: "submission-started" });
      throw {
        name: "SocketClosedError",
        code: "NETWORK_ERROR",
        message: "wallet closed https://credential.invalid",
        cause: { password: "secret", transactionHash: "invalid" },
      };
    })
    .catch(() => {});
  expect(bodies).toEqual([
    { step: 1, event: "submission-started" },
    {
      step: 1,
      event: "wallet-unknown",
      diagnostic: {
        category: "wallet-closed",
        name: "TransportError",
        code: "NETWORK_ERROR",
      },
    },
  ]);
});
it("server records remain usable when browser storage throws and malformed hints cannot supply action authority", async () => {
  vi.stubGlobal("fetch", async () => Response.json(operationFixture));
  const storage = {
    getItem: () => {
      throw Error("blocked storage");
    },
    setItem: () => {
      throw Error("blocked storage");
    },
  };
  const visible: OperationView[] = [];
  const client = new OperationClient(config, (op) => visible.push(op), storage);
  await client.observe(operationFixture, { step: 0, event: "hash", hash });
  expect(visible[0].id).toBe(id);
  expect(operationPaused(visible)).toBe(true);
});
it("keeps scoped metadata and CSRF rotation on the original market route", async () => {
  const calls: { url: string; token?: string }[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init: RequestInit) => {
    const token = (init.headers as Record<string, string>)["X-Rino-CSRF"];
    calls.push({ url: String(url), token });
    if (String(url).includes("config"))
      return Response.json({ ...config, csrfToken: "rotated" });
    if (token !== "rotated")
      return Response.json({ error: "ACTION_REJECTED" }, { status: 400 });
    return Response.json(operationFixture);
  });
  const client = new OperationClient(
    config,
    () => {},
    undefined,
    "/api/markets/reserve",
  );
  await client.observe(operationFixture, { step: 0, event: "wallet-unknown" });
  await client.check(operationFixture);
  expect(calls).toEqual([
    {
      url: `/api/markets/reserve/operations/${id}/observe`,
      token: config.csrfToken,
    },
    { url: "/api/markets/reserve/config?fresh=1", token: undefined },
    { url: `/api/markets/reserve/operations/${id}/observe`, token: "rotated" },
    {
      url: `/api/markets/reserve/operations/${id}/reconcile`,
      token: "rotated",
    },
  ]);
});
it("keeps unresolved browser requests in separate network and controller namespaces", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal("fetch", async () => {
    throw Error("lost preparation response");
  });
  const second = {
    ...config,
    near: { ...config.near, controllerId: "second.test" },
  };
  const otherNetwork = {
    ...config,
    near: { ...config.near, networkId: "testnet" as const },
  };
  const originals: OperationView[][] = [[], [], []];
  for (const [index, selected] of [config, second, otherNetwork].entries())
    await new OperationClient(
      selected,
      (op) => originals[index].push(op),
      storage,
    )
      .create("repay", "borrower")
      .catch(() => {});
  expect(values.size).toBe(3);
  const restored: OperationView[][] = [[], [], []];
  for (const [index, selected] of [config, second, otherNetwork].entries())
    await new OperationClient(
      selected,
      (op) => restored[index].push(op),
      storage,
    ).recoverHints([]);
  for (let index = 0; index < 3; index++) {
    expect(restored[index]).toHaveLength(1);
    expect(restored[index][0].id).toBe(originals[index][0].id);
  }
});
it("migrates matching legacy requests once without deleting legacy or resurrecting cleared evidence", async () => {
  const legacy = JSON.stringify({
    version: 1,
    controllerId: config.near.controllerId,
    hints: [],
    requests: [{ id, action: "prove", role: "borrower" }],
  });
  const values = new Map([["rino.operations.v1", legacy]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const visible: OperationView[] = [];
  const client = new OperationClient(config, (op) => visible.push(op), storage);
  await client.recoverHints([]);
  expect(visible).toHaveLength(1);
  expect(visible[0].id).toBe(id);
  expect(values.get("rino.operations.v1")).toBe(legacy);
  expect(values.size).toBe(2);
  const done = {
    ...operationFixture,
    stage: "failed" as const,
    unresolved: false,
  };
  await client.recoverHints([done]);
  const after: OperationView[] = [];
  await new OperationClient(
    config,
    (op) => after.push(op),
    storage,
  ).recoverHints([]);
  expect(after).toEqual([]);
  expect(values.get("rino.operations.v1")).toBe(legacy);
});
it("leaves another controller's legacy hints unchanged", async () => {
  const legacy = JSON.stringify({
    version: 1,
    controllerId: "foreign.test",
    hints: [],
    requests: [{ id, action: "repay", role: "borrower" }],
  });
  const values = new Map([["rino.operations.v1", legacy]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const visible: OperationView[] = [];
  const client = new OperationClient(config, (op) => visible.push(op), storage);
  await client.recoverHints([]);
  expect(visible).toEqual([]);
  expect(values.get("rino.operations.v1")).toBe(legacy);
});
it("does not overwrite unreadable or oversized scoped evidence", async () => {
  const { operationStorageKey } = await import("../src/operation-client");
  for (const original of [
    "not json",
    JSON.stringify({
      version: 1,
      controllerId: "foreign.test",
      hints: [],
      requests: [],
      retained: "x".repeat(100000),
    }),
  ]) {
    const values = new Map([[operationStorageKey(config), original]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    await new OperationClient(config, () => {}, storage).recoverHints([]);
    expect(values.get(operationStorageKey(config))).toBe(original);
  }
});
it("keeps preparation, deliberate continuation and hash imports on the captured market", async () => {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init: RequestInit) => {
    paths.push(String(url));
    const body = JSON.parse(String(init.body));
    const selectedId = body.id ?? String(url).split("/").at(-2);
    const operation = { ...operationFixture, id: selectedId };
    return Response.json(
      String(url).endsWith("/operations") ? { operation } : operation,
    );
  });
  const client = new OperationClient(
    config,
    () => {},
    undefined,
    "/api/markets/reserve",
  );
  const prepared = await client.create("prove", "borrower");
  await client.continue(prepared.operation);
  await client.import("prove", "borrower", hash);
  expect(paths).toEqual([
    "/api/markets/reserve/operations",
    `/api/markets/reserve/operations/${prepared.operation.id}/continue`,
    "/api/markets/reserve/operations/import",
  ]);
});
it("preserves a matching scoped payload until every hint and request is readable", async () => {
  const { operationStorageKey } = await import("../src/operation-client");
  const validHint = { id, action: "prove", role: "borrower", step: 0, hash };
  const validRequest = { id, action: "prove", role: "borrower" };
  const cases: unknown[] = [
    { hints: "unreadable-hash-evidence", requests: [] },
    { hints: [], requests: "unreadable-request-evidence" },
    { hints: Array(513).fill(validHint), requests: [] },
    { hints: [], requests: Array(65).fill(validRequest) },
    { hints: [null], requests: [] },
    {
      hints: [{ ...validHint, hash: "unreadable-hash-evidence" }],
      requests: [],
    },
    { hints: [{ ...validHint, unrecognized: "evidence" }], requests: [] },
    {
      hints: [],
      requests: [{ ...validRequest, id: "unreadable-request-evidence" }],
    },
    { hints: [], requests: [{ ...validRequest, evmSender: "not an address" }] },
    { hints: [], requests: [{ ...validRequest, unrecognized: "evidence" }] },
  ];
  for (const data of cases) {
    const original = JSON.stringify({
      version: 1,
      controllerId: config.near.controllerId,
      networkId: config.near.networkId,
      ...(data as object),
    });
    expect(original.length).toBeLessThan(98304);
    const values = new Map([[operationStorageKey(config), original]]);
    const writes = vi.fn((key: string, value: string) =>
      values.set(key, value),
    );
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: writes,
    };
    await new OperationClient(config, () => {}, storage).recoverHints([]);
    expect(writes).not.toHaveBeenCalled();
    expect(values.get(operationStorageKey(config))).toBe(original);
  }
});
it("never replaces legacy evidence with an empty namespace when its arrays are malformed", async () => {
  const original = JSON.stringify({
    version: 1,
    controllerId: config.near.controllerId,
    hints: [null],
    requests: [],
  });
  const values = new Map([["rino.operations.v1", original]]);
  const writes = vi.fn((key: string, value: string) => values.set(key, value));
  await new OperationClient(config, () => {}, {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: writes,
  }).recoverHints([]);
  expect(writes).not.toHaveBeenCalled();
  expect([...values.entries()]).toEqual([["rino.operations.v1", original]]);
});
it("does not write when reading browser recovery evidence fails", async () => {
  for (const failAt of ["scoped", "legacy"]) {
    const writes = vi.fn();
    const storage = {
      getItem: (key: string) => {
        if (failAt === "scoped" || key === "rino.operations.v1")
          throw Error("read denied");
        return null;
      },
      setItem: writes,
    };
    await new OperationClient(config, () => {}, storage).recoverHints([]);
    expect(writes).not.toHaveBeenCalled();
  }
});
it("migrates valid recovery records without filtering their exact funding sender", async () => {
  const sender = "0x1111111111111111111111111111111111111111";
  const original = JSON.stringify({
    version: 1,
    controllerId: config.near.controllerId,
    hints: [],
    requests: [{ id, action: "fund", role: "borrower", evmSender: sender }],
  });
  const values = new Map([["rino.operations.v1", original]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  await new OperationClient(config, () => {}, storage).recoverHints([]);
  const { operationStorageKey } = await import("../src/operation-client");
  expect(JSON.parse(values.get(operationStorageKey(config))!).requests).toEqual(
    [{ id, action: "fund", role: "borrower", evmSender: sender }],
  );
  expect(values.get("rino.operations.v1")).toBe(original);
});

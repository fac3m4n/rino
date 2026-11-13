import { afterEach, expect, it, vi } from "vitest";
import type { OperationView } from "@proofcredit/coordinator/api";
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
    const token = (init.headers as Record<string, string>)[
      "X-ProofCredit-CSRF"
    ];
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

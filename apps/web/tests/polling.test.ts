import { afterEach, expect, it, vi } from "vitest";
import { ReadPoller } from "../src/polling";
afterEach(() => vi.useRealTimers());
function setup(mode: "public" | "local" = "public") {
  vi.useFakeTimers();
  let reads = 0,
    ready = true,
    working = false,
    available = true;
  let event: (() => void) | undefined;
  let listening = 0;
  const poller = new ReadPoller({
    read: async () => {
      reads++;
      return ready;
    },
    mode: () => mode,
    pending: () => working,
    available: () => available,
    subscribe: (wake) => {
      event = wake;
      listening++;
      return () => {
        event = undefined;
        listening--;
      };
    },
  });
  poller.start();
  return {
    poller,
    get reads() {
      return reads;
    },
    get listening() {
      return listening;
    },
    fail: () => {
      ready = false;
    },
    succeed: () => {
      ready = true;
    },
    work: () => {
      working = true;
    },
    idle: () => {
      working = false;
    },
    event: () => event?.(),
    suspend: () => {
      available = false;
      event?.();
    },
    resume: () => {
      available = true;
      event?.();
    },
  };
}
it("reads immediately then only every 30s public idle, 5s pending and 2.5s local", async () => {
  const p = setup();
  await vi.advanceTimersByTimeAsync(0);
  expect(p.reads).toBe(1);
  await vi.advanceTimersByTimeAsync(29999);
  expect(p.reads).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(p.reads).toBe(2);
  p.work();
  p.event();
  await vi.advanceTimersByTimeAsync(0);
  expect(p.reads).toBe(3);
  await vi.advanceTimersByTimeAsync(4999);
  expect(p.reads).toBe(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(p.reads).toBe(4);
  p.poller.dispose();
  const local = setup("local");
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(2499);
  expect(local.reads).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(local.reads).toBe(2);
  local.poller.dispose();
});
it("backs failed/unready reads off at 15/30/60/120/120s and resets after a successful fresh delivery", async () => {
  const p = setup();
  p.fail();
  await vi.advanceTimersByTimeAsync(0);
  expect(p.reads).toBe(1);
  for (const [delay, count] of [
    [15000, 2],
    [30000, 3],
    [60000, 4],
    [120000, 5],
    [120000, 6],
  ]) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(p.reads).toBe(count - 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.reads).toBe(count);
  }
  p.succeed();
  p.poller.delivered(true);
  await vi.advanceTimersByTimeAsync(29999);
  expect(p.reads).toBe(6);
  await vi.advanceTimersByTimeAsync(1);
  expect(p.reads).toBe(7);
  p.poller.dispose();
});
it("starts no hidden/offline reads, resumes once, respects failure backoff and cleans listeners/timers", async () => {
  const p = setup();
  await vi.advanceTimersByTimeAsync(0);
  p.suspend();
  await vi.advanceTimersByTimeAsync(300000);
  expect(p.reads).toBe(1);
  p.resume();
  p.event();
  p.event();
  await vi.advanceTimersByTimeAsync(0);
  expect(p.reads).toBe(2);
  p.fail();
  p.event();
  await vi.advanceTimersByTimeAsync(0);
  expect(p.reads).toBe(3);
  p.suspend();
  p.resume();
  p.event();
  await vi.advanceTimersByTimeAsync(14999);
  expect(p.reads).toBe(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(p.reads).toBe(4);
  p.poller.dispose();
  p.resume();
  await vi.advanceTimersByTimeAsync(300000);
  expect(p.reads).toBe(4);
  expect(p.listening).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
it("never overlaps an already-started read during environment event bursts", async () => {
  vi.useFakeTimers();
  let resolve!: (ready: boolean) => void;
  let calls = 0;
  let available = true;
  let wake = () => {};
  const poller = new ReadPoller({
    read: () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    },
    mode: () => "public",
    pending: () => false,
    available: () => available,
    subscribe: (fn) => {
      wake = fn;
      return () => {};
    },
  });
  poller.start();
  available = false;
  wake();
  available = true;
  wake();
  wake();
  await vi.advanceTimersByTimeAsync(90000);
  expect(calls).toBe(1);
  resolve(true);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(29999);
  expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls).toBe(2);
  poller.dispose();
});
it("loads immediately without advancing time and cancels a StrictMode setup/cleanup probe", async () => {
  vi.useFakeTimers();
  let reads = 0;
  const options = {
    read: async () => {
      reads++;
      return true;
    },
    mode: () => "public" as const,
    pending: () => false,
    available: () => true,
    subscribe: () => () => {},
  };
  const probe = new ReadPoller(options);
  probe.start();
  probe.dispose();
  const live = new ReadPoller(options);
  live.start();
  await Promise.resolve();
  expect(reads).toBe(1);
  live.dispose();
});
it("keeps public idle status text on 30s cadence instead of treating it as outstanding work", async () => {
  const { pollingPending } = await import("../src/polling");
  const { stateFixture, settlementFixture } = await import("./fixtures");
  const idle = {
    ...stateFixture,
    pendingReason:
      "Awaiting liquidity, derived vault and fresh eligible collateral proof",
  };
  expect(pollingPending(idle, false, false)).toBe(false);
  expect(pollingPending({ ...idle, busy: true }, false, false)).toBe(true);
  expect(
    pollingPending({ ...idle, proofStatus: "ProofPending" }, false, false),
  ).toBe(true);
  expect(
    pollingPending(
      {
        ...idle,
        settlement: {
          ...settlementFixture,
          pending: { request_id: "pending" } as any,
        },
      },
      false,
      false,
    ),
  ).toBe(true);
  expect(pollingPending(idle, true, false)).toBe(true);
  expect(pollingPending(idle, false, true)).toBe(true);
});
it("returns to 30s idle cadence when an outstanding action finishes without starting another read", async () => {
  const p = setup();
  p.work();
  await vi.advanceTimersByTimeAsync(0);
  expect(p.reads).toBe(1);
  p.idle();
  p.poller.changed();
  await vi.advanceTimersByTimeAsync(29999);
  expect(p.reads).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(p.reads).toBe(2);
  p.poller.dispose();
});
it("polls an asynchronous vault derivation as outstanding work", async () => {
  const { pollingPending } = await import("../src/polling");
  const { stateFixture } = await import("./fixtures");
  expect(
    pollingPending({ ...stateFixture, proofStatus: "Deriving" }, false, false),
  ).toBe(true);
});
it("checks at most one known-hash operation per cycle, enforces five seconds, and stops after ten minutes", async () => {
  vi.useFakeTimers();
  const { operationFixture } = await import("./fixtures");
  let operations = [operationFixture];
  let checks = 0;
  let wake = () => {};
  const poller = new ReadPoller({
    read: async () => true,
    mode: () => "public",
    pending: () => true,
    available: () => true,
    subscribe: (fn) => {
      wake = fn;
      return () => {};
    },
    operations: () => operations,
    reconcile: async () => {
      checks++;
      return true;
    },
  });
  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(checks).toBe(0);
  operations = [
    {
      ...operationFixture,
      steps: [
        {
          ...operationFixture.steps[0],
          hashes: [
            {
              hash: "11111111111111111111111111111111",
              status: "pending",
              detail: "Pending",
            },
          ],
        },
      ],
    },
  ];
  wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(checks).toBe(1);
  wake();
  wake();
  await vi.advanceTimersByTimeAsync(4999);
  expect(checks).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(checks).toBe(2);
  await vi.advanceTimersByTimeAsync(600000);
  const exhausted = checks;
  wake();
  await vi.advanceTimersByTimeAsync(30000);
  expect(checks).toBe(exhausted);
  poller.dispose();
});
it("keeps no-hash uncertainty and terminal history at idle cadence without receipt queries", async () => {
  vi.useFakeTimers();
  const { operationFixture } = await import("./fixtures");
  let reads = 0,
    checks = 0;
  const poller = new ReadPoller({
    read: async () => {
      reads++;
      return true;
    },
    mode: () => "public",
    pending: () => false,
    available: () => true,
    subscribe: () => () => {},
    operations: () => [
      operationFixture,
      {
        ...operationFixture,
        id: "22222222-2222-4222-8222-222222222222",
        stage: "failed",
        unresolved: false,
        steps: [
          {
            ...operationFixture.steps[0],
            status: "failed",
            hashes: [
              {
                hash: "11111111111111111111111111111111",
                status: "failed",
                detail: "Final false",
              },
            ],
          },
        ],
      },
    ],
    reconcile: async () => {
      checks++;
      return true;
    },
  });
  poller.start();
  await vi.advanceTimersByTimeAsync(29999);
  expect(reads).toBe(1);
  expect(checks).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(reads).toBe(2);
  poller.dispose();
});
it("rotates due known-hash checks so an older continued operation cannot starve newer work", async () => {
  vi.useFakeTimers();
  const { operationFixture } = await import("./fixtures");
  const oldId = operationFixture.id,
    newId = "22222222-2222-4222-8222-222222222222";
  const known = {
    ...operationFixture,
    steps: [
      {
        ...operationFixture.steps[0],
        hashes: [
          {
            hash: "11111111111111111111111111111111",
            status: "pending" as const,
            detail: "Pending",
          },
        ],
      },
    ],
  };
  const checks: { id: string; at: number }[] = [];
  const start = Date.now();
  const poller = new ReadPoller({
    read: async () => true,
    mode: () => "public",
    pending: () => false,
    available: () => true,
    subscribe: () => () => {},
    operations: () => [
      { ...known, continued: true },
      { ...known, id: newId },
    ],
    reconcile: async (operation) => {
      checks.push({ id: operation.id, at: Date.now() - start });
      return true;
    },
  });
  poller.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(checks).toEqual([{ id: oldId, at: 0 }]);
  await vi.advanceTimersByTimeAsync(4999);
  expect(checks).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(checks).toEqual([
    { id: oldId, at: 0 },
    { id: newId, at: 5000 },
  ]);
  await vi.advanceTimersByTimeAsync(10000);
  expect(checks).toEqual([
    { id: oldId, at: 0 },
    { id: newId, at: 5000 },
    { id: oldId, at: 10000 },
    { id: newId, at: 15000 },
  ]);
  poller.dispose();
});

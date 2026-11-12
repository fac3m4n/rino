import { describe, expect, it } from "vitest";
import { configFixture, stateFixture } from "./fixtures";
import {
  SnapshotLane,
  mutationObserved,
  canContinueFromCheckedState,
} from "../src/snapshots";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
describe("snapshot delivery authority", () => {
  it("rejects a pre-action Active snapshot that arrives after newer Closed state", async () => {
    const old = deferred<string>(),
      fresh = deferred<string>();
    let starts = 0;
    const applied: string[] = [];
    const lane = new SnapshotLane(
      () => (++starts === 1 ? old.promise : fresh.promise),
      (value) => applied.push(value),
    );
    const previous = lane.refresh();
    lane.invalidate();
    const current = lane.refresh();
    fresh.resolve("Closed/Complete/debt0/nonce1");
    await current;
    old.resolve("Active/debt101/nonce0");
    await previous;
    expect(applied).toEqual(["Closed/Complete/debt0/nonce1"]);
  });
  it("coalesces overlapping polls instead of starting concurrent deliveries", async () => {
    const response = deferred<string>();
    let starts = 0;
    const applied: string[] = [];
    const lane = new SnapshotLane(
      () => {
        starts++;
        return response.promise;
      },
      (value) => applied.push(value),
    );
    const first = lane.refresh(),
      second = lane.refresh();
    response.resolve("Active");
    await Promise.all([first, second]);
    expect(starts).toBe(1);
    expect(applied).toEqual(["Active"]);
  });
  it("aborts and ignores delivery after effect cleanup", async () => {
    const response = deferred<string>();
    let signal: AbortSignal | undefined;
    const applied: string[] = [];
    const lane = new SnapshotLane(
      (s) => {
        signal = s;
        return response.promise;
      },
      (value) => applied.push(value),
    );
    const delivery = lane.refresh();
    lane.dispose();
    response.resolve("Late");
    await delivery;
    expect(applied).toEqual([]);
    expect(signal?.aborted).toBe(true);
  });
});

describe("uncertain mutation reconciliation", () => {
  const before = { config: configFixture, state: stateFixture, receipts: [] };
  it("does not unlock an unchanged snapshot without an outcome receipt", () =>
    expect(mutationObserved("repay", before, before)).toBe(false));
  it("keeps actions paused while the server still reports pending work", () =>
    expect(
      mutationObserved("repay", before, {
        ...before,
        state: {
          ...stateFixture,
          busy: true,
          market: { ...stateFixture.market!, phase: "Repaid", debt_units: "0" },
        },
      }),
    ).toBe(false));
  it("recognizes an authoritative repayment phase transition", () =>
    expect(
      mutationObserved("repay", before, {
        ...before,
        state: {
          ...stateFixture,
          market: { ...stateFixture.market!, phase: "Repaid", debt_units: "0" },
        },
      }),
    ).toBe(true));
  it("recognizes a newly observed rejection without automatically retrying it", () =>
    expect(
      mutationObserved("repay", before, {
        ...before,
        receipts: [
          {
            id: "actual-new-receipt",
            chain: "near",
            action: "repay",
            status: "rejected",
            hash: "receipt-hash",
            blockNumber: "4",
            gasUsed: "1",
            feeWei: null,
            detail: "Contract rejected",
          },
        ],
      }),
    ).toBe(true));
});

describe("deliberate continuation after checked unchanged state", () => {
  const checked = { config: configFixture, state: stateFixture, receipts: [] };
  const unknown = { action: "repay" as const, before: checked, checked };
  it("offers continuation after a fresh ready idle check without declaring the request observed", () => {
    expect(mutationObserved("repay", checked, checked)).toBe(false);
    expect(canContinueFromCheckedState(unknown, checked, true, false)).toBe(
      true,
    );
  });
  it("does not use pre-action state before any post-uncertainty check", () =>
    expect(
      canContinueFromCheckedState(
        { action: "repay", before: checked },
        checked,
        true,
        false,
      ),
    ).toBe(false));
  it("revokes an older checked snapshot when the latest delivery changed", () =>
    expect(
      canContinueFromCheckedState(unknown, { ...checked }, true, false),
    ).toBe(false));
  it("denies continuation while reads are unavailable", () =>
    expect(canContinueFromCheckedState(unknown, checked, false, false)).toBe(
      false,
    ));
  it("denies continuation while an action or refresh is pending", () =>
    expect(canContinueFromCheckedState(unknown, checked, true, true)).toBe(
      false,
    ));
  it("denies a fresh busy snapshot", () => {
    const busy = { ...checked, state: { ...stateFixture, busy: true } };
    expect(
      canContinueFromCheckedState(
        { ...unknown, checked: busy },
        busy,
        true,
        false,
      ),
    ).toBe(false);
  });
  it("denies an unready configuration", () => {
    const unready = { ...checked, config: { ...configFixture, ready: false } };
    expect(
      canContinueFromCheckedState(
        { ...unknown, checked: unready },
        unready,
        true,
        false,
      ),
    ).toBe(false);
  });
  it("denies unready chain state", () => {
    const unready = { ...checked, state: { ...stateFixture, ready: false } };
    expect(
      canContinueFromCheckedState(
        { ...unknown, checked: unready },
        unready,
        true,
        false,
      ),
    ).toBe(false);
  });
});
it("fresh refresh supersedes an in-flight display read and forwards fresh authority", async () => {
  const old = deferred<string>();
  let calls = 0;
  const modes: (boolean | undefined)[] = [];
  const applied: string[] = [];
  const lane = new SnapshotLane(
    (_signal, options) => {
      modes.push(options?.fresh);
      return ++calls === 1 ? old.promise : Promise.resolve("fresh");
    },
    (v) => applied.push(v),
  );
  const display = lane.refresh();
  await lane.refresh({ fresh: true });
  old.resolve("old");
  await display;
  expect(modes).toEqual([undefined, true]);
  expect(applied).toEqual(["fresh"]);
});

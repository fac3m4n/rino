import { expect, it } from "vitest";
import { ReadCache } from "../src/read-cache.ts";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
};
it("shares a generation and excludes a late pre-invalidation success from the cache", async () => {
  let now = 0,
    calls = 0;
  const old = deferred<string>();
  const cache = new ReadCache(
    5000,
    () => (++calls === 1 ? old.promise : Promise.resolve(`value-${calls}`)),
    { now: () => now },
  );
  const first = cache.read({ fresh: false });
  const shared = cache.read({ fresh: false });
  expect(calls).toBe(1);
  cache.invalidate();
  expect(await cache.read({ fresh: true })).toBe("value-2");
  old.resolve("old");
  await Promise.all([first, shared]);
  expect(await cache.read({ fresh: false })).toBe("value-2");
  now = 5000;
  expect(await cache.read({ fresh: false })).toBe("value-3");
  expect(calls).toBe(3);
});
it("does not serve expired success on failure and preserves 30s failure cooldown across invalidation", async () => {
  let now = 0,
    calls = 0,
    fail = false;
  const cache = new ReadCache(
    5000,
    async () => {
      calls++;
      if (fail) throw Error("unavailable");
      return "ok";
    },
    { now: () => now },
  );
  expect(await cache.read({ fresh: false })).toBe("ok");
  fail = true;
  now = 5000;
  await expect(cache.read({ fresh: false })).rejects.toThrow("unavailable");
  cache.invalidate();
  await expect(cache.read()).rejects.toThrow("unavailable");
  now = 34999;
  await expect(cache.read({ fresh: true })).rejects.toThrow("unavailable");
  expect(calls).toBe(2);
  now = 35000;
  fail = false;
  expect(await cache.read()).toBe("ok");
  expect(calls).toBe(3);
});
it("retains a failed old-generation cooldown without accepting its late success as authority", async () => {
  let now = 0,
    calls = 0;
  let reject!: (reason: Error) => void;
  const old = new Promise<string>((_r, j) => {
    reject = j;
  });
  const cache = new ReadCache(
    5000,
    () => {
      calls++;
      return old;
    },
    { now: () => now },
  );
  const read = cache.read();
  const failed = expect(read).rejects.toThrow("down");
  cache.invalidate();
  reject(Error("down"));
  await failed;
  await expect(cache.read()).rejects.toThrow("down");
  expect(calls).toBe(1);
});
it("fresh validation supersedes an older display flight and coalesces only current fresh callers", async () => {
  const display = deferred<string>();
  const fresh = deferred<string>();
  let calls = 0;
  const modes: (boolean | undefined)[] = [];
  const cache = new ReadCache(5000, (options) => {
    calls++;
    modes.push(options.fresh);
    return calls === 1 ? display.promise : fresh.promise;
  });
  const older = cache.read({ fresh: false });
  const current = cache.read({ fresh: true });
  const concurrent = cache.read();
  expect(calls).toBe(2);
  expect(modes).toEqual([false, true]);
  fresh.resolve("current-fresh");
  expect(await current).toBe("current-fresh");
  await concurrent;
  display.resolve("old-display");
  await older;
  expect(await cache.read({ fresh: false })).toBe("current-fresh");
  expect(calls).toBe(2);
});
it("preserves an old failure cooldown when a superseding in-flight fresh read succeeds", async () => {
  let now = 0,
    calls = 0;
  let rejectDisplay!: (reason: Error) => void;
  const display = new Promise<string>((_resolve, reject) => {
    rejectDisplay = reject;
  });
  const fresh = deferred<string>();
  const cache = new ReadCache(
    5000,
    () => {
      calls++;
      return calls === 1
        ? display
        : calls === 2
          ? fresh.promise
          : Promise.resolve("recovered");
    },
    { now: () => now },
  );
  const oldRead = cache.read({ fresh: false });
  const oldFailure = expect(oldRead).rejects.toThrow("old display unavailable");
  const freshRead = cache.read({ fresh: true });
  expect(calls).toBe(2);
  now = 1000;
  rejectDisplay(Error("old display unavailable"));
  await oldFailure;
  now = 2000;
  fresh.resolve("current fresh success");
  expect(await freshRead).toBe("current fresh success");
  const blocked = await Promise.allSettled([
    cache.read({ fresh: true }),
    cache.read(),
    cache.read({ fresh: false }),
  ]);
  expect(calls).toBe(2);
  expect(blocked).toEqual([
    {
      status: "rejected",
      reason: expect.objectContaining({ message: "old display unavailable" }),
    },
    {
      status: "rejected",
      reason: expect.objectContaining({ message: "old display unavailable" }),
    },
    {
      status: "rejected",
      reason: expect.objectContaining({ message: "old display unavailable" }),
    },
  ]);
  now = 30999;
  for (const options of [{ fresh: true }, undefined, { fresh: false }])
    await expect(cache.read(options)).rejects.toThrow(
      "old display unavailable",
    );
  expect(calls).toBe(2);
  now = 31000;
  expect(await cache.read()).toBe("recovered");
  expect(calls).toBe(3);
});

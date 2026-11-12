import { it, expect } from "vitest";
import { Children } from "../src/processes.ts";
it("closing an owner synchronously forbids later startup or restart spawns", async () => {
  const owner = new Children();
  try {
    const stopping = owner.stop();
    expect(() =>
      owner.spawn(process.execPath, ["-e", "process.exit(0)"]),
    ).toThrow("closed");
    await stopping;
  } finally {
    await owner.stop();
  }
});
it("concurrent cleanup requests share one bounded cleanup operation", async () => {
  const owner = new Children();
  const first = owner.stop(),
    second = owner.stop();
  expect(second).toBe(first);
  await first;
  expect(owner.all.size).toBe(0);
  expect(owner.groups.size).toBe(0);
});

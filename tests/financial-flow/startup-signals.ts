/** Actual startup signals at an explicit internal pause; no timing race. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  Children,
  ROOT,
  rpc,
  sleep,
  commandIdentity,
} from "../../services/coordinator/src/processes.ts";
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(label)), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
const results = [];
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  const owner = new Children();
  let marker: any, masterExit: unknown, failure: string | undefined;
  const master = owner.spawn(
    resolve(ROOT, "node_modules/.bin/tsx"),
    [resolve(ROOT, "services/coordinator/src/supervisor.ts")],
    {
      ...process.env,
      RINO_LAB_STARTUP_PAUSE: "after-anvil",
      RINO_MODE: "local",
    },
  );
  const exited = new Promise<void>((r) =>
    master.once("close", (code, sig) => {
      masterExit = { code, signal: sig };
      r();
    }),
  );
  try {
    marker = await bounded(
      new Promise<any>((resolveMarker, reject) => {
        let buffer = "";
        master.stdout!.on("data", (b: Buffer) => {
          buffer += b.toString();
          for (const line of buffer.split("\n"))
            if (line.startsWith("Rino lab startup paused ")) {
              resolveMarker(
                JSON.parse(
                  line.slice("Rino lab startup paused ".length),
                ),
              );
              return;
            }
        });
        master.once("close", () =>
          reject(Error("master exited before pause marker")),
        );
      }),
      "startup pause timeout",
    );
    assert.ok(
      (await commandIdentity(marker.pid)).includes("/.tools/anvil/1.7.1/anvil"),
    );
    assert.equal(await rpc(marker.url, "eth_chainId", []), "0xaa36a7");
    // The marker is emitted before Sandbox is spawned or ready.
    master.kill(signal);
    await bounded(exited, "master did not stop during startup");
    await assert.rejects(commandIdentity(marker.masterPid));
    await assert.rejects(commandIdentity(marker.pid));
    await assert.rejects(rpc(marker.url, "eth_chainId", []));
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  } finally {
    await owner.stop();
    // RED cleanup only: the old default signal behavior leaks its detached Anvil.
    if (marker) {
      try {
        const identity = await commandIdentity(marker.pid);
        if (identity.includes("/.tools/anvil/1.7.1/anvil"))
          process.kill(-marker.pid, "SIGTERM");
      } catch {}
    }
    if (marker) {
      for (let i = 0; i < 100; i++) {
        try {
          await commandIdentity(marker.pid);
          await sleep(30);
        } catch {
          break;
        }
      }
    }
  }
  results.push({
    signal,
    status: failure ? "FAIL" : "PASS",
    anvilPid: marker?.pid,
    masterExit,
    failure,
  });
}
console.log(
  JSON.stringify({
    status: results.every((r) => r.status === "PASS") ? "PASS" : "FAIL",
    results,
  }),
);
assert.ok(
  results.every((r) => r.status === "PASS"),
  JSON.stringify(results),
);

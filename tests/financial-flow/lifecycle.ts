import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  Children,
  startStack,
  rpc,
  commandIdentity,
  sleep,
  ROOT,
} from "../../services/coordinator/src/processes.ts";
const children = new Children(),
  start = Date.now();
await assert.rejects(
  startStack({
    children,
    sandboxBinary: "/does-not-exist/rino-sandbox",
  }),
  /startup failed/,
);
assert.ok(Date.now() - start < 8000);
assert.equal(children.all.size, 0);
assert.equal(children.groups.size, 0);
assert.equal(children.failures.length, 1);
const stack = await startStack();
const pids = [stack.manifest.anvilPid, stack.manifest.sandboxPid];
const groupPids = (
  await promisify(execFile)("/usr/bin/pgrep", [
    "-g",
    String(stack.manifest.sandboxPid),
  ])
).stdout
  .trim()
  .split(/\s+/)
  .map(Number);
assert.ok(groupPids.length >= 2);
// A launcher can crash before Drop. Its owned group remains tracked separately.
const launcher = [...stack.children.all].find(
  (c) => c.pid === stack.manifest.sandboxPid,
)!;
launcher.kill("SIGKILL");
await new Promise<void>((r) => launcher.once("exit", () => r()));
assert.ok(stack.children.groups.has(stack.manifest.sandboxPid));
await stack.children.stop();
assert.equal(stack.children.all.size, 0);
assert.equal(stack.children.groups.size, 0);
for (const pid of [...pids, ...groupPids])
  await assert.rejects(commandIdentity(pid));
await assert.rejects(rpc(stack.manifest.anvilUrl, "eth_chainId", []));
await assert.rejects(rpc(stack.manifest.nearUrl, "status", []));
const masterChildren = new Children();
const master = masterChildren.spawn(
  resolve(ROOT, "node_modules/.bin/tsx"),
  [resolve(ROOT, "services/coordinator/src/supervisor.ts")],
  { ...process.env, PORT: "3097" },
);
let publicNear = "",
  publicEthereum = "";
let masterOutput = "",
  liveConfig: any;
master.stdout?.on("data", (b: Buffer) => {
  masterOutput = (masterOutput + b.toString()).slice(-8192);
});
try {
  for (let i = 0; i < 600; i++) {
    if (master.exitCode !== null) break;
    try {
      const c: any = await (
        await fetch("http://127.0.0.1:3097/api/config")
      ).json();
      if (c.ready) {
        liveConfig = c;
        publicNear = c.near.rpcUrl;
        publicEthereum = c.ethereum.rpcUrl;
        break;
      }
    } catch {}
    await sleep(100);
  }
  assert.ok(publicNear && publicEthereum, "master readiness");
  const action = async (name: string, role: string) =>
    fetch("http://127.0.0.1:3097/api/actions", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3097",
        "content-type": "application/json",
        "x-rino-csrf": liveConfig.csrfToken,
      },
      body: JSON.stringify({ action: name, role }),
    });
  assert.equal((await action("initialize", "borrower")).status, 200);
  assert.equal((await action("fund", "lender")).status, 200);
  const session = masterOutput.match(/Owned local session ([^\n]+)/)?.[1];
  assert.ok(session);
  const server = JSON.parse(
    await readFile(resolve(session, "coordinator-public.json"), "utf8"),
  );
  const proving = action("prove", "borrower");
  proving.catch(() => {});
  let workerPid: number | undefined;
  for (let i = 0; i < 100 && !workerPid; i++) {
    try {
      const ids = (
        await promisify(execFile)("/usr/bin/pgrep", ["-P", String(server.pid)])
      ).stdout
        .trim()
        .split(/\s+/)
        .map(Number);
      for (const pid of ids) {
        const id = await commandIdentity(pid);
        if (id.includes("/rino-worker-host --module")) workerPid = pid;
      }
    } catch {}
    await sleep(30);
  }
  assert.ok(workerPid, "actual WASI worker active before master SIGTERM");
  master.kill("SIGTERM");
  await new Promise<void>((r) => master.once("close", () => r()));
  await proving.catch(() => {});
  await assert.rejects(commandIdentity(workerPid!));
  await assert.rejects(rpc(publicNear, "status", []));
  await assert.rejects(rpc(publicEthereum, "eth_chainId", []));
} finally {
  await masterChildren.stop();
}
console.log(
  JSON.stringify({
    status: "PASS",
    startupFailureCleanup: true,
    abruptLauncherGrandchildCleanup: true,
    masterSigtermListenerCleanup: true,
    activeWasiWorkerCleanup: true,
    ownedPidsStopped: new Set([...pids, ...groupPids]).size,
    elapsedMs: Date.now() - start,
  }),
);

import { resolve } from "node:path";
import { Children, startStack, ROOT, sleep, rpc } from "./processes.ts";
import { LocalCoordinator } from "./local.ts";

// Ownership and handlers exist before the first asynchronous startup step.
const children = new Children();
const cancellation = new AbortController();
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  // stop closes the owner synchronously; no continuation can spawn afterward.
  const cleanup = children.stop();
  cancellation.abort(Error("owned startup cancelled"));
  void cleanup.then(
    () => process.exit(0),
    () => {
      console.error("Owned process cleanup failed");
      process.exit(1);
    },
  );
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  const labPause = process.env.PROOFCREDIT_LAB_STARTUP_PAUSE;
  if (
    labPause &&
    (labPause !== "after-anvil" || process.env.PROOFCREDIT_MODE === "public")
  )
    throw Error("local lab startup pause configuration rejected");
  const stack = await startStack({
    children,
    signal: cancellation.signal,
    // Internal test gate, selected only by this explicit local environment value.
    // No HTTP action or public server consumes it.
    afterAnvilStarted: labPause
      ? async (info) => {
          const end = Date.now() + 10000;
          while (true) {
            children.assertOpen();
            cancellation.signal.throwIfAborted();
            try {
              if ((await rpc(info.url, "eth_chainId", [])) !== "0xaa36a7")
                throw Error("wrong lab chain");
              break;
            } catch {
              if (Date.now() > end) throw Error("lab Anvil startup timeout");
              await sleep(30);
            }
          }
          children.assertOpen();
          console.log(
            `ProofCredit lab startup paused ${JSON.stringify({ ...info, masterPid: process.pid })}`,
          );
          await new Promise<void>((_resolve, reject) => {
            const cancelled = () => reject(cancellation.signal.reason);
            if (cancellation.signal.aborted) cancelled();
            else
              cancellation.signal.addEventListener("abort", cancelled, {
                once: true,
              });
          });
        }
      : undefined,
  });
  children.assertOpen();
  const coordinator = await LocalCoordinator.open(stack.manifest, children);
  children.assertOpen();
  await coordinator.provision();
  children.assertOpen();
  console.log(`Owned local session ${stack.manifest.dir}`);
  // Chains and runtime keys survive bounded coordinator HTTP process restarts.
  for (let restart = 0; restart < 4 && !stopping; restart++) {
    const child = children.spawn(
      resolve(ROOT, "node_modules/.bin/tsx"),
      [resolve(ROOT, "services/coordinator/src/server.ts")],
      {
        ...process.env,
        PROOFCREDIT_MODE: "local",
        PROOFCREDIT_SESSION: stack.manifestPath,
      },
    );
    child.stdout?.on("data", (b) => process.stdout.write(b));
    const code = await new Promise<number | null>((r) => child.once("exit", r));
    await children.stopGroup(child.pid!);
    if (stopping || code === 0) break;
    console.log(
      "Restarting coordinator with owned chains and journal preserved",
    );
    await sleep(100);
  }
} catch {
  if (!stopping) {
    console.error("Owned local session failed; cleaning children");
    process.exitCode = 1;
  }
} finally {
  await children.stop();
}

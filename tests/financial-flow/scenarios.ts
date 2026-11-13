import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LocalCoordinator } from "../../services/coordinator/src/local.ts";
import {
  startStack,
  rpc,
  sleep,
} from "../../services/coordinator/src/processes.ts";
async function scenario(
  name: string,
  run: (c: LocalCoordinator) => Promise<void>,
) {
  if (process.env.SCENARIO && !name.includes(process.env.SCENARIO)) return;
  const stack = await startStack();
  try {
    const c = await LocalCoordinator.open(stack.manifest, stack.children);
    await c.provision();
    await c.action({ action: "initialize", role: "borrower" });
    await run(c);
    const state = await c.state();
    await writeFile(
      resolve(stack.manifest.dir, "scenario-result.json"),
      JSON.stringify(
        { name, state, receipts: c.journal.data.receipts },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        name,
        status: "PASS",
        session: stack.manifest.dir,
        state,
        receipts: c.journal.data.receipts,
      }),
    );
  } finally {
    await stack.children.stop();
    assert.equal(stack.children.all.size, 0);
  }
}
async function active(c: LocalCoordinator) {
  await c.action({ action: "fund", role: "lender" });
  await c.action({ action: "prove", role: "borrower" });
  await c.action({ action: "borrow", role: "borrower" });
}
await scenario("forgery-duplicate-repay", async (c) => {
  await c.action({ action: "fund", role: "lender" });
  await c.action({ action: "challenge-forgery", role: "borrower" });
  await c.action({ action: "prove", role: "borrower" });
  await c.action({ action: "borrow", role: "borrower" });
  await c.action({ action: "challenge-duplicate", role: "borrower" });
  const before = await c.state();
  await c.action({ action: "repay", role: "borrower" });
  await c.action({ action: "settle", role: "borrower" });
  await c.action({ action: "claim", role: "lender" });
  const state = await c.state();
  assert.equal(state.market!.phase, "Closed");
  assert.equal(state.market!.borrower_balance_units, "0");
  assert.equal(state.market!.lender_balance_units, "1000000000");
  assert.equal(state.market!.escrow_balance_units, "0");
  assert.equal(state.totalSupplyUnits, "1000000000");
  assert.equal(state.ethereum!.vaultNonce, "1");
  assert.equal(state.ethereum!.vaultBalanceWei, "0");
  assert.equal(
    BigInt(state.ethereum!.borrowerBalanceWei) -
      BigInt(before.ethereum!.borrowerBalanceWei),
    120000000000000000n - 42000000000000n,
  );
  await assert.rejects(c.fundEth(), /retired/);
  await c.call("borrower", "controller", "borrow", {}, 1n, true);
  assert.equal(c.journal.data.receipts.at(-1)!.status, "rejected");
});
await scenario("default-cap-surplus", async (c) => {
  await active(c);
  const before = await c.state();
  await c.action({ action: "advance-maturity", role: "lender" });
  await c.action({ action: "default", role: "lender" });
  await c.call("borrower", "controller", "repay", {}, 1n, true);
  assert.equal(c.journal.data.receipts.at(-1)!.status, "rejected");
  await c.action({ action: "settle", role: "lender" });
  const state = await c.state();
  assert.equal(state.market!.phase, "Closed");
  assert.equal(state.ethereum!.vaultNonce, "2");
  assert.equal(state.ethereum!.vaultBalanceWei, "0");
  assert.equal(state.settlement!.lender_paid_wei, "50500000000000000");
  assert.equal(state.settlement!.shortfall_credit_units, "0");
  assert.equal(
    BigInt(state.ethereum!.lenderBalanceWei) -
      BigInt(before.ethereum!.lenderBalanceWei),
    50500000000000000n,
  );
  assert.equal(
    BigInt(state.ethereum!.borrowerBalanceWei) -
      BigInt(before.ethereum!.borrowerBalanceWei),
    120000000000000000n - 50500000000000000n - 84000000000000n,
  );
  assert.equal(state.totalSupplyUnits, "1000000000");
});
await scenario("cancel-before-loan", async (c) => {
  await c.action({ action: "fund", role: "lender" });
  await c.action({ action: "cancel", role: "borrower" });
  await c.call("borrower", "controller", "borrow", {}, 1n, true);
  assert.equal(c.journal.data.receipts.at(-1)!.status, "rejected");
  await c.action({ action: "settle", role: "borrower" });
  const state = await c.state();
  assert.equal(state.market!.phase, "Closed");
  assert.equal(state.market!.debt_units, "0");
  assert.equal(state.ethereum!.vaultBalanceWei, "0");
  assert.equal(state.ethereum!.vaultNonce, "1");
  assert.equal(state.totalSupplyUnits, "1000000000");
});
await scenario("lost-broadcast-restart-historical", async (c) => {
  await active(c);
  await c.action({ action: "repay", role: "borrower" });
  const serverPath = resolve("services/coordinator/src/server.ts");
  const serverEnv = {
    ...process.env,
    PORT: "3089",
    RINO_MODE: "local",
    RINO_SESSION: resolve(c.manifest.dir, "session-private.json"),
  };
  const first = c.children.spawn(
    resolve("node_modules/.bin/tsx"),
    [serverPath],
    { ...serverEnv, RINO_LAB_FAULT: "lost-broadcast-response-once" },
  );
  let firstConfig: any;
  for (let i = 0; i < 100; i++) {
    try {
      firstConfig = await (
        await fetch("http://127.0.0.1:3089/api/config")
      ).json();
      break;
    } catch {
      await sleep(100);
    }
  }
  assert.ok(firstConfig?.ready);
  const lost = await fetch("http://127.0.0.1:3089/api/actions", {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:3089",
      "content-type": "application/json",
      "x-rino-csrf": firstConfig.csrfToken,
    },
    body: JSON.stringify({ action: "settle", role: "borrower" }),
  });
  const lostResult: any = await lost.json();
  assert.equal(lost.status, 400);
  assert.match(lostResult.message, /lost broadcast response/);
  first.kill("SIGTERM");
  await new Promise<void>((r) => first.once("exit", () => r()));
  const persisted = await LocalCoordinator.open(c.manifest, c.children);
  c.journal.data = persisted.journal.data;
  let state = await c.state();
  assert.equal(state.market!.phase, "Repaid");
  assert.equal(state.ethereum!.vaultNonce, "1");
  const entries = Object.entries(c.journal.data.broadcasts);
  assert.equal(entries.length, 1);
  assert.equal(entries[0][1].status, "uncertain");
  const beforeId = c.manifest.anvilInstanceId,
    nearGenesis = c.manifest.nearGenesis,
    raw = entries[0][1].raw;
  // New actual HTTP process reattaches to the original chain supervisor, same keys and journal.
  await c.advanceTo(BigInt(state.nearTimeSeconds!) + 7200n);
  const child = c.children.spawn(
    resolve("node_modules/.bin/tsx"),
    [resolve("services/coordinator/src/server.ts")],
    {
      ...process.env,
      PORT: "3089",
      RINO_MODE: "local",
      RINO_SESSION: resolve(c.manifest.dir, "session-private.json"),
    },
  );
  try {
    let config: any;
    for (let i = 0; i < 100; i++) {
      try {
        config = await (await fetch("http://127.0.0.1:3089/api/config")).json();
        break;
      } catch {
        await sleep(100);
      }
    }
    assert.ok(config?.ready);
    assert.notEqual(child.pid, first.pid);
    const response = await fetch("http://127.0.0.1:3089/api/actions", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3089",
        "content-type": "application/json",
        "x-rino-csrf": config.csrfToken,
      },
      body: JSON.stringify({ action: "recover", role: "borrower" }),
    });
    const result: any = await response.json();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.state.market.phase, "Closed");
    assert.equal(result.state.ethereum.vaultNonce, "1");
    assert.equal(result.state.ethereum.vaultBalanceWei, "0");
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((r) => child.once("exit", () => r()));
  }
  const restarted = await LocalCoordinator.open(c.manifest, c.children);
  assert.equal(restarted.manifest.anvilInstanceId, beforeId);
  assert.equal(restarted.manifest.nearGenesis, nearGenesis);
  assert.equal(restarted.journal.data.broadcasts[entries[0][0]].raw, raw);
  assert.equal(
    restarted.journal.data.broadcasts[entries[0][0]].status,
    "confirmed",
  );
  // Reconcile direct actual chain views with newly persisted journal for report.
  c.journal.data = restarted.journal.data;
});

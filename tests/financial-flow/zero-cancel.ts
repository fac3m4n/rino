import assert from "node:assert/strict";
import { startStack } from "../../services/coordinator/src/processes.ts";
import { LocalCoordinator } from "../../services/coordinator/src/local.ts";
const stack = await startStack();
try {
  const c = await LocalCoordinator.open(stack.manifest, stack.children);
  await c.provision();
  await c.action({ action: "initialize", role: "borrower" });
  await c.action({ action: "cancel", role: "borrower" });
  await c.action({ action: "settle", role: "borrower" });
  const state = await c.state();
  assert.equal(state.market!.phase, "Closed");
  assert.equal(state.ethereum!.vaultNonce, "0");
  assert.equal(state.ethereum!.vaultBalanceWei, "0");
  assert.equal(state.settlement!.borrower_surplus_wei, "0");
  assert.equal(state.settlement!.fees_paid_wei, "0");
  assert.equal(state.settlement!.candidate_count, 0);
  console.log(
    JSON.stringify({
      status: "PASS",
      scenario: "zero-balance-authenticated-cancel",
      session: c.manifest.dir,
      state,
      receipts: c.journal.data.receipts,
    }),
  );
} finally {
  await stack.children.stop();
}

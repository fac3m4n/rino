import assert from "node:assert/strict";
import { LocalCoordinator } from "../../services/coordinator/src/local.ts";
import { startStack } from "../../services/coordinator/src/processes.ts";
const stack = await startStack();
try {
  const c = await LocalCoordinator.open(stack.manifest);
  await c.provision();
  await c.call("borrower", "controller", "initialize_vault");
  assert.equal(await c.view("controller", "get_vault"), stack.manifest.vault);
  await c.call(
    "lender",
    "controller",
    "ft_transfer",
    { receiver_id: "borrower", amount: "1000000" },
    1n,
  );
  await c.call("lender", "controller", "fund_liquidity", {}, 1n);
  await c.fundEth();
  await c.withBridge(async () =>
    c.call("borrower", "controller", "request_proof", {
      bundle: await c.bundle(),
    }),
  );
  assert.equal((await c.state()).proofStatus, "ProofReady");
  await c.call("borrower", "controller", "borrow", {}, 1n);
  let state = await c.state();
  assert.equal(state.market!.borrower_balance_units, "101000000");
  assert.equal(state.market!.debt_units, "101000000");
  assert.equal(state.totalSupplyUnits, "1000000000");
  await c.call("borrower", "controller", "repay", {}, 1n);
  await c.settle();
  state = await c.state();
  assert.equal(state.market!.phase, "Closed");
  assert.equal(state.ethereum!.vaultNonce, "1");
  assert.equal(state.ethereum!.vaultBalanceWei, "0");
  assert.equal(state.market!.lender_claim_units, "101000000");
  assert.equal(state.totalSupplyUnits, "1000000000");
  console.log(
    JSON.stringify(
      {
        status: "PASS",
        session: stack.manifest.dir,
        state,
        receipts: c.journal.data.receipts,
      },
      null,
      2,
    ),
  );
} finally {
  await stack.children.stop();
}

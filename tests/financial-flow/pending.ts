import assert from "node:assert/strict";
import { LocalCoordinator } from "../../services/coordinator/src/local.ts";
import { startStack, rpc } from "../../services/coordinator/src/processes.ts";
import { verifyRelay } from "../../services/coordinator/src/safety.ts";
import type {
  Settlement,
  SignedTransaction,
} from "../../services/coordinator/src/api.ts";
const stack = await startStack();
const c = await LocalCoordinator.open(stack.manifest, stack.children);
try {
  await c.provision();
  await c.call("borrower", "controller", "initialize_vault");
  await c.fundEth();
  await c.call("borrower", "controller", "cancel");
  const bundle = await c.bundle(c.manifest.borrowerRecipient);
  await c.withBridge(() =>
    c.call("borrower", "controller", "prepare_settlement", {
      bundle,
      gas_price: "2000000000",
    }),
  );
  await c.withBridge(() =>
    c.call("borrower", "controller", "request_signature"),
  );
  const candidate = (
    await c.view<SignedTransaction[]>("controller", "get_signed_transactions")
  )[0];
  const frozen = (await c.view<Settlement>("controller", "get_settlement"))
    .current_intent!;
  await verifyRelay(
    candidate.raw,
    candidate.hash,
    c.manifest.vault,
    frozen.transfer,
  );
  await rpc(c.manifest.anvilUrl, "anvil_setAutomine", [false]);
  await c.journal.relay(candidate.hash, candidate.raw, async (raw) =>
    rpc(c.manifest.anvilUrl, "eth_sendRawTransaction", [raw]),
  );
  assert.equal(
    await rpc(c.manifest.anvilUrl, "eth_getTransactionReceipt", [
      candidate.hash,
    ]),
    null,
  );
  assert.equal(
    await rpc(c.manifest.anvilUrl, "eth_getTransactionCount", [
      c.manifest.vault,
      "latest",
    ]),
    "0x0",
  );
  // Reuse the captured finalized checkpoint from before broadcast. The node
  // has no inclusion receipt, so actual worker quorum must reject confirmation.
  await c.withBridge(() =>
    c.call(
      "borrower",
      "controller",
      "confirm_settlement",
      {
        candidate_hash: candidate.hash,
        bundle: { checkpoint: bundle, transaction_index: "0" },
        signature_json: null,
      },
      0n,
      true,
    ),
  );
  assert.equal(c.journal.data.receipts.at(-1)!.status, "rejected");
  let pending = await c.view<Settlement>("controller", "get_settlement");
  assert.deepEqual(pending.current_intent, frozen);
  assert.equal(pending.expected_nonce, "0");
  assert.equal(pending.fees_paid_wei, "0");
  try {
    await c.journal.relay(candidate.hash, candidate.raw, async (raw) =>
      rpc(c.manifest.anvilUrl, "eth_sendRawTransaction", [raw]),
    );
  } catch (e) {
    assert.match(String(e), /already|known|imported/i);
  }
  assert.equal(c.journal.data.broadcasts[candidate.hash].raw, candidate.raw);
  assert.equal(
    await rpc(c.manifest.anvilUrl, "eth_getTransactionCount", [
      c.manifest.vault,
      "latest",
    ]),
    "0x0",
  );
  // A different own-chain ID must deny ALL local signing before the SDK sends.
  await rpc(c.manifest.anvilUrl, "anvil_setChainId", [1]);
  await assert.rejects(
    c.call("borrower", "controller", "request_signature"),
    /wrong Ethereum network/,
  );
  await rpc(c.manifest.anvilUrl, "anvil_setChainId", [11155111]);
  await rpc(c.manifest.anvilUrl, "evm_mine", []);
  await rpc(c.manifest.anvilUrl, "anvil_setAutomine", [true]);
  await c.settle();
  let state = await c.state();
  assert.equal(state.market!.phase, "Closed");
  assert.equal(state.ethereum!.vaultNonce, "1");
  await c.call(
    "borrower",
    "controller",
    "confirm_settlement",
    {
      candidate_hash: candidate.hash,
      bundle: {
        checkpoint: await c.bundle(c.manifest.borrowerRecipient),
        transaction_index: "0",
      },
      signature_json: null,
    },
    0n,
    true,
  );
  assert.equal(c.journal.data.receipts.at(-1)!.status, "rejected");
  state = await c.state();
  assert.equal(state.ethereum!.vaultNonce, "1");
  assert.equal(state.ethereum!.vaultBalanceWei, "0");
  console.log(
    JSON.stringify({
      status: "PASS",
      scenario: "no-mining-wrong-network-duplicate-confirm",
      session: c.manifest.dir,
      state,
      receipts: c.journal.data.receipts,
    }),
  );
} finally {
  await stack.children.stop();
}

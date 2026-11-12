import assert from "node:assert/strict";
import { LocalCoordinator } from "../../services/coordinator/src/local.ts";
import { startStack, rpc } from "../../services/coordinator/src/processes.ts";
import type {
  Settlement,
  SignedTransaction,
} from "../../services/coordinator/src/api.ts";
async function scenario(
  name: string,
  f: (c: LocalCoordinator) => Promise<void>,
) {
  const stack = await startStack();
  try {
    const c = await LocalCoordinator.open(stack.manifest, stack.children);
    await c.provision();
    await c.call("borrower", "controller", "initialize_vault");
    await f(c);
    console.log(
      JSON.stringify({
        name,
        status: "PASS",
        session: c.manifest.dir,
        state: await c.state(),
        receipts: c.journal.data.receipts,
      }),
    );
  } finally {
    await stack.children.stop();
  }
}
async function prepare(c: LocalCoordinator, gas = "100000000000") {
  const bundle = await c.bundle(c.manifest.borrowerRecipient);
  await c.withBridge(() =>
    c.call("borrower", "controller", "prepare_settlement", {
      bundle,
      gas_price: gas,
    }),
  );
}
async function confirm(c: LocalCoordinator, hash: string, index: string) {
  const checkpoint = await c.bundle(c.manifest.borrowerRecipient);
  await c.withBridge(() =>
    c.call("borrower", "controller", "confirm_settlement", {
      candidate_hash: hash,
      bundle: { checkpoint, transaction_index: index },
      signature_json: null,
    }),
  );
}
await scenario(
  "six-real-reverts-fee-exhaustion-authenticated-topup",
  async (c) => {
    await c.fundEth();
    await c.call("borrower", "controller", "cancel");
    const fee = 21000n * 100000000000n;
    for (let i = 0; i < 6; i++) {
      await prepare(c);
      await c.withBridge(() =>
        c.call("borrower", "controller", "request_signature"),
      );
      const candidate = (
        await c.view<SignedTransaction[]>(
          "controller",
          "get_signed_transactions",
        )
      )[0];
      // Explicit lab fault: code appears AFTER the no-code checkpoint and signature.
      await rpc(c.manifest.anvilUrl, "anvil_setCode", [
        c.manifest.borrowerRecipient,
        "0x60006000fd",
      ]);
      await rpc(c.manifest.anvilUrl, "evm_mine", []);
      await c.journal.relay(candidate.hash, candidate.raw, async (raw) =>
        rpc(c.manifest.anvilUrl, "eth_sendRawTransaction", [raw]),
      );
      const receipt = await c.waitReceipt(
        candidate.hash,
        "lab-recipient-code-reverted-transfer",
      );
      assert.equal(receipt.status, "0x0");
      assert.equal(BigInt(receipt.gasUsed), 21000n);
      assert.equal(BigInt(receipt.effectiveGasPrice), 100000000000n);
      await confirm(
        c,
        candidate.hash,
        BigInt(receipt.transactionIndex).toString(),
      );
      const s = await c.view<Settlement>("controller", "get_settlement");
      assert.equal(s.expected_nonce, String(i + 1));
      assert.equal(s.last_confirmation!.success, false);
      assert.equal(s.last_confirmation!.paid_value, "0");
      assert.equal(s.borrower_surplus_wei, "0");
      assert.equal(s.fees_paid_wei, (fee * BigInt(i + 1)).toString());
      // A duplicate confirmation cannot debit the same consumed nonce again.
      await c.call(
        "borrower",
        "controller",
        "confirm_settlement",
        {
          candidate_hash: candidate.hash,
          bundle: {
            checkpoint: await c.bundle(c.manifest.borrowerRecipient),
            transaction_index: BigInt(receipt.transactionIndex).toString(),
          },
          signature_json: null,
        },
        0n,
        true,
      );
      assert.equal(c.journal.data.receipts.at(-1)!.status, "rejected");
      await rpc(c.manifest.anvilUrl, "anvil_setCode", [
        c.manifest.borrowerRecipient,
        "0x",
      ]);
      await rpc(c.manifest.anvilUrl, "evm_mine", []);
    }
    assert.equal(
      (await c.view<Settlement>("controller", "get_settlement"))
        .remaining_fee_budget_wei,
      "0",
    );
    await prepare(c);
    let s = await c.view<Settlement>("controller", "get_settlement");
    assert.equal(s.stage, "NeedsTopup");
    assert.equal(s.current_intent, null);
    assert.equal(s.retired, false);
    await c.fundEth(fee);
    const bundle = await c.bundle(c.manifest.borrowerRecipient);
    await c.withBridge(() =>
      c.call("borrower", "controller", "add_fee_budget", {
        bundle,
        amount: fee.toString(),
      }),
    );
    const budget = (await c.view<Settlement>("controller", "get_settlement"))
      .remaining_fee_budget_wei;
    await c.withBridge(() =>
      c.call(
        "borrower",
        "controller",
        "add_fee_budget",
        { bundle, amount: fee.toString() },
        0n,
        true,
      ),
    );
    assert.equal(c.journal.data.receipts.at(-1)!.status, "rejected");
    assert.equal(
      (await c.view<Settlement>("controller", "get_settlement"))
        .remaining_fee_budget_wei,
      budget,
    );
    await c.settle();
    s = await c.view<Settlement>("controller", "get_settlement");
    assert.equal(s.retired, true);
    assert.equal(s.expected_nonce, "7");
    assert.equal((await c.state()).ethereum!.vaultBalanceWei, "0");
  },
);
await scenario("one-wei-dust-needs-topup-not-false-release", async (c) => {
  await c.fundEth(1n);
  await c.call("borrower", "controller", "cancel");
  await prepare(c, "2000000000");
  let s = await c.view<Settlement>("controller", "get_settlement");
  assert.equal(s.stage, "NeedsTopup");
  assert.equal(s.balance_wei, "1");
  assert.equal(s.borrower_surplus_wei, "0");
  assert.equal(s.retired, false);
  await c.fundEth(42000000000000n);
  await c.settle();
  s = await c.view<Settlement>("controller", "get_settlement");
  assert.equal(s.retired, true);
  assert.equal(s.borrower_surplus_wei, "1");
  assert.equal(s.fees_paid_wei, "42000000000000");
  assert.equal((await c.state()).ethereum!.vaultNonce, "1");
});

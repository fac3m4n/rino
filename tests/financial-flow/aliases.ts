import assert from "node:assert/strict";
import { serializeTransaction, keccak256, type Hex } from "viem";
import { LocalCoordinator } from "../../services/coordinator/src/local.ts";
import {
  startStack,
  rpc,
  sleep,
} from "../../services/coordinator/src/processes.ts";
import type { Settlement } from "../../services/coordinator/src/api.ts";
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
  for (let i = 0; i < 3; i++)
    await c.withBridge(() =>
      c.call("borrower", "controller", "request_signature"),
    );
  assert.equal(
    (await c.view<Settlement>("controller", "get_settlement")).candidate_count,
    3,
  );
  c.labHoldNextSignature = true;
  const fourth = c.withBridge(() =>
    c.call("borrower", "controller", "request_signature", {}, 0n, true),
  );
  while (Object.keys(c.journal.data.packets).length < 4) await sleep(100);
  let s = await c.view<Settlement>("controller", "get_settlement");
  await c.advanceTo(BigInt(s.pending!.expires_at) + 1n);
  await fourth;
  if ((await c.view<Settlement>("controller", "get_settlement")).pending)
    await c.call("borrower", "controller", "expire_pending");
  c.labHoldNextSignature = true;
  const fifth = c.withBridge(() =>
    c.call("borrower", "controller", "request_signature", {}, 0n, true),
  );
  while (Object.keys(c.journal.data.packets).length < 5) await sleep(100);
  const packet4 = c.journal.data.packets["mpc:3"],
    packet5 = c.journal.data.packets["mpc:4"];
  assert.notEqual(packet4, packet5);
  await c.call("borrower", "controller", "adopt_signature", {
    signature_json: packet4,
  });
  await c.call("mpc", "mpc", "resume", {
    index: 4,
    output: packet5,
    fail: false,
  });
  await fifth;
  s = await c.view<Settlement>("controller", "get_settlement");
  assert.equal(s.candidate_count, 4);
  assert.equal(s.pending, null);
  // Explicit lab external broadcaster includes the superseded fifth response.
  const t = s.current_intent!.transfer,
    p = JSON.parse(packet5);
  const raw = serializeTransaction(
    {
      type: "eip1559",
      chainId: 11155111,
      nonce: Number(t.nonce),
      to: t.to as Hex,
      value: BigInt(t.value),
      gas: 21000n,
      maxFeePerGas: BigInt(t.gas_price),
      maxPriorityFeePerGas: BigInt(t.gas_price),
      data: "0x",
      accessList: [],
    },
    {
      r: `0x${p.big_r.affine_point.slice(2)}`,
      s: `0x${p.s.scalar}`,
      yParity: p.recovery_id,
    },
  );
  const hash = keccak256(raw);
  const aliases = await c.view<any[]>("controller", "get_signed_transactions");
  assert.ok(!aliases.some((a) => a.hash === hash));
  await c.journal.relay(hash, raw, async (raw) =>
    rpc(c.manifest.anvilUrl, "eth_sendRawTransaction", [raw]),
  );
  const receipt = await c.waitReceipt(
    hash,
    "external-fifth-equivalent-signature",
  );
  await c.advanceTo((await c.now()) + 7200n);
  const checkpoint = await c.bundle(t.to);
  let confirmationPacket = packet5;
  if (process.env.MAX_WIRE === "1") {
    confirmationPacket =
      packet5 + " ".repeat(1024 - Buffer.byteLength(packet5));
    const prepareJob = (await c.view<any[]>("executor", "get_records"))[0];
    const estimate = JSON.parse(prepareJob.args.input_data);
    estimate.request_id = "99";
    estimate.generation = "99";
    estimate.requested_at = String(await c.now());
    estimate.expires_at = String((await c.now()) + 600n);
    estimate.bundle = checkpoint;
    estimate.purpose = {
      kind: "confirm",
      intent: t,
      candidate: {
        raw,
        hash,
        signing_digest: s.current_intent!.signing_digest,
        r: `0x${p.big_r.affine_point.slice(2)}`,
        s: `0x${p.s.scalar}`,
        y_parity: String(p.recovery_id),
      },
      before_balance_wei: s.current_intent!.before_balance_wei,
      minimum_block_number: s.current_intent!.minimum_block_number,
      transaction_index: BigInt(receipt.transactionIndex).toString(),
    };
    checkpoint.beneficiary_account_proof = [];
    while (JSON.stringify(estimate).length < 32700) {
      const remaining = 32700 - JSON.stringify(estimate).length - 5;
      if (remaining < 2) break;
      checkpoint.beneficiary_account_proof.push(
        "0x" + "00".repeat(Math.min(1024, Math.floor(remaining / 2))),
      );
    }
    assert.ok(JSON.stringify(estimate).length <= 32704);
    assert.equal(Buffer.byteLength(confirmationPacket), 1024);
  }
  if (process.env.RECOVER_ALIAS === "1") await c.settle();
  else
    await c.withBridge(() =>
      c.call("borrower", "controller", "confirm_settlement", {
        candidate_hash: hash,
        bundle: {
          checkpoint,
          transaction_index: BigInt(receipt.transactionIndex).toString(),
        },
        signature_json: confirmationPacket,
      }),
    );
  const state = await c.state();
  assert.equal(state.market!.phase, "Closed");
  assert.equal(state.ethereum!.vaultNonce, "1");
  assert.equal(state.ethereum!.vaultBalanceWei, "0");
  assert.equal(state.settlement!.candidate_count, 0);
  assert.equal(state.settlement!.last_confirmation!.transaction_hash, hash);
  console.log(
    JSON.stringify({
      status: "PASS",
      scenario: "full-four-aliases-fifth-historical-confirmation",
      session: stack.manifest.dir,
      maxWire: process.env.MAX_WIRE === "1",
      actualInputBytes: Buffer.byteLength(
        (await c.view<any[]>("executor", "get_records")).at(-1).args.input_data,
      ),
      signaturePacketBytes: Buffer.byteLength(confirmationPacket),
      state,
      receipts: c.journal.data.receipts,
    }),
  );
} catch (e) {
  console.error(
    JSON.stringify({
      session: stack.manifest.dir,
      error: e instanceof Error ? e.message : String(e),
      receipts: c.journal.data.receipts,
    }),
  );
  throw e;
} finally {
  await stack.children.stop();
}

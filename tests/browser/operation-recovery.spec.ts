/** Controlled external boundaries; real App/client/wallet guards, no chain evidence. */
import { expect, test, type Page } from "@playwright/test";
import {
  configFixture,
  stateFixture,
  settlementFixture,
} from "../../apps/web/tests/fixtures";
import type { State, OperationView } from "@proofcredit/coordinator/api";

const borrower = "proofcredit-b-2593ce.testnet";
const lender = "proofcredit-l-2593ce.testnet";
const id = "11111111-1111-4111-8111-111111111111";
const proof = (page: Page) =>
  page.getByRole("button", { name: /^Authenticate collateral/ });

const goodHash = "11111111111111111111111111111111";
const wrongHash = "11111111111111111111111111111112";
const finalityDetail =
  "Preparation stopped while awaiting an eligible finalized checkpoint on both fixed providers. No wallet request was made. Refresh chain state and try again when finality has advanced.";
async function installRecovery(
  page: Page,
  options: {
    seed?: "unknown" | "partial" | "terminal";
    lostHashReply?: boolean;
    stoppedRelease?: boolean;
  } = {},
) {
  let operation: OperationView | undefined;
  let submissions = 0;
  let checks = 0;
  let creates = 0;
  let freshReadsAfterCreate = 0;
  const config = {
    ...configFixture,
    mode: "public",
    capabilities: { operations: true },
    near: {
      ...configFixture.near,
      networkId: "testnet",
      borrowerId: borrower,
      lenderId: lender,
    },
  };
  const state: State = {
    ...stateFixture,
    market: {
      ...stateFixture.market!,
      borrower,
      lender,
      phase: "Offered",
      borrowed_at: null,
      proof_fresh: false,
    },
    proofStatus: "None",
    evidence: null,
  };
  if (options.stoppedRelease) {
    state.market = {
      ...state.market!,
      phase: "Repaid",
      debt_units: "0",
      borrowed_at: "80",
      borrower_balance_units: "0",
    };
    state.settlement = {
      ...settlementFixture,
      stage: "Signed",
      branch: "repay",
      balance_wei: "120000000000000000",
      accounted_balance_wei: "120000000000000000",
      checkpoint_block_number: "42",
      candidate_count: 1,
      current_intent: {
        transfer: {
          chain_id: "11155111",
          nonce: "0",
          to: state.market.borrower_recipient,
          value: "119997900000000000",
          gas_limit: "21000",
          gas_price: "100000000",
        },
        signing_preimage: "0x02",
        signing_digest: `0x${"11".repeat(32)}`,
        before_balance_wei: "120000000000000000",
        minimum_block_number: "42",
      },
    };
    state.proofStatus = "Authenticated";
    state.evidence = { balance_wei: "120000000000000000" };
  }
  const action = {
    chain: "near",
    receiverId: config.near.controllerId,
    methodName: "request_proof",
    args: {},
    gas: "100000000000000",
    deposit: "0",
  };
  const prepare = (operationId = id): OperationView =>
    (operation = {
      id: operationId,
      controllerId: config.near.controllerId,
      action: "prove",
      role: "borrower",
      historical: false,
      createdAt: "1794528000000",
      updatedAt: "1794528000000",
      stage: "awaiting-wallet",
      unresolved: false,
      continued: false,
      detail: "Wallet submission needs checking. No transaction hash is known.",
      steps: [
        {
          index: 0,
          chain: "near",
          method: "request_proof",
          signerId: borrower,
          receiverId: config.near.controllerId,
          started: false,
          status: "prepared",
          hashes: [],
        },
      ],
    });
  if (options.seed) {
    prepare();
    operation!.unresolved = options.seed !== "terminal";
    operation!.stage =
      options.seed === "terminal"
        ? "failed"
        : options.seed === "partial"
          ? "partial"
          : "needs-check";
    operation!.steps[0].started = true;
    operation!.steps[0].status =
      options.seed === "terminal" ? "failed" : "needs-check";
    if (options.seed === "terminal")
      operation!.steps[0].hashes = [
        {
          hash: goodHash,
          status: "failed",
          detail: "Final callback returned false; acceptance unsuccessful.",
        },
      ];
    if (options.seed === "partial") {
      operation!.action = "fund";
      operation!.role = "lender";
      operation!.steps[0] = {
        ...operation!.steps[0],
        method: "ft_transfer",
        status: "succeeded",
        hashes: [
          {
            hash: goodHash,
            status: "succeeded",
            detail: "Exact unit transfer verified.",
          },
        ],
      };
      operation!.steps.push({
        ...operation!.steps[0],
        index: 1,
        method: "fund_liquidity",
        status: "needs-check",
        hashes: [],
      });
    }
  }
  await page.route("**/api/config*", (r) => r.fulfill({ json: config }));
  await page.route("**/api/state*", (r) => {
    if (creates && new URL(r.request().url()).searchParams.get("fresh") === "1")
      freshReadsAfterCreate++;
    return r.fulfill({ json: state });
  });
  await page.route("**/api/receipts*", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/operations**", async (r) => {
    if (r.request().method() === "GET")
      return r.fulfill({ json: operation ? [operation] : [] });
    const path = new URL(r.request().url()).pathname;
    const body = r.request().postDataJSON();
    if (path === "/api/operations") {
      creates++;
      if (options.stoppedRelease) {
        expect(body.action).toBe("settle");
        expect(body.role).toBe("borrower");
        operation = {
          ...prepare(body.id),
          action: "settle",
          stage: "failed",
          detail: finalityDetail,
          steps: [],
        };
        return r.fulfill({ json: { operation } });
      }
      return r.fulfill({
        json: { operation: prepare(body.id), walletActions: [action] },
      });
    }
    if (path.endsWith("/observe") && operation) {
      if (body.event === "hash" && body.hash === wrongHash)
        return r.fulfill({
          status: 400,
          json: {
            error: "ACTION_REJECTED",
            message:
              "Public operation request rejected; review persisted operation evidence",
          },
        });
      operation.steps[body.step].started = true;
      operation.steps[body.step].status = "needs-check";
      if (body.event === "hash")
        operation.steps[body.step].hashes = [
          { hash: body.hash, status: "hint", detail: "Unverified wallet hint" },
        ];
      operation.stage = operation.steps.some(
        (step) => step.status === "succeeded",
      )
        ? "partial"
        : "needs-check";
      operation.unresolved = true;
      if (options.lostHashReply && body.event === "hash") return r.abort();
      return r.fulfill({ json: operation });
    }
    if (path.endsWith("/reconcile") && operation) {
      checks++;
      const step = operation.steps.find(
        (step) =>
          step.hashes.some((hash) => hash.hash === goodHash) &&
          step.status !== "succeeded",
      );
      if (step) {
        step.status = "failed";
        step.hashes[0] = {
          hash: goodHash,
          status: "failed",
          detail: "Final callback returned false; acceptance unsuccessful.",
        };
        operation.stage = "failed";
        operation.unresolved = false;
      }
      return r.fulfill({ json: operation });
    }
    if (path.endsWith("/continue") && operation) {
      operation.continued = true;
      return r.fulfill({ json: operation });
    }
    return r.fulfill({
      status: 400,
      json: {
        error: "ACTION_REJECTED",
        message: "Fixture rejected unexpected request",
      },
    });
  });
  // The frozen legacy App prepares here; the recovered App must use /operations.
  await page.route("**/api/actions", (r) => {
    prepare();
    return r.fulfill({
      json: {
        ok: true,
        message: "Controlled preparation",
        state,
        receiptIds: [],
        walletActions: [action],
      },
    });
  });
  await page.exposeFunction("recoverySubmitted", () => {
    submissions++;
    if (operation) {
      operation.steps[0].started = true;
      operation.steps[0].status = "needs-check";
      operation.stage = operation.steps.some(
        (step) => step.status === "succeeded",
      )
        ? "partial"
        : "needs-check";
      operation.unresolved = true;
    }
  });
  await page.addInitScript(() => {
    const listeners: Record<string, (value: unknown) => void> = {};
    Object.assign(globalThis, {
      ethereum: {
        on(name: string, cb: (value: unknown) => void) {
          listeners[name] = cb;
        },
        removeListener(name: string) {
          delete listeners[name];
        },
        async request({ method }: { method: string }) {
          if (method === "eth_accounts")
            return localStorage.getItem("fixture.evm.authorized")
              ? ["0x1111111111111111111111111111111111111111"]
              : [];
          if (method === "eth_requestAccounts") {
            const accounts = ["0x1111111111111111111111111111111111111111"];
            localStorage.setItem("fixture.evm.authorized", "yes");
            listeners.accountsChanged?.(accounts);
            return accounts;
          }
          if (method === "eth_chainId") return "0xaa36a7";
          if (method === "eth_sendTransaction") {
            await (
              globalThis as unknown as { recoverySubmitted(): Promise<void> }
            ).recoverySubmitted();
            throw new Error("Unexpected controlled Ethereum submission");
          }
          throw new Error("Unexpected controlled RPC");
        },
      },
    });
  });
  await page.route(
    /\/node_modules\/\.vite\/deps\/@hot-labs_near-connect\.js(?:\?|$)/,
    (r) =>
      r.fulfill({
        contentType: "application/javascript",
        body: `
    const borrower = ${JSON.stringify(borrower)}, lender = ${JSON.stringify(lender)}, lostHashReply = ${JSON.stringify(options.lostHashReply === true)}, hash = ${JSON.stringify(goodHash)};
    export class NearConnector {
      listeners = {};
      on(name, cb) { this.listeners[name] = cb; }
      off(name) { delete this.listeners[name]; }
      async connect() {
        const wallet = await this.wallet(), accounts = await wallet.signIn();
        localStorage.setItem('fixture.near.authorized', borrower);
        this.listeners['wallet:signIn']?.({ wallet, accounts, success: true, source: 'signIn' });
        return wallet;
      }
      async getConnectedWallet() {
        if (!localStorage.getItem('fixture.near.authorized')) throw new Error('Not authorized');
        const wallet = await this.wallet(); return { wallet, accounts: await wallet.getAccounts() };
      }
      async wallet() { return {
        manifest: { id: 'meteor-wallet' },
        getAccounts: async () => [lender, borrower].map(accountId => ({ accountId, publicKey: 'ed25519:fixture' })),
        signIn: async () => [{ accountId: borrower, publicKey: 'ed25519:fixture' }],
        signAndSendTransaction: async () => { await globalThis.recoverySubmitted(); if (lostHashReply) return { status: { SuccessValue: 'dHJ1ZQ==' }, transaction: { hash, signer_id: borrower }, receipts_outcome: [] }; return new Promise(() => {}); },
      }; }
      async disconnect() { localStorage.removeItem('fixture.near.authorized'); this.listeners['wallet:signOut']?.({ success: true }); }
    }
    export default { NearConnector };
  `,
      }),
  );
  await page.goto("/");
  return {
    submissions: () => submissions,
    checks: () => checks,
    operation: () => operation,
    creates: () => creates,
    freshReadsAfterCreate: () => freshReadsAfterCreate,
  };
}

test.setTimeout(20000);
test("@operation-recovery-red reload preserves an unresolved wallet request and blocks a second submission", async ({
  page,
}) => {
  const fixture = await installRecovery(page);
  await page
    .getByRole("button", { name: "Connect NEAR testnet", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: borrower, exact: true }),
  ).toBeVisible({ timeout: 3000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(proof(page)).toBeEnabled({ timeout: 3000 });
  await proof(page).click();
  await expect.poll(fixture.submissions, { timeout: 3000 }).toBe(1);
  expect(fixture.operation()?.steps[0].started).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("button", { name: borrower, exact: true }),
  ).toBeVisible({ timeout: 3000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  // Behavioral RED: the frozen App enables this control after losing its memory.
  await expect(proof(page)).toBeDisabled({ timeout: 2000 });
  await expect(
    page.getByRole("region", { name: "Operation recovery" }),
  ).toContainText("needs checking", { timeout: 2000 });
  expect(fixture.submissions()).toBe(1);
  await test.info().attach("operation-recovery-panel", {
    body: await page
      .getByRole("region", { name: "Operation recovery" })
      .screenshot(),
    contentType: "image/png",
  });
});

test("@operation-recovery matching manual hash shows final false as verified failure", async ({
  page,
}) => {
  const fixture = await installRecovery(page, { seed: "unknown" });
  const panel = page.getByRole("region", { name: "Operation recovery" });
  await expect(panel).toContainText("needs checking", { timeout: 3000 });
  await panel
    .getByRole("textbox", { name: `Transaction hash ${id} step 1` })
    .fill(goodHash);
  await panel.getByRole("button", { name: "Attach hash and check" }).click();
  await expect(panel).toContainText("Verified failure", { timeout: 3000 });
  await expect(panel).toContainText("Final callback returned false");
  expect(fixture.submissions()).toBe(0);
});

test("@operation-recovery wrong hash preserves the pause and earlier batch success cannot erase a later unknown step", async ({
  page,
}) => {
  const fixture = await installRecovery(page, { seed: "partial" });
  const panel = page.getByRole("region", { name: "Operation recovery" });
  await expect(panel).toContainText("partial", { timeout: 3000 });
  await panel
    .getByRole("textbox", { name: `Transaction hash ${id} step 2` })
    .fill(wrongHash);
  await panel.getByRole("button", { name: "Attach hash and check" }).click();
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 3000 });
  await expect(panel).toContainText("needs checking");
  await expect(panel).toContainText("Verified step success");
  expect(fixture.operation()?.unresolved).toBe(true);
  expect(fixture.submissions()).toBe(0);
});

test("@operation-recovery terminal history never starts automatic transaction checks", async ({
  page,
}) => {
  await page.clock.install();
  const fixture = await installRecovery(page, { seed: "terminal" });
  await expect(
    page.getByRole("region", { name: "Operation recovery" }),
  ).toContainText("Verified failure", { timeout: 3000 });
  await page.clock.fastForward(65000);
  expect(fixture.checks()).toBe(0);
  expect(fixture.submissions()).toBe(0);
});

test("@operation-recovery lost hash observation reply never reopens the wallet", async ({
  page,
}) => {
  const fixture = await installRecovery(page, { lostHashReply: true });
  await page
    .getByRole("button", { name: "Connect NEAR testnet", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: borrower, exact: true }),
  ).toBeVisible({ timeout: 3000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(proof(page)).toBeEnabled({ timeout: 3000 });
  await proof(page).click();
  await expect.poll(fixture.submissions, { timeout: 3000 }).toBe(1);
  await expect(
    page.getByRole("region", { name: "Operation recovery" }),
  ).toContainText(goodHash, { timeout: 3000 });
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Operation recovery" }),
  ).toContainText(goodHash, { timeout: 3000 });
  expect(fixture.submissions()).toBe(1);
});

test("@release-preparation stopped finality preparation alerts without opening a wallet", async ({
  page,
}) => {
  const fixture = await installRecovery(page, { stoppedRelease: true });
  await page
    .getByRole("button", { name: "Connect NEAR testnet", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: borrower, exact: true }),
  ).toBeVisible({ timeout: 3000 });
  await expect(page.getByTestId("loan-debt")).toHaveText("0 CREDIT");
  await expect(page.getByTestId("settlement-stage")).toHaveText(
    "Signed · awaiting inclusion",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  const release = page.getByRole("button", {
    name: "Release collateral",
    exact: true,
  });
  await expect(release).toBeEnabled({ timeout: 3000 });
  await release.click();
  await expect.poll(fixture.creates, { timeout: 3000 }).toBe(1);
  expect(fixture.submissions()).toBe(0);
  // Regression: the real App currently reports generic success for this failed create.
  await expect(page.getByRole("alert")).toHaveText(finalityDetail, {
    timeout: 2000,
  });
  await expect(
    page.getByRole("status").filter({ hasText: "Operation recorded." }),
  ).toHaveCount(0);
  await expect.poll(fixture.freshReadsAfterCreate, { timeout: 3000 }).toBe(1);
  await expect(release).toBeEnabled({ timeout: 3000 });
  await expect(
    page.getByRole("region", { name: "Operation recovery" }),
  ).toContainText(finalityDetail);
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Operation recovery" }),
  ).toContainText(finalityDetail, { timeout: 3000 });
  expect(fixture.submissions()).toBe(0);
  expect(fixture.creates()).toBe(1);
});

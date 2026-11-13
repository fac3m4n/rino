/** Synthetic SDK/API boundary evidence only; no real Meteor, signing or chain verification. */
import { expect, test, type Page } from "@playwright/test";
import { configFixture, stateFixture } from "../../apps/web/tests/fixtures";

const borrower = "proofcredit-b-2593ce.testnet";
const lender = "proofcredit-l-2593ce.testnet";
const proof = (page: Page) =>
  page.getByRole("button", { name: /^Authenticate collateral/ });
interface Observation {
  connects: number;
  posts: unknown[];
  reads: unknown[];
  confirmations: unknown[];
  submissions: { network: string; signerId: string; receiverId: string }[];
  actualSigners: string[];
}
const observation = (page: Page): Promise<Observation> =>
  page.evaluate(
    () =>
      (globalThis as unknown as { meteorSignerFixture: Observation })
        .meteorSignerFixture,
  );

async function installMeteor(
  page: Page,
  options: {
    selected: string[];
    returnedSigner?: string;
    batch?: boolean;
    reject?: boolean;
  },
) {
  const config = {
    ...configFixture,
    mode: "public",
    near: {
      ...configFixture.near,
      networkId: "testnet",
      borrowerId: borrower,
      lenderId: lender,
    },
  };
  const state = {
    ...stateFixture,
    market: {
      ...stateFixture.market!,
      borrower,
      lender,
      phase: "Offered",
      borrowed_at: null,
      proof_timestamp: null,
      proof_fresh: false,
    },
    proofStatus: "None",
    evidence: null,
  };
  const action = {
    chain: "near",
    receiverId: config.near.controllerId,
    methodName: "authenticate_collateral",
    args: {},
    gas: "100000000000000",
    deposit: "0",
  };
  await page.route("**/api/config*", (r) => r.fulfill({ json: config }));
  await page.route("**/api/state*", (r) => r.fulfill({ json: state }));
  await page.route("**/api/receipts", (r) => r.fulfill({ json: [] }));
  await page.addInitScript(() => {
    Object.assign(globalThis, {
      meteorSignerFixture: {
        connects: 0,
        posts: [],
        reads: [],
        confirmations: [],
        submissions: [],
        actualSigners: [],
      },
    });
  });
  await page.route("**/api/actions", async (r) => {
    expect(r.request().method()).toBe("POST");
    expect(r.request().headers()["x-proofcredit-csrf"]).toBe("ui-fixture-only");
    const body: unknown = r.request().postDataJSON();
    await page.evaluate((body) => {
      (
        globalThis as unknown as { meteorSignerFixture: Observation }
      ).meteorSignerFixture.posts.push(body);
    }, body);
    await r.fulfill({
      json: {
        ok: true,
        message: "Synthetic prepared wallet actions",
        state,
        receiptIds: [],
        walletActions: options.batch ? [action, action] : [action],
      },
    });
  });
  // Keep App.run, useWallets, submissionFailure and actionGuard real. Only the SDK is external.
  await page.route(
    /\/node_modules\/\.vite\/deps\/@hot-labs_near-connect\.js(?:\?|$)/,
    (r) =>
      r.fulfill({
        contentType: "application/javascript",
        body: `
        const options = ${JSON.stringify(options)};
        const borrower = ${JSON.stringify(borrower)};
        const lender = ${JSON.stringify(lender)};
        export class NearConnector {
          listeners = {};
          selected = borrower;
          constructor(config) {
            if (config.network !== 'testnet') throw new Error('Expected testnet');
          }
          on(event, listener) { this.listeners[event] = listener; }
          async connect() {
            this.listeners['wallet:signIn']?.({ accounts: [{ accountId: borrower, publicKey: 'fixture-only' }], success: true, source: 'signIn' });
            globalThis.meteorSignerFixture.connects++;
            return this.wallet();
          }
          async wallet() {
            return {
              manifest: { id: 'meteor-wallet' },
              getAccounts: async (params) => {
                globalThis.meteorSignerFixture.reads.push(params);
                // Imported account insertion order is independent of selected identity.
                return [lender, borrower].map(accountId => ({ accountId, publicKey: 'fixture-only' }));
              },
              signIn: async (params) => {
                globalThis.meteorSignerFixture.confirmations.push(params);
                if (options.reject) throw Object.assign(new Error('Account confirmation rejected'), { code: 4001 });
                this.selected = options.selected[0] ?? '';
                return options.selected.map(accountId => ({ accountId, publicKey: 'fixture-only' }));
              },
              signAndSendTransaction: async (params) => {
                globalThis.meteorSignerFixture.submissions.push(params);
                // Meteor targets its cached signIn selection and ignores params.signerId.
                globalThis.meteorSignerFixture.actualSigners.push(this.selected);
                return { status: { SuccessValue: '' }, transaction: { hash: 'synthetic-meteor-hash', signer_id: options.returnedSigner ?? this.selected }, receipts_outcome: [] };
              },
            };
          }
        }
        // Match Vite's CommonJS optimization shape used by the production dynamic import.
        export default { NearConnector };
      `,
      }),
  );
  await page.goto("/");
  await expect(proof(page)).toBeDisabled({ timeout: 3000 });
  await page
    .getByRole("button", { name: "Connect NEAR testnet", exact: true })
    .click();
  await expect
    .poll(async () => (await observation(page)).connects, { timeout: 3000 })
    .toBe(1);
  await expect(
    page.getByRole("button", { name: borrower, exact: true }),
  ).toBeEnabled({ timeout: 3000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(proof(page)).toBeEnabled({ timeout: 3000 });
}

test.setTimeout(30000);
test("@meteor-signer a second imported borrower reaches one signing request after fresh selected-account confirmation", async ({
  page,
}) => {
  await installMeteor(page, { selected: [borrower] });
  await proof(page).click();
  await expect(page.getByRole("status")).toContainText(
    "Wallet submission returned",
    { timeout: 3000 },
  );
  const observed = await observation(page);
  expect(observed.posts).toEqual([{ action: "prove", role: "borrower" }]);
  expect(observed.reads).toEqual([{ network: "testnet" }]);
  expect(observed.confirmations).toEqual([{ network: "testnet" }]);
  expect(observed.submissions).toHaveLength(1);
  expect(observed.submissions[0]).toMatchObject({
    network: "testnet",
    signerId: borrower,
    receiverId: "controller.test",
  });
  expect(observed.actualSigners).toEqual([borrower]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("@meteor-signer selected lender blocks signing and updates the displayed identity without financial uncertainty", async ({
  page,
}) => {
  await installMeteor(page, { selected: [lender] });
  await proof(page).click();
  await expect(page.getByRole("alert")).toContainText(lender, {
    timeout: 3000,
  });
  await expect(page.getByRole("alert")).toContainText(borrower);
  await expect(
    page.getByRole("button", { name: lender, exact: true }),
  ).toBeEnabled();
  await expect(proof(page)).toBeDisabled();
  await expect(page.locator(".guard-reason")).toContainText(
    /disconnect.*reconnect/i,
  );
  await expect(
    page.getByRole("button", { name: "Continue from checked state" }),
  ).toHaveCount(0);
  expect(await observation(page)).toMatchObject({
    posts: [{ action: "prove", role: "borrower" }],
    confirmations: [{ network: "testnet" }],
    submissions: [],
    actualSigners: [],
  });
});

test("@meteor-signer returned signer mismatch retains the hash, pauses real App actions and stops the batch", async ({
  page,
}) => {
  await installMeteor(page, {
    selected: [borrower],
    returnedSigner: lender,
    batch: true,
  });
  await proof(page).click();
  await expect(page.getByRole("alert")).toContainText("synthetic-meteor-hash", {
    timeout: 3000,
  });
  await expect(page.getByRole("alert")).toContainText(/uncertain/i);
  await expect(page.getByRole("alert")).toContainText(lender);
  await expect(proof(page)).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Continue from checked state" }),
  ).toBeEnabled();
  await expect(page.locator(".guard-reason")).toContainText(/reconcile/i);
  const observed = await observation(page);
  expect(observed.posts).toEqual([{ action: "prove", role: "borrower" }]);
  expect(observed.confirmations).toEqual([{ network: "testnet" }]);
  expect(observed.submissions).toHaveLength(1);
  expect(observed.actualSigners).toEqual([borrower]);
});

test("@meteor-signer rejected account confirmation preserves borrower identity and permits a deliberate retry", async ({
  page,
}) => {
  await installMeteor(page, { selected: [borrower], reject: true });
  await proof(page).click();
  await expect(page.getByRole("alert")).toContainText(
    /confirmation.*rejected/i,
    { timeout: 3000 },
  );
  await expect(
    page.getByRole("button", { name: borrower, exact: true }),
  ).toBeEnabled();
  await expect(proof(page)).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Continue from checked state" }),
  ).toHaveCount(0);
  expect(await observation(page)).toMatchObject({
    posts: [{ action: "prove", role: "borrower" }],
    confirmations: [{ network: "testnet" }],
    submissions: [],
    actualSigners: [],
  });
});

test("@meteor-signer missing confirmed account clears the identity and blocks signing without uncertainty", async ({
  page,
}) => {
  await installMeteor(page, { selected: [] });
  await proof(page).click();
  await expect(page.getByRole("alert")).toContainText("none", {
    timeout: 3000,
  });
  await expect(page.getByRole("alert")).toContainText(borrower);
  await expect(
    page.getByRole("button", { name: "Connect NEAR testnet", exact: true }),
  ).toBeEnabled();
  await expect(proof(page)).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Continue from checked state" }),
  ).toHaveCount(0);
  expect(await observation(page)).toMatchObject({
    confirmations: [{ network: "testnet" }],
    submissions: [],
    actualSigners: [],
  });
});

import { installMarketCatalog } from "./market-fixtures";
import {
  closePanel,
  connectNear,
  openPosition,
  openWallets,
} from "./ui-helpers";
/** Controlled SDK-boundary fixtures only: no real wallet, signing or chain evidence. */
import { expect, test, type Page } from "@playwright/test";
import { configFixture, stateFixture } from "../../apps/web/tests/fixtures";

const borrower = "rino-b-2593ce.testnet";
const lender = "rino-l-2593ce.testnet";
const proof = (page: Page) =>
  page
    .getByRole("dialog", { name: "ETH market", exact: true })
    .getByRole("button", { name: /^Verify collateral/ });
const connected = (page: Page, account: string) =>
  page.getByRole("button", { name: `Wallets: ${account};`, exact: false });

async function installWallet(
  page: Page,
  options: {
    accounts: string[];
    immediateAccount?: string;
    disconnectFailure?: boolean;
  },
) {
  await installMarketCatalog(page, {
    ...configFixture,
    mode: "public",
    near: {
      ...configFixture.near,
      networkId: "testnet",
      borrowerId: borrower,
      lenderId: lender,
    },
  });
  await page.route("**/api/config*", (r) =>
    r.fulfill({
      json: {
        ...configFixture,
        mode: "public",
        near: {
          ...configFixture.near,
          networkId: "testnet",
          borrowerId: borrower,
          lenderId: lender,
        },
      },
    }),
  );
  await page.route("**/api/state*", (r) =>
    r.fulfill({
      json: {
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
      },
    }),
  );
  await page.route("**/api/receipts", (r) => r.fulfill({ json: [] }));
  await page.addInitScript(() => {
    Object.assign(globalThis, {
      nearIdentityFixture: { connects: 0, sends: 0, posts: 0 },
    });
  });
  await page.route("**/api/actions", async (r) => {
    await page.evaluate(() => {
      (
        globalThis as unknown as {
          nearIdentityFixture: { posts: number };
        }
      ).nearIdentityFixture.posts++;
    });
    await r.abort();
  });
  // Replace only the external Vite SDK module. App, useWallets and actionGuard stay real.
  await page.route(
    /\/node_modules\/\.vite\/deps\/@hot-labs_near-connect\.js(?:\?|$)/,
    (r) =>
      r.fulfill({
        contentType: "application/javascript",
        body: `
          const options = ${JSON.stringify(options)};
          export class NearConnector {
            whenManifestLoaded = Promise.resolve();
            availableWallets = [{ manifest: { id: 'generic-wallet', name: 'Controlled wallet' } }];
            listeners = {};
            connections = 0;
            account = '';
            constructor(config) {
              if (config.network !== 'testnet') throw new Error('Expected testnet');
            }
            on(event, listener) { this.listeners[event] = listener; }
            off(event) { delete this.listeners[event]; }
            async connect() {
              this.account = options.accounts[this.connections++];
              if (!this.account) throw new Error('No fixture account available');
              this.listeners['wallet:signIn']?.({
                wallet: await this.wallet(),
                accounts: [{ accountId: this.account, publicKey: 'fixture-only' }],
                success: true,
                source: 'signIn',
              });
              const wallet = await this.wallet();
              globalThis.nearIdentityFixture.connects++;
              return wallet;
            }
            async wallet() {
              return {
                manifest: { id: 'generic-wallet' },
                getAccounts: async ({ network }) => {
                  if (network !== 'testnet') throw new Error('Expected testnet');
                  const accountId = options.immediateAccount ?? this.account;
                  return accountId ? [{ accountId, publicKey: 'fixture-only' }] : [];
                },
                signAndSendTransaction: async () => {
                  globalThis.nearIdentityFixture.sends++;
                  throw new Error('Fixture forbids financial submission');
                },
              };
            }
            async disconnect() {
              if (options.disconnectFailure) throw new Error('Fixture wallet sign-out failed');
              this.account = '';
              this.listeners['wallet:signOut']?.({ success: true });
            }
          }
          // Vite optimizes this CommonJS dependency as a default export object.
          export default { NearConnector };
        `,
      }),
  );
  await page.goto("/app.html");
  await expect(
    page.getByRole("heading", { name: "Connect your loan account" }),
  ).toBeVisible({ timeout: 3000 });
  await expect(
    page.getByRole("button", { name: /^Verify collateral/ }),
  ).toHaveCount(0);
  await connectNear(page, "Controlled wallet");
  // Prove the real App reached and completed SDK connect before identity checks.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              globalThis as unknown as {
                nearIdentityFixture: { connects: number };
              }
            ).nearIdentityFixture.connects,
        ),
      { timeout: 3000 },
    )
    .toBe(1);
  await expect(connected(page, options.accounts[0])).toBeEnabled({
    timeout: 3000,
  });
  if (options.accounts[0] === borrower) await openPosition(page);
  await expect(page.getByRole("alert")).toHaveCount(0);
}

test.setTimeout(30000);
test.afterEach(async ({ page }) => {
  expect(
    await page.evaluate(
      () =>
        (
          globalThis as unknown as {
            nearIdentityFixture: { sends: number; posts: number };
          }
        ).nearIdentityFixture,
    ),
  ).toMatchObject({ sends: 0, posts: 0 });
});

test("@near-identity connected borrower is fully visible and can authenticate without submitting", async ({
  page,
}) => {
  await installWallet(page, { accounts: [borrower] });
  await expect(connected(page, borrower)).toBeVisible({ timeout: 3000 });
  await expect(proof(page)).toBeEnabled({ timeout: 3000 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

for (const immediateAccount of ["", lender])
  test(`@near-identity successful signIn borrower survives ${immediateAccount ? "stale" : "empty"} immediate account read`, async ({
    page,
  }) => {
    await installWallet(page, { accounts: [borrower], immediateAccount });
    await expect(proof(page)).toBeEnabled({ timeout: 3000 });
    await expect(connected(page, borrower)).toBeVisible({ timeout: 3000 });
  });

test("@near-identity wrong lender stays blocked and explicit disconnect/reconnect selects borrower", async ({
  page,
}) => {
  await installWallet(page, { accounts: [lender, borrower] });
  await expect(connected(page, lender)).toBeVisible({ timeout: 3000 });
  await expect(
    page.getByRole("button", { name: /^Verify collateral/ }),
  ).toHaveCount(0);
  await openWallets(page);
  await page
    .getByText("Account required for this position", { exact: true })
    .click();
  const reason = page.getByRole("dialog", { name: "Wallets", exact: true });
  await expect(reason).toContainText(lender);
  await expect(reason).toContainText(borrower);
  await expect(reason).toContainText(/disconnect.*select.*required account/i);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Disconnect NEAR", exact: true })
    .click();
  await expect(connected(page, lender)).toHaveCount(0, { timeout: 3000 });
  await expect(
    page.getByRole("button", { name: /^Verify collateral/ }),
  ).toHaveCount(0);
  await expect(reason).toContainText(borrower);
  await expect(reason).toContainText("NEAR testnet");
  await page.getByRole("button", { name: "Connect NEAR", exact: true }).click();
  await page
    .getByRole("button", { name: "Controlled wallet", exact: true })
    .click();
  await expect(connected(page, borrower)).toBeVisible({ timeout: 3000 });
  await closePanel(page);
  await openPosition(page);
  await expect(proof(page)).toBeEnabled({ timeout: 3000 });
});

test("@near-identity failed explicit disconnect reports failure and preserves connected borrower", async ({
  page,
}) => {
  await installWallet(page, { accounts: [borrower], disconnectFailure: true });
  await expect(connected(page, borrower)).toBeVisible({ timeout: 3000 });
  await openWallets(page);
  await page
    .getByRole("button", { name: "Disconnect NEAR", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Fixture wallet sign-out failed",
    { timeout: 3000 },
  );
  await expect(connected(page, borrower)).toBeVisible();
  await closePanel(page);
  await openPosition(page);
  await expect(proof(page)).toBeEnabled();
});

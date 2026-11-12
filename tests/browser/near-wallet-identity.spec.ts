/** Controlled SDK-boundary fixtures only: no real wallet, signing or chain evidence. */
import { expect, test, type Page } from "@playwright/test";
import { configFixture, stateFixture } from "../../apps/web/tests/fixtures";

const borrower = "proofcredit-b-2593ce.testnet";
const lender = "proofcredit-l-2593ce.testnet";
const proof = (page: Page) =>
  page.getByRole("button", { name: /^Authenticate collateral/ });
const connected = (page: Page, account: string) =>
  page.getByRole("button", { name: account, exact: true });

async function installWallet(
  page: Page,
  options: {
    accounts: string[];
    immediateAccount?: string;
    disconnectFailure?: boolean;
  },
) {
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
            listeners = {};
            connections = 0;
            account = '';
            constructor(config) {
              if (config.network !== 'testnet') throw new Error('Expected testnet');
            }
            on(event, listener) { this.listeners[event] = listener; }
            async connect() {
              this.account = options.accounts[this.connections++];
              if (!this.account) throw new Error('No fixture account available');
              this.listeners['wallet:signIn']?.({
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
  await page.goto("/");
  await expect(proof(page)).toBeDisabled({ timeout: 3000 });
  await page
    .getByRole("button", { name: "Connect NEAR testnet", exact: true })
    .click();
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
  await expect(page.locator(".wallet-controls button").first()).toBeEnabled({
    timeout: 3000,
  });
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
  await expect(proof(page)).toBeDisabled();
  const reason = page.locator(".guard-reason");
  await expect(reason).toContainText(lender);
  await expect(reason).toContainText(borrower);
  await expect(reason).toContainText(/disconnect.*reconnect/i);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Disconnect NEAR", exact: true })
    .click();
  await expect(connected(page, lender)).toHaveCount(0, { timeout: 3000 });
  await expect(proof(page)).toBeDisabled();
  await expect(reason).toContainText(`Connect ${borrower} on NEAR testnet`);
  await page
    .getByRole("button", { name: "Connect NEAR testnet", exact: true })
    .click();
  await expect(connected(page, borrower)).toBeVisible({ timeout: 3000 });
  await expect(proof(page)).toBeEnabled({ timeout: 3000 });
});

test("@near-identity failed explicit disconnect reports failure and preserves connected borrower", async ({
  page,
}) => {
  await installWallet(page, { accounts: [borrower], disconnectFailure: true });
  await expect(connected(page, borrower)).toBeVisible({ timeout: 3000 });
  await page
    .getByRole("button", { name: "Disconnect NEAR", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Fixture wallet sign-out failed",
    { timeout: 3000 },
  );
  await expect(connected(page, borrower)).toBeVisible();
  await expect(proof(page)).toBeEnabled();
});

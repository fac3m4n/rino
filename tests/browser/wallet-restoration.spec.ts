/** Controlled SDK/provider boundaries; real App, hook and guards, no signing. */
import { expect, test, type Page } from "@playwright/test";
import { configFixture, stateFixture } from "../../apps/web/tests/fixtures";
const borrower = "proofcredit-b-2593ce.testnet";
const lender = "proofcredit-l-2593ce.testnet";
const evm = "0x1111111111111111111111111111111111111111";
const hintKey = "proofcredit.wallet.near.v1";
const connected = (page: Page) =>
  page.getByRole("button", { name: borrower, exact: true });
const prove = (page: Page) =>
  page.getByRole("button", { name: /^Authenticate collateral/ });
const fund = (page: Page) => page.getByRole("button", { name: /^Fund vault/ });
async function install(page: Page, funded = true, restoreMode = "success") {
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
        ethereum: {
          ...stateFixture.ethereum!,
          vaultBalanceWei: funded ? "120000000000000000" : "1",
        },
      },
    }),
  );
  await page.route("**/api/receipts*", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/actions", (r) => r.abort());
  await page.addInitScript(
    ({ borrower, evm }) => {
      const counters = {
        connects: 0,
        signIns: 0,
        sends: 0,
        restores: 0,
        accounts: 0,
        requests: [] as string[],
        options: [] as unknown[],
      };
      const listeners: Record<string, (data: unknown) => void> = {};
      Object.assign(globalThis, {
        restoreFixture: counters,
        ethereum: {
          on(name: string, cb: (data: unknown) => void) {
            listeners[name] = cb;
          },
          removeListener(name: string) {
            delete listeners[name];
          },
          async request({ method }: { method: string }) {
            counters.requests.push(method);
            if (method === "eth_requestAccounts") {
              localStorage.setItem("fixture.evm.authorized", evm);
              listeners["accountsChanged"]?.([evm]);
              return [evm];
            }
            if (method === "eth_accounts")
              return localStorage.getItem("fixture.evm.authorized")
                ? [evm]
                : [];
            if (method === "eth_chainId") return "0xaa36a7";
            counters.sends++;
            throw new Error(`Forbidden RPC ${method}`);
          },
        },
        fixtureBorrower: borrower,
      });
    },
    { borrower, evm },
  );
  await page.route(
    /\/node_modules\/\.vite\/deps\/@hot-labs_near-connect\.js(?:\?|$)/,
    (r) =>
      r.fulfill({
        contentType: "application/javascript",
        body: `
    const borrower = ${JSON.stringify(borrower)}, lender = ${JSON.stringify(lender)}, restoreMode = ${JSON.stringify(restoreMode)};
    export class NearConnector {
      listeners = {};
      constructor(options) { globalThis.restoreFixture.options.push(options); }
      on(name, cb) { this.listeners[name] = cb; }
      off(name, cb) { if (this.listeners[name] === cb) delete this.listeners[name]; }
      async connect() {
        globalThis.restoreFixture.connects++;
        const wallet = await this.wallet();
        const accounts = await wallet.signIn({ network: 'testnet' });
        localStorage.setItem('fixture.near.authorized', borrower);
        this.listeners['wallet:signIn']?.({ wallet, accounts, success: true, source: 'signIn' });
        return wallet;
      }
      async getConnectedWallet() {
        globalThis.restoreFixture.restores++;
        if (restoreMode === 'hang') await new Promise(() => {});
        if (restoreMode === 'reject') throw new Error('Wallet unavailable');
        if (!localStorage.getItem('fixture.near.authorized')) throw new Error('Not authorized');
        const wallet = await this.wallet();
        return { wallet, accounts: restoreMode === 'revoked' ? [{ accountId: lender, publicKey: 'ed25519:fixture' }] : await wallet.getAccounts({ network: 'testnet' }) };
      }
      async wallet() { return {
        manifest: { id: 'meteor-wallet' },
        getAccounts: async () => { globalThis.restoreFixture.accounts++; return [lender, borrower].map(accountId => ({ accountId, publicKey: 'ed25519:fixture' })); },
        signIn: async () => { globalThis.restoreFixture.signIns++; return [{ accountId: borrower, publicKey: 'ed25519:fixture' }]; },
        signAndSendTransaction: async () => { globalThis.restoreFixture.sends++; throw new Error('Forbidden signing'); },
      }; }
      async disconnect() { localStorage.removeItem('fixture.near.authorized'); this.listeners['wallet:signOut']?.({ success: true }); }
    }
    export default { NearConnector };
  `,
      }),
  );
  await page.goto("/");
}
async function counters(page: Page) {
  return page.evaluate(
    () =>
      (
        globalThis as unknown as {
          restoreFixture: {
            connects: number;
            signIns: number;
            sends: number;
            restores: number;
            accounts: number;
            requests: string[];
            options: { autoConnect: boolean }[];
          };
        }
      ).restoreFixture,
  );
}
async function connectNear(page: Page) {
  await page
    .getByRole("button", { name: "Connect NEAR testnet", exact: true })
    .click();
  await expect
    .poll(async () => (await counters(page)).connects, { timeout: 3000 })
    .toBe(1);
  await expect(connected(page)).toBeVisible({ timeout: 3000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
}
test.setTimeout(20000);
test("@wallet-restore-red reload restores exact second imported NEAR account without prompting", async ({
  page,
}) => {
  await install(page);
  await connectNear(page);
  await expect(prove(page)).toBeEnabled({ timeout: 3000 });
  await page.reload();
  await expect(connected(page)).toBeVisible({ timeout: 3000 });
  await expect(prove(page)).toBeEnabled();
  expect(await counters(page)).toMatchObject({
    connects: 0,
    signIns: 0,
    sends: 0,
    restores: 1,
  });
  expect((await counters(page)).options).toEqual([
    expect.objectContaining({ autoConnect: false }),
  ]);
});
test("@wallet-restore-red reload restores authorized Ethereum funding without requesting permission", async ({
  page,
}) => {
  await install(page, false);
  await page
    .getByRole("button", { name: "Connect Ethereum wallet", exact: true })
    .click();
  await expect(fund(page)).toBeEnabled({ timeout: 3000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect((await counters(page)).requests).toContain("eth_requestAccounts");
  await page.reload();
  await expect(fund(page)).toBeEnabled({ timeout: 3000 });
  expect((await counters(page)).requests).toEqual([
    "eth_accounts",
    "eth_chainId",
  ]);
  expect((await counters(page)).sends).toBe(0);
});
test("@wallet-restore successful disconnect remains disconnected after reload", async ({
  page,
}) => {
  await install(page);
  await connectNear(page);
  await page
    .getByRole("button", { name: "Disconnect NEAR", exact: true })
    .click();
  await page.reload();
  await expect(prove(page)).toBeDisabled({ timeout: 3000 });
  await expect(connected(page)).toHaveCount(0);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), hintKey),
  ).toBeNull();
  expect(await counters(page)).toMatchObject({
    connects: 0,
    signIns: 0,
    sends: 0,
    restores: 0,
  });
});

for (const bad of [
  null,
  "{broken",
  JSON.stringify({
    version: 2,
    networkId: "testnet",
    walletId: "meteor-wallet",
    accountId: borrower,
  }),
  JSON.stringify({
    version: 1,
    networkId: "mainnet",
    walletId: "meteor-wallet",
    accountId: borrower,
  }),
])
  test(`@wallet-restore invalid or absent hint never guesses imported identity (${bad})`, async ({
    page,
  }) => {
    await install(page);
    await connectNear(page);
    await page.evaluate(
      ({ key, bad }) =>
        bad === null
          ? localStorage.removeItem(key)
          : localStorage.setItem(key, bad),
      { key: hintKey, bad },
    );
    await page.reload();
    await expect(prove(page)).toBeDisabled({ timeout: 3000 });
    await expect(connected(page)).toHaveCount(0);
    expect(await counters(page)).toMatchObject({
      connects: 0,
      signIns: 0,
      sends: 0,
      restores: 0,
    });
  });
for (const mode of ["revoked", "reject", "hang"])
  test(`@wallet-restore failed NEAR ${mode} does not prevent independent Ethereum restore`, async ({
    page,
  }) => {
    await install(page, false, mode);
    await connectNear(page);
    await page
      .getByRole("button", { name: "Connect Ethereum wallet", exact: true })
      .click();
    await expect(fund(page)).toBeEnabled({ timeout: 3000 });
    await page.reload();
    await expect(fund(page)).toBeEnabled({ timeout: 3000 });
    await expect(connected(page)).toHaveCount(0);
    expect(await counters(page)).toMatchObject({
      connects: 0,
      signIns: 0,
      sends: 0,
    });
    expect((await counters(page)).requests).toEqual([
      "eth_accounts",
      "eth_chainId",
    ]);
  });

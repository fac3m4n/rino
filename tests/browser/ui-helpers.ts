import { expect, type Locator, type Page } from "@playwright/test";

/** Use the real screens/review boundary; these helpers never invoke App internals. */
export async function closePanel(page: Page) {
  const close = page
    .getByRole("dialog")
    .getByRole("button", { name: "Close panel", exact: true });
  if (await close.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  }
}
export async function openWallets(page: Page) {
  await closePanel(page);
  await page
    .getByRole("button", { name: /^(Connect wallet|Wallets:)/ })
    .first()
    .click();
  await expect(
    page.getByRole("dialog", { name: "Wallets", exact: true }),
  ).toBeVisible();
}
export async function localActor(page: Page, role: "Borrower" | "Lender") {
  await openWallets(page);
  await page.getByRole("button", { name: role, exact: true }).click();
  await closePanel(page);
  await page
    .getByRole("button", {
      name: role === "Lender" ? "Lend" : "Dashboard",
      exact: true,
    })
    .click();
}
export async function openPosition(page: Page) {
  await closePanel(page);
  if (
    !(await page
      .getByRole("combobox", { name: "Filter positions" })
      .isVisible())
  )
    await page.getByRole("button", { name: "Dashboard", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Filter positions" })
    .selectOption("all");
  await page
    .getByRole("button", { name: /ETH market/ })
    .first()
    .click();
  await expect(
    page.getByRole("dialog", { name: "ETH market", exact: true }),
  ).toBeVisible();
}
export async function openEvidence(page: Page) {
  await closePanel(page);
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page
    .getByRole("button", { name: "View all evidence", exact: true })
    .click();
}
export async function openRecovery(page: Page) {
  await closePanel(page);
  const check = page
    .getByRole("button", { name: "Check request", exact: true })
    .first();
  if (await check.isVisible()) await check.click();
  else {
    await openPosition(page);
    await page.getByText("Vault & verification", { exact: true }).click();
    await page
      .getByRole("button", { name: "Request recovery", exact: true })
      .click();
  }
  await expect(
    page.getByRole("dialog", { name: "Request recovery", exact: true }),
  ).toBeVisible();
}
export async function submitReviewed(page: Page, action: Locator) {
  await action.click();
  const confirm = page.getByRole("button", {
    name: "Confirm action",
    exact: true,
  });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  // Financial work remains attached to the original mounted workspace after dismissal.
  await closePanel(page);
}
export async function connectNear(page: Page, walletName = "Meteor") {
  await openWallets(page);
  await page.getByRole("button", { name: "Connect NEAR", exact: true }).click();
  await page.getByRole("button", { name: walletName, exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Choose account", exact: true }),
  ).toBeVisible();
  await closePanel(page);
}
export async function connectEthereum(page: Page) {
  await openWallets(page);
  await page
    .getByRole("button", { name: "Connect Ethereum", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Choose Ethereum account", exact: true }),
  ).toBeVisible();
  await closePanel(page);
}

/** Restored participant scope for transport/layout fixtures. Never used by identity tests. */
export async function installReadOnlyNearParticipant(
  page: Page,
  accountId = "borrower.test",
) {
  await page.addInitScript((accountId) => {
    localStorage.setItem(
      "rino.wallet.near.v1",
      JSON.stringify({
        version: 1,
        networkId: "testnet",
        walletId: "read-only-fixture",
        accountId,
      }),
    );
  }, accountId);
  await page.route(
    /\/node_modules\/\.vite\/deps\/@hot-labs_near-connect\.js(?:\?|$)/,
    (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `const accountId=${JSON.stringify(accountId)};export class NearConnector{on(){}off(){}async getConnectedWallet(){return{wallet:{manifest:{id:'read-only-fixture'},getAccounts:async()=>[{accountId,publicKey:'ed25519:fixture'}],signAndSendTransaction:async()=>{throw Error('Read-only participant fixture forbids signing')}},accounts:[{accountId,publicKey:'ed25519:fixture'}]}}}export default{NearConnector};`,
      }),
  );
}

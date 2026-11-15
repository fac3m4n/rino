import {
  installReadOnlyNearParticipant,
  submitReviewed,
  openRecovery,
  openEvidence,
  closePanel,
  connectNear,
} from "./ui-helpers";
import { installMarketCatalog } from "./market-fixtures";
/** Real App/client/guards with controlled transport and wallet boundaries; not chain evidence. */
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  configFixture,
  stateFixture,
  operationFixture,
} from "../../apps/web/tests/fixtures";
import { ACTION_TIMEOUT_MS } from "../../apps/web/src/client";
import type { OperationView } from "@rino/coordinator/api";

test.setTimeout(20000);
test.use({ actionTimeout: 3000 });
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-13T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-13T00:00:01Z"));
  await page.route("https://**", (r) => r.abort());
});
const toast = (page: Page) =>
  page.getByRole("region", { name: "Feedback", exact: true });
const repay = (page: Page) =>
  page.getByRole("button", { name: "Repay loan", exact: true });
async function local(page: Page) {
  let reads = 0,
    posts = 0;
  await installMarketCatalog(page, configFixture);
  await page.route("**/api/config*", (r) => {
    reads++;
    return r.fulfill({ json: configFixture });
  });
  await page.route("**/api/state*", (r) => {
    reads++;
    return r.fulfill({ json: stateFixture });
  });
  await page.route("**/api/receipts*", (r) => {
    reads++;
    return r.fulfill({ json: [] });
  });
  await page.route("**/api/actions", () => {
    posts++;
  });
  return { reads: () => reads, posts: () => posts };
}
// Catches falsely labeling an unknown initial environment and enabling actions before data.
test("@feedback initial snapshot stays unknown with accessible loading until delivered", async ({
  page,
}) => {
  await local(page);
  let config: Route | undefined;
  await page.route("**/api/config*", (r) => {
    config = r;
  });
  await page.goto("/app.html");
  await expect(
    page.getByRole("heading", { name: "Dashboard", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Network details", exact: true }),
  ).toContainText("Connecting");
  await expect(repay(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Confirm action", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Connect wallet", exact: true }).first(),
  ).toBeVisible();
  await expect.poll(() => !!config, { timeout: 3000 }).toBe(true);
  await config!.fulfill({ json: configFixture });
  await expect(repay(page)).toBeEnabled({ timeout: 3000 });
  await expect(
    page.getByRole("button", { name: "Loading", exact: true }),
  ).toHaveCount(0);
});
// Catches stacked routine feedback, lost message evidence and a duplicate live announcement source.
test("@feedback routine info uses one concise visible announcement surface", async ({
  page,
}) => {
  await local(page);
  let posts = 0;
  await page.route("**/api/actions", (r) => {
    posts++;
    return r.fulfill({
      json: {
        ok: true,
        state: stateFixture,
        message: "Fixture recorded",
        receiptIds: [],
      },
    });
  });
  await page.goto("/app.html");
  await expect(repay(page)).toBeEnabled({ timeout: 3000 });
  await submitReviewed(page, repay(page));
  await expect(toast(page)).toBeVisible({ timeout: 3000 });
  await expect(repay(page)).toBeEnabled({ timeout: 3000 });
  const feedbackSurfaces = await page
    .locator(
      '[role="status"]:visible, [role="region"][aria-label="Feedback"]:visible',
    )
    .evaluateAll(
      (elements) =>
        elements.filter(
          (el) =>
            !el.parentElement?.closest(
              '[role="status"], [role="region"][aria-label="Feedback"]',
            ),
        ).length,
    );
  expect(feedbackSurfaces).toBe(1);
  await expect(toast(page).getByRole("status")).toHaveText("Fixture recorded");
  await expect(page.getByText("Fixture recorded", { exact: true })).toHaveCount(
    1,
  );
  await expect(toast(page).locator("p")).toHaveCount(0);
  await toast(page)
    .getByRole("button", { name: "Dismiss notification" })
    .click();
  await expect(page.getByText("Fixture recorded", { exact: true })).toHaveCount(
    0,
  );
  await expect(repay(page)).toBeEnabled();
  await expect(page.getByTestId("loan-debt")).toHaveText("101 CREDIT");
  expect(posts).toBe(1);
});
// Catches dismiss clearing pending, phase not following existing await boundaries or duplicate POSTs.
test("@feedback pending progress dismissal never enables a second submission", async ({
  page,
}) => {
  await local(page);
  let actionPosts = 0;
  let held: Route | undefined,
    finalRead: Route | undefined,
    action: Route | undefined,
    hold = false;
  await page.route("**/api/state*", (r) => {
    if (hold) {
      if (!held) held = r;
      else finalRead = r;
      return;
    }
    return r.fulfill({ json: stateFixture });
  });
  await page.route("**/api/actions", (r) => {
    actionPosts++;
    action = r;
  });
  await page.goto("/app.html");
  await expect(repay(page)).toBeEnabled({ timeout: 3000 });
  hold = true;
  await submitReviewed(page, repay(page));
  await expect(toast(page)).toContainText("Checking fresh state", {
    timeout: 3000,
  });
  await held!.fulfill({ json: stateFixture });
  await expect(toast(page)).toContainText("Preparing request", {
    timeout: 3000,
  });
  await toast(page)
    .getByRole("button", { name: "Dismiss notification" })
    .click();
  await expect(toast(page)).toHaveCount(0);
  await expect(page.locator(".positions-table .row-action")).toBeDisabled();
  expect(actionPosts).toBe(1);
  await expect.poll(() => !!action, { timeout: 3000 }).toBe(true);
  await action!.fulfill({
    json: {
      ok: true,
      state: stateFixture,
      message: "Fixture recorded",
      receiptIds: [],
    },
  });
  await expect(toast(page)).toContainText("Refreshing results", {
    timeout: 3000,
  });
  await expect.poll(() => !!finalRead, { timeout: 3000 }).toBe(true);
  await finalRead!.fulfill({ json: stateFixture });
  await expect(repay(page)).toBeEnabled({ timeout: 3000 });
  expect(actionPosts).toBe(1);
});
// Catches timer-driven loss of persistent failure/recovery or dismissal changing guards.
test("@feedback errors and unknown outcomes survive timeout and toast dismissal", async ({
  page,
}) => {
  const f = await local(page);
  await page.goto("/app.html");
  await expect(repay(page)).toBeEnabled({ timeout: 3000 });
  await submitReviewed(page, repay(page));
  await expect.poll(f.posts, { timeout: 3000 }).toBe(1);
  await page.clock.fastForward(ACTION_TIMEOUT_MS + 1);
  await expect(toast(page)).toContainText(/uncertain|unknown/i, {
    timeout: 3000,
  });
  await expect(repay(page)).toHaveCount(0, { timeout: 3000 });
  await page.clock.fastForward(6001);
  await expect(toast(page)).toBeVisible({ timeout: 3000 });
  await toast(page)
    .getByRole("button", { name: "Dismiss notification" })
    .click();
  await expect(page.getByRole("alert")).toContainText(/uncertain/i);
  await openRecovery(page);
  await expect(
    page.getByRole("button", { name: "Refresh chain state", exact: true }),
  ).toBeVisible();
  await expect(repay(page)).toHaveCount(0);
  expect(f.posts()).toBe(1);
});
// Catches premature expiration, timer restart on hover/focus changes, or UI-driven reads.
test("@feedback informational toast expires at six seconds and pauses on hover and focus", async ({
  page,
}) => {
  const f = await local(page);
  let posts = 0;
  await page.route("**/api/actions", (r) => {
    posts++;
    return r.fulfill({
      json: {
        ok: true,
        state: stateFixture,
        message: "Fixture recorded",
        receiptIds: [],
      },
    });
  });
  await page.goto("/app.html");
  await expect(repay(page)).toBeEnabled({ timeout: 3000 });
  await submitReviewed(page, repay(page));
  await expect(toast(page)).toContainText("Fixture recorded", {
    timeout: 3000,
  });
  await page.clock.fastForward(2000);
  await toast(page).hover();
  await page.clock.fastForward(10000);
  await expect(toast(page)).toBeVisible();
  await toast(page)
    .getByRole("button", { name: "Dismiss notification" })
    .focus();
  await page.mouse.move(0, 0);
  await page.clock.fastForward(10000);
  await expect(toast(page)).toBeVisible();
  await page.getByRole("button", { name: /Switch to dark theme/ }).focus();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const reads = f.reads();
  await page.getByRole("button", { name: /Switch to dark theme/ }).click();
  await page.mouse.move(0, 0);
  await page.getByRole("button", { name: /Switch to light theme/ }).blur();
  await page.clock.fastForward(3999);
  await expect(toast(page)).toBeVisible();
  await page.clock.fastForward(1);
  await expect(toast(page)).toHaveCount(0, { timeout: 3000 });
  expect(posts).toBe(1);
  expect(f.reads()).toBe(reads);
  await submitReviewed(page, repay(page));
  await expect(toast(page)).toContainText("Fixture recorded", {
    timeout: 3000,
  });
  await toast(page)
    .getByRole("button", { name: "Dismiss notification" })
    .click();
  await submitReviewed(page, repay(page));
  await expect(toast(page)).toContainText("Fixture recorded", {
    timeout: 3000,
  });
  expect(posts).toBe(3);
});

// Catches wallet metadata promoted to successful release and history erased after final false callbacks.
test("@feedback wallet return stays neutral and final false callback never claims success", async ({
  page,
}) => {
  let op: OperationView | undefined,
    creates = 0,
    wallets = 0,
    checks = 0,
    observations = 0,
    operationPosts = 0;
  let releaseWallet: (() => void) | undefined;
  const config = {
    ...configFixture,
    mode: "public",
    capabilities: { operations: true },
    near: { ...configFixture.near, networkId: "testnet" },
  };
  await installMarketCatalog(page, config);
  await page.route("**/api/config*", (r) => r.fulfill({ json: config }));
  await page.route("**/api/state*", (r) => r.fulfill({ json: stateFixture }));
  await page.route("**/api/receipts*", (r) => r.fulfill({ json: [] }));
  await page.exposeFunction("feedbackWallet", async () => {
    wallets++;
    await new Promise<void>((resolve) => {
      releaseWallet = resolve;
    });
  });
  await page.route(
    /\/node_modules\/\.vite\/deps\/@hot-labs_near-connect\.js(?:\?|$)/,
    (r) =>
      r.fulfill({
        contentType: "application/javascript",
        body: `
    export class NearConnector {
      whenManifestLoaded = Promise.resolve();
      availableWallets = [{manifest:{id:"meteor-wallet",name:"Meteor"}}];
      listeners = {}; on(n,cb){this.listeners[n]=cb} off(n){delete this.listeners[n]}
      async getConnectedWallet(){throw Error('not connected')}
      async connect(){const wallet=await this.wallet();this.listeners['wallet:signIn']?.({wallet,accounts:await wallet.getAccounts(),success:true,source:'signIn'});return wallet}
      async wallet(){return {manifest:{id:'meteor-wallet'},getAccounts:async()=>[{accountId:'borrower.test',publicKey:'ed25519:fixture'}],signIn:async()=>[{accountId:'borrower.test',publicKey:'ed25519:fixture'}],signAndSendTransaction:async()=>{await globalThis.feedbackWallet();return {status:{SuccessValue:'dHJ1ZQ=='},transaction:{hash:'11111111111111111111111111111111',signer_id:'borrower.test'},receipts_outcome:[]}}}}
    } export default { NearConnector };`,
      }),
  );
  await page.route("**/api/operations**", async (r) => {
    if (r.request().method() === "GET")
      return r.fulfill({ json: op ? [op] : [] });
    operationPosts++;
    const path = new URL(r.request().url()).pathname,
      body = r.request().postDataJSON();
    if (path === "/api/operations") {
      creates++;
      op = {
        ...operationFixture,
        id: body.id,
        action: "repay",
        stage: "awaiting-wallet",
        unresolved: false,
        steps: [
          {
            ...operationFixture.steps[0],
            method: "repay",
            started: false,
            status: "prepared",
            hashes: [],
          },
        ],
      };
      return r.fulfill({
        json: {
          operation: op,
          walletActions: [
            {
              chain: "near",
              receiverId: config.near.controllerId,
              methodName: "repay",
              args: {},
              gas: "100000000000000",
              deposit: "1",
            },
          ],
        },
      });
    }
    if (path.endsWith("/observe")) {
      observations++;
      op = {
        ...op!,
        unresolved: true,
        stage: "needs-check",
        steps: [
          {
            ...op!.steps[0],
            started: true,
            status: "needs-check",
            hashes: body.hash
              ? [
                  {
                    hash: body.hash,
                    status: "hint",
                    detail: "Wallet metadata only",
                  },
                ]
              : [],
          },
        ],
      };
      return r.fulfill({ json: op });
    }
    if (path.endsWith("/reconcile")) {
      checks++;
      op = {
        ...op!,
        unresolved: false,
        stage: "failed",
        detail: "Final callback returned false.",
        steps: [
          {
            ...op!.steps[0],
            status: "failed",
            hashes: [
              {
                hash: "11111111111111111111111111111111",
                status: "failed",
                detail: "Final callback returned false.",
              },
            ],
          },
        ],
      };
      return r.fulfill({ json: op });
    }
    throw Error(`Unexpected operation route ${path}`);
  });
  await page.goto("/app.html");
  await connectNear(page);
  await expect(repay(page)).toBeEnabled({ timeout: 3000 });
  await submitReviewed(page, repay(page));
  await expect.poll(() => wallets, { timeout: 3000 }).toBe(1);
  await expect(toast(page)).toContainText(
    "Waiting for wallet approval or evidence",
    { timeout: 3000 },
  );
  await toast(page)
    .getByRole("button", { name: "Dismiss notification" })
    .click();
  await expect(page.locator(".positions-table .row-action")).toBeDisabled();
  expect({ creates, wallets, observations, operationPosts }).toEqual({
    creates: 1,
    wallets: 1,
    observations: 1,
    operationPosts: 2,
  });
  releaseWallet!();
  await expect(toast(page)).toContainText(
    /Checking transaction|Request recorded|Request needs checking/,
    { timeout: 3000 },
  );
  await expect(repay(page)).toHaveCount(0);
  await openRecovery(page);
  await page
    .getByRole("button", { name: "Check operation", exact: true })
    .click();
  await expect(toast(page)).toContainText("Operation unsuccessful", {
    timeout: 3000,
  });
  await page.clock.fastForward(6001);
  await expect(toast(page)).toBeVisible();
  const recovery = page.getByRole("region", { name: "Operation recovery" });
  await recovery.locator(".operation-record > summary").click();
  await expect(recovery).toContainText("Final callback returned false.");
  await expect(page.getByTestId("loan-debt")).toHaveText("101 CREDIT");
  await expect(
    page.getByText(/Loan closed|Collateral released/, { exact: true }),
  ).toHaveCount(0);
  expect({ creates, wallets, checks, observations, operationPosts }).toEqual({
    creates: 1,
    wallets: 1,
    checks: 1,
    observations: 2,
    operationPosts: 4,
  });
});

// Catches lost partial history, UI-only events starting reads and hidden/offline retry storms.
test("@feedback hidden offline partial recovery and UI interactions keep read budgets", async ({
  page,
}) => {
  let reads = 0,
    posts = 0,
    walletCalls = 0;
  await page.addInitScript(() => {
    let visible = true,
      online = true;
    Object.defineProperty(document, "visibilityState", {
      get: () => (visible ? "visible" : "hidden"),
    });
    Object.defineProperty(navigator, "onLine", { get: () => online });
    Object.assign(globalThis, {
      feedbackEnvironment: (v: boolean, o: boolean) => {
        visible = v;
        online = o;
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event(o ? "online" : "offline"));
      },
      ethereum: {
        on() {},
        removeListener() {},
        async request({ method }: { method: string }) {
          if (method === "eth_accounts") return [];
          await (
            globalThis as unknown as {
              feedbackUnexpectedWallet(): Promise<void>;
            }
          ).feedbackUnexpectedWallet();
          throw Error("Unexpected wallet request");
        },
      },
    });
  });
  await page.exposeFunction("feedbackUnexpectedWallet", () => walletCalls++);
  const partial: OperationView = {
    ...operationFixture,
    action: "fund",
    stage: "partial",
    detail: "First transfer verified; next outcome unknown.",
    steps: [
      {
        ...operationFixture.steps[0],
        status: "succeeded",
        hashes: [
          {
            hash: "11111111111111111111111111111111",
            status: "succeeded",
            detail: "First transfer independently verified.",
          },
        ],
      },
      {
        ...operationFixture.steps[0],
        index: 1,
        method: "fund_liquidity",
        status: "needs-check",
        hashes: [],
      },
    ],
  };
  await installMarketCatalog(page, {
    ...configFixture,
    mode: "public",
    capabilities: { operations: true },
    near: { ...configFixture.near, networkId: "testnet" },
  });
  await page.route("**/api/config*", (r) => {
    reads++;
    return r.fulfill({
      json: {
        ...configFixture,
        mode: "public",
        capabilities: { operations: true },
        near: { ...configFixture.near, networkId: "testnet" },
      },
    });
  });
  await page.route("**/api/state*", (r) => {
    reads++;
    return r.fulfill({ json: stateFixture });
  });
  await page.route("**/api/receipts*", (r) => {
    reads++;
    return r.fulfill({ json: [] });
  });
  await page.route("**/api/operations**", (r) => {
    if (r.request().method() !== "GET") {
      posts++;
      return r.abort();
    }
    reads++;
    return r.fulfill({ json: [partial] });
  });
  await page.route("**/api/actions", (r) => {
    posts++;
    return r.abort();
  });
  await installReadOnlyNearParticipant(page);
  await page.goto("/app.html");
  await expect(toast(page)).toContainText(
    /Checking transaction|Request needs checking/,
    {
      timeout: 3000,
    },
  );
  await expect(repay(page)).toHaveCount(0);
  const environment = (visible: boolean, online: boolean) =>
    page.evaluate(
      ([v, o]) =>
        (
          globalThis as unknown as {
            feedbackEnvironment(v: boolean, o: boolean): void;
          }
        ).feedbackEnvironment(v, o),
      [visible, online],
    );
  await environment(false, true);
  const baseline = reads;
  await page.getByRole("button", { name: /Switch to dark theme/ }).focus();
  await page.keyboard.press("Enter");
  await toast(page)
    .getByRole("button", { name: "Dismiss notification" })
    .click();
  await openEvidence(page);
  await page.keyboard.press("Escape");
  await page.clock.runFor(120000);
  expect(reads).toBe(baseline);
  await environment(true, false);
  await page.clock.runFor(120000);
  expect(reads).toBe(baseline);
  await openRecovery(page);
  await expect(
    page.getByRole("region", { name: "Operation recovery" }),
  ).toContainText("First transfer verified; next outcome unknown.");
  await expect(repay(page)).toHaveCount(0);
  await environment(true, true);
  await expect.poll(() => reads, { timeout: 3000 }).toBe(baseline + 4);
  await environment(false, true);
  await page.goto("about:blank");
  await page.clock.runFor(120000);
  expect(reads).toBe(baseline + 4);
  expect(posts).toBe(0);
  expect(walletCalls).toBe(0);
});

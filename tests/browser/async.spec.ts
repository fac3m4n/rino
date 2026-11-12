/** UI-only transport fixtures: these responses are not chain evidence. */
import { test, expect, type Route } from "@playwright/test";
import {
  configFixture,
  stateFixture,
  settlementFixture,
} from "../../apps/web/tests/fixtures";
import { ACTION_TIMEOUT_MS, GET_TIMEOUT_MS } from "../../apps/web/src/client";
import type { State, Receipt } from "@proofcredit/coordinator/api";
const closed: State = {
  ...stateFixture,
  market: {
    ...stateFixture.market!,
    phase: "Closed",
    debt_units: "0",
    borrower_balance_units: "0",
  },
  ethereum: {
    ...stateFixture.ethereum!,
    vaultBalanceWei: "0",
    vaultNonce: "1",
  },
  settlement: {
    ...settlementFixture,
    stage: "Complete",
    branch: "repay",
    retired: true,
  },
};
const repaid: State = {
  ...stateFixture,
  market: {
    ...stateFixture.market!,
    phase: "Repaid",
    debt_units: "0",
    borrower_balance_units: "0",
  },
};
const receipt: Receipt = {
  id: "new-confirmation",
  chain: "near",
  action: "confirm_settlement",
  status: "success",
  hash: "fixture-hash-only",
  blockNumber: "43",
  gasUsed: "1",
  feeWei: null,
  detail: "UI fixture confirmed receipt",
};
test.setTimeout(30000);
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-12T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-12T00:00:01Z"));
  await page.route("**/api/config", (r) => r.fulfill({ json: configFixture }));
});
test("@async late pre-action snapshot cannot overwrite a newer authenticated state", async ({
  page,
}) => {
  let current = stateFixture;
  let receipts: Receipt[] = [];
  let holdNext = false;
  let held: Route | undefined;
  await page.route("**/api/state", async (route) => {
    const captured = current;
    if (holdNext && !held) {
      held = route;
      return;
    }
    await route.fulfill({ json: captured });
  });
  await page.route("**/api/receipts", (r) => r.fulfill({ json: receipts }));
  await page.route("**/api/actions", async (route) => {
    current = closed;
    receipts = [receipt];
    await route.fulfill({
      json: {
        ok: true,
        message: "Fixture action observed",
        state: closed,
        receiptIds: [receipt.id],
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Repay 101 CREDIT", exact: true }),
  ).toBeEnabled();
  holdNext = true;
  await page.clock.fastForward(2501);
  await expect.poll(() => !!held, { timeout: 3000 }).toBe(true);
  await page
    .getByRole("button", { name: "Repay 101 CREDIT", exact: true })
    .click();
  await expect(page.getByTestId("settlement-stage")).toHaveText(
    "NEAR-authenticated release",
  );
  await held!.fulfill({ json: stateFixture }).catch(() => {});
  const delivered = await held!.request().response();
  await delivered?.finished();
  const paint = page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );
  await page.clock.runFor(50);
  await paint;
  await expect(page.getByTestId("settlement-stage")).toHaveText(
    "NEAR-authenticated release",
    { timeout: 3000 },
  );
  await expect(page.getByTestId("loan-debt")).toHaveText("0 CREDIT");
  await expect(
    page.getByText("Account nonce", { exact: true }).locator(".."),
  ).toContainText("1");
  await page
    .getByRole("button", { name: "Open evidence", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "UI fixture confirmed receipt",
  );
});
test("@async timed-out mutation remains uncertain and never retries while refresh is unavailable", async ({
  page,
}) => {
  let stalled = false,
    posts = 0;
  let current = stateFixture;
  let receipts: Receipt[] = [];
  await page.route("**/api/state", (r) =>
    stalled ? undefined : r.fulfill({ json: current }),
  );
  await page.route("**/api/receipts", (r) =>
    stalled ? undefined : r.fulfill({ json: receipts }),
  );
  await page.route("**/api/actions", () => {
    posts++;
    stalled = true;
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Repay 101 CREDIT", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Repay 101 CREDIT", exact: true })
    .click();
  await expect.poll(() => posts, { timeout: 3000 }).toBe(1);
  await page.clock.fastForward(ACTION_TIMEOUT_MS + 1);
  await expect(page.getByRole("alert")).toContainText("uncertain", {
    timeout: 3000,
  });
  await page.clock.fastForward(GET_TIMEOUT_MS + 1);
  await expect(
    page.getByRole("button", { name: "Waiting for receipts…" }),
  ).toHaveCount(0, { timeout: 3000 });
  await expect(page.getByRole("alert")).toContainText("uncertain", {
    timeout: 3000,
  });
  await expect(
    page.getByRole("button", { name: "Repay 101 CREDIT", exact: true }),
  ).toBeDisabled({ timeout: 3000 });
  expect(posts).toBe(1);
  stalled = false;
  current = repaid;
  receipts = [{ ...receipt, action: "repay" }];
  await page
    .getByRole("button", { name: "Refresh chain state", exact: true })
    .click();
  await expect(page.getByTestId("loan-debt")).toHaveText("0 CREDIT");
  await expect(
    page.getByRole("button", { name: "Release collateral", exact: true }),
  ).toBeEnabled();
  expect(posts).toBe(1);
});
test("@async completed action with stalled final refresh pauses controls until a fresh snapshot", async ({
  page,
}) => {
  let stalled = false;
  await page.route("**/api/state", (r) =>
    stalled ? undefined : r.fulfill({ json: stateFixture }),
  );
  await page.route("**/api/receipts", (r) => r.fulfill({ json: [] }));
  await page.route("**/api/actions", async (r) => {
    stalled = true;
    await r.fulfill({
      json: {
        ok: true,
        message: "Confirmed fixture repay",
        state: repaid,
        receiptIds: [],
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Repay 101 CREDIT", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Repay 101 CREDIT", exact: true })
    .click();
  await expect(
    page.getByText("Confirmed fixture repay", { exact: true }),
  ).toBeVisible();
  await page.clock.fastForward(GET_TIMEOUT_MS + 1);
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 3000 });
  await page.clock.fastForward(GET_TIMEOUT_MS + 1);
  await expect(
    page.getByRole("button", { name: "Waiting for receipts…" }),
  ).toHaveCount(0, { timeout: 3000 });
  await expect(
    page.getByRole("button", { name: "Release collateral", exact: true }),
  ).toBeDisabled({ timeout: 3000 });
  await expect(
    page.getByRole("button", { name: "Refresh chain state", exact: true }),
  ).toBeEnabled();
});

test("@async lender funding remains reachable with borrower ETH already deposited", async ({
  page,
}) => {
  const offered = {
    ...stateFixture,
    market: {
      ...stateFixture.market!,
      phase: "Offered",
      available_liquidity_units: "0",
      proof_fresh: true,
      borrowed_at: null,
    },
  };
  await page.route("**/api/state", (r) => r.fulfill({ json: offered }));
  await page.route("**/api/receipts", (r) => r.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByRole("button", { name: "Lender", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Fund offer + vault", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("vault-balance")).toHaveText("0.12 ETH");
});
test("@async public lender can find liquidity funding after borrower ETH deposit", async ({
  page,
}) => {
  await page.route("**/api/config", (r) =>
    r.fulfill({
      json: {
        ...configFixture,
        mode: "public",
        near: { ...configFixture.near, networkId: "testnet" },
      },
    }),
  );
  await page.route("**/api/state", (r) =>
    r.fulfill({
      json: {
        ...stateFixture,
        market: {
          ...stateFixture.market!,
          phase: "Offered",
          available_liquidity_units: "0",
          proof_fresh: true,
          borrowed_at: null,
        },
      },
    }),
  );
  await page.route("**/api/receipts", (r) => r.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByRole("button", { name: "Lender", exact: true }).click();
  const funding = page.getByRole("button", {
    name: "Fund CREDIT offer",
    exact: true,
  });
  await expect(funding).toBeVisible();
  await expect(funding).toHaveAttribute("title", /lender.test/);
});

test("@continue never-received POST permits deliberate continuation only after fresh ready idle reads", async ({
  page,
}) => {
  let online = true,
    configReady = true,
    stateReady = true,
    busy = false,
    posts = 0;
  let current = stateFixture;
  let receipts: Receipt[] = [];
  await page.route("**/api/config", (r) =>
    online
      ? r.fulfill({
          json: {
            ...configFixture,
            ready: configReady,
            readinessErrors: configReady
              ? []
              : ["Fixture configuration is unready"],
          },
        })
      : undefined,
  );
  await page.route("**/api/state", (r) =>
    online
      ? r.fulfill({ json: { ...current, ready: stateReady, busy } })
      : undefined,
  );
  await page.route("**/api/receipts", (r) =>
    online ? r.fulfill({ json: receipts }) : undefined,
  );
  await page.route("**/api/actions", async (r) => {
    posts++;
    expect(r.request().postDataJSON().action).toBe("repay");
    if (posts === 1) {
      online = false;
      return;
    } // Drop before coordinator execution: no state change or receipt.
    current = repaid;
    receipts = [{ ...receipt, action: "repay" }];
    await r.fulfill({
      json: {
        ok: true,
        message: "Fixture explicit repayment observed",
        state: current,
        receiptIds: [receipt.id],
      },
    });
  });
  await page.goto("/");
  const repayButton = page.getByRole("button", {
    name: "Repay 101 CREDIT",
    exact: true,
  });
  const continueButton = page.getByRole("button", {
    name: "Continue from checked state",
    exact: true,
  });
  await expect(repayButton).toBeEnabled();
  await expect(continueButton).toHaveCount(0);
  await repayButton.click();
  await expect.poll(() => posts, { timeout: 3000 }).toBe(1);
  await page.clock.fastForward(ACTION_TIMEOUT_MS + 1);
  await expect(page.getByRole("alert")).toContainText("uncertain", {
    timeout: 3000,
  });
  await page.clock.fastForward(GET_TIMEOUT_MS + 1);
  await expect(
    page.getByRole("button", { name: "Waiting for receipts…" }),
  ).toHaveCount(0, { timeout: 3000 });
  // The pre-action ready snapshot cannot authorize recovery while new reads are unavailable.
  await expect(continueButton).toBeVisible({ timeout: 3000 });
  await expect(continueButton).toBeDisabled();
  await expect(repayButton).toBeDisabled();
  expect(posts).toBe(1);
  const checked = async () => {
    const response = page.waitForResponse((r) =>
      r.url().endsWith("/api/state"),
    );
    await page
      .getByRole("button", { name: "Refresh chain state", exact: true })
      .click();
    await (await response).finished();
    await page.clock.runFor(50);
    await expect(
      page.getByRole("button", { name: "Refresh chain state", exact: true }),
    ).toBeEnabled();
  };
  online = true;
  busy = true;
  await checked();
  await expect(continueButton).toBeDisabled();
  expect(posts).toBe(1);
  busy = false;
  configReady = false;
  await checked();
  await expect(continueButton).toBeDisabled();
  expect(posts).toBe(1);
  configReady = true;
  stateReady = false;
  await checked();
  await expect(continueButton).toBeDisabled();
  expect(posts).toBe(1);
  stateReady = true;
  await checked();
  await expect(continueButton).toBeEnabled();
  await expect(repayButton).toBeDisabled();
  expect(posts).toBe(1);
  await continueButton.click();
  await page.clock.runFor(50);
  expect(posts).toBe(1);
  await expect(page.getByTestId("loan-debt")).toHaveText("101 CREDIT");
  await expect(repayButton).toBeEnabled();
  await expect(page.getByTestId("vault-balance")).toHaveText("0.12 ETH");
  await expect(page.getByTestId("credit-balance")).toHaveText("101 CREDIT");
  await expect(
    page.getByText("Account nonce", { exact: true }).locator(".."),
  ).toContainText("0");
  await expect(page.getByTestId("settlement-stage")).toHaveCount(0);
  await page.screenshot({
    path: `.cache/proofcredit-browser/fixture-fix2-continued-${test.info().project.name}.png`,
    fullPage: true,
  });
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "a late original request may still complete" }),
  ).toBeVisible();
  await repayButton.click();
  await expect.poll(() => posts, { timeout: 3000 }).toBe(2);
  await expect(page.getByTestId("loan-debt")).toHaveText("0 CREDIT");
});

import {
  installReadOnlyNearParticipant,
  openPosition,
  openEvidence,
  openRecovery,
  localActor,
  closePanel,
} from "./ui-helpers";
import { installMarketCatalog } from "./market-fixtures";
import { test, expect } from "@playwright/test";
import {
  configFixture,
  stateFixture,
  settlementFixture,
} from "../../apps/web/tests/fixtures";

test.setTimeout(25000);
test.use({ actionTimeout: 4000 });
test.beforeEach(async ({ page }) => {
  await installMarketCatalog(page, configFixture);
  await page.route("**/api/config*", (route) =>
    route.fulfill({ json: configFixture }),
  );
  await page.route("**/api/state*", (route) =>
    route.fulfill({ json: stateFixture }),
  );
  await page.route("**/api/receipts", (route) => route.fulfill({ json: [] }));
});
test("@layout background snapshots preserve disclosure state and keyboard focus", async ({
  page,
}) => {
  let debt = "101000000";
  await page.route("**/api/state*", (route) =>
    route.fulfill({
      json: {
        ...stateFixture,
        market: {
          ...stateFixture.market!,
          debt_units: debt,
          borrower_balance_units: debt,
        },
      },
    }),
  );
  await page.goto("/app.html");
  await openPosition(page);
  const terms = page.getByText("Loan terms", { exact: true });
  await terms.click();
  const repay = page
    .getByRole("dialog")
    .getByRole("button", { name: "Repay 101 CREDIT", exact: true });
  await repay.focus();
  debt = "102000000";
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("loan-debt")).toHaveText("102 CREDIT");
  await expect(terms.locator("..")).toHaveAttribute("open", "", {
    timeout: 3000,
  });
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Repay 102 CREDIT", exact: true }),
  ).toBeFocused();
  await openEvidence(page);
  const raw = page.getByText("Raw state & artifact evidence", { exact: true });
  await raw.click();
  await raw.focus();
  debt = "103000000";
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("dialog").locator("pre")).toContainText(
    '"debt_units": "103000000"',
  );
  await expect(raw.locator("..")).toHaveAttribute("open", "");
  await expect(raw).toBeFocused();
});
test("@layout fixture-only responsive dashboard and keyboard evidence drawer", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/app.html");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Repay loan", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("vault-balance")).toHaveText("0.12 ETH");
  await openPosition(page);
  await expect(page.getByTestId("credit-balance")).toHaveText("101 CREDIT");
  await closePanel(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `.cache/rino-browser/fixture-${info.project.name}.png`,
    fullPage: true,
  });
  await openEvidence(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("No receipts yet.")).toBeVisible();
  await dialog.getByRole("button", { name: "Close panel" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByText("Raw state & artifact evidence", { exact: true }),
  ).toBeFocused({ timeout: 3000 });
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close panel" })).toBeFocused(
    { timeout: 3000 },
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden({ timeout: 3000 });
  await expect(
    page.getByRole("button", { name: "View all evidence", exact: true }),
  ).toBeFocused({ timeout: 3000 });
  expect(errors).toEqual([]);
});
test("@layout unready public environment and pending receipts block financial actions", async ({
  page,
}) => {
  await installMarketCatalog(page, {
    ...configFixture,
    mode: "public",
    near: { ...configFixture.near, networkId: "testnet" },
    ready: false,
    readinessErrors: ["Public deployment is not configured."],
  });
  await page.route("**/api/config*", (route) =>
    route.fulfill({
      json: {
        ...configFixture,
        mode: "public",
        near: { ...configFixture.near, networkId: "testnet" },
        ready: false,
        readinessErrors: ["Public deployment is not configured."],
      },
    }),
  );
  await page.route("**/api/state*", (route) =>
    route.fulfill({
      json: {
        ...stateFixture,
        busy: true,
        pendingReason: "Awaiting authenticated callback",
      },
    }),
  );
  await installReadOnlyNearParticipant(page);
  await page.goto("/app.html");
  await expect(page.getByRole("alert")).toContainText(
    "Public deployment is not configured.",
  );
  await expect(
    page.getByRole("button", { name: "Confirm action", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".positions-table .row-action")).toBeDisabled();
  await openPosition(page);
  await expect(page.getByRole("status")).toContainText(
    "Awaiting authenticated callback",
  );
});

test("@layout authenticated terminal closure does not show a pending warning", async ({
  page,
}) => {
  await page.route("**/api/state*", (route) =>
    route.fulfill({
      json: {
        ...stateFixture,
        market: { ...stateFixture.market!, phase: "Closed" },
        settlement: {
          ...settlementFixture,
          stage: "Complete",
          retired: true,
          pending_reason: "Closed at the proven checkpoint",
        },
        pendingReason: "Closed at the proven checkpoint",
      },
    }),
  );
  await page.goto("/app.html");
  await openPosition(page);
  await page.getByText("Settlement details", { exact: true }).click();
  await expect(page.getByTestId("settlement-stage")).toHaveText(
    "NEAR-authenticated release",
  );
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Closed at the proven checkpoint" }),
  ).toHaveCount(0, { timeout: 3000 });
});

test("@layout cancellation preserves skipped proof and borrowing history", async ({
  page,
}) => {
  await page.route("**/api/state*", (route) =>
    route.fulfill({
      json: {
        ...stateFixture,
        market: {
          ...stateFixture.market!,
          phase: "Closed",
          borrowed_at: null,
          proof_timestamp: null,
        },
        settlement: {
          ...settlementFixture,
          stage: "Complete",
          branch: "cancel",
          retired: true,
        },
      },
    }),
  );
  await page.goto("/app.html");
  await openPosition(page);
  await page.getByText("Position history", { exact: true }).click();
  await expect(
    page.getByText("Not borrowed · cancelled", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Not required · cancellation", { exact: true }),
  ).toBeVisible();
  await page.getByText("Settlement details", { exact: true }).click();
  await expect(page.getByTestId("settlement-stage")).toHaveText(
    "NEAR-authenticated release",
  );
});

test("@layout retired default disables empty claims and obsolete recovery controls", async ({
  page,
}) => {
  await page.route("**/api/state*", (route) =>
    route.fulfill({
      json: {
        ...stateFixture,
        market: {
          ...stateFixture.market!,
          phase: "Closed",
          available_liquidity_units: "0",
          lender_claim_units: "0",
          debt_units: "0",
        },
        settlement: {
          ...settlementFixture,
          stage: "Complete",
          branch: "default",
          retired: true,
        },
      },
    }),
  );
  await page.goto("/app.html");
  await localActor(page, "Lender");
  await openRecovery(page);
  await page.getByText("Settlement controls", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Claim 0 CREDIT", exact: true }),
  ).toBeDisabled();

  await expect(
    page.getByRole("button", {
      name: "Reconcile pending operation",
      exact: true,
    }),
  ).toBeDisabled();
  await openPosition(page);
  await page.getByText("Development controls", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Advance to maturity", exact: true }),
  ).toBeDisabled();
});

test("@history default retains immutable debt at the historical boundary", async ({
  page,
}) => {
  await page.route("**/api/state*", (r) =>
    r.fulfill({
      json: {
        ...stateFixture,
        market: {
          ...stateFixture.market!,
          phase: "DefaultLocked",
          debt_units: "0",
        },
        settlement: { ...settlementFixture, branch: "default" },
      },
    }),
  );
  await page.goto("/app.html");
  await openPosition(page);
  await expect(
    page.getByText("Debt at default", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("loan-debt")).toHaveText("101 CREDIT", {
    timeout: 3000,
  });
});
for (const funded of [false, true])
  test(`@history ${funded ? "funded" : "empty"} cancellation has truthful funding history`, async ({
    page,
  }) => {
    await page.route("**/api/state*", (r) =>
      r.fulfill({
        json: {
          ...stateFixture,
          market: {
            ...stateFixture.market!,
            phase: "Closed",
            borrowed_at: null,
            proof_timestamp: null,
            debt_units: "0",
          },
          evidence: null,
          ethereum: {
            ...stateFixture.ethereum!,
            vaultBalanceWei: "999999999999999999",
          }, // Later retired deposit must not invent prior funding.
          settlement: {
            ...settlementFixture,
            stage: "Complete",
            branch: "cancel",
            retired: true,
            checkpoint_block_number: "42",
            borrower_surplus_wei: funded ? "119958000000000000" : "0",
            fees_paid_wei: funded ? "42000000000000" : "0",
          },
        },
      }),
    );
    await page.goto("/app.html");
    await openPosition(page);
    await page.getByText("Position history", { exact: true }).click();
    await expect(
      page.getByText("Collateral funding", { exact: true }).locator(".."),
    ).toContainText(funded ? "Funded" : "Not funded · cancellation", {
      timeout: 3000,
    });
  });

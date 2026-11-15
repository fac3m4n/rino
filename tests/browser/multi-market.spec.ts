/** Controlled market/API boundaries only; sample balances are not chain evidence. */
import { expect, test, type Page, type Route } from "@playwright/test";
import { configFixture, stateFixture } from "../../apps/web/tests/fixtures";
import type { State } from "@rino/coordinator/api";
import { closePanel, submitReviewed } from "./ui-helpers";

test.setTimeout(20000);
test.use({ actionTimeout: 4000 });
const markets = [
  {
    id: "primary",
    name: "ETH market",
    apiBase: "/api",
    controllerId: "controller.test",
    networkId: "sandbox",
  },
  {
    id: "second",
    name: "Second ETH market",
    apiBase: "/api/markets/second",
    controllerId: "second.test",
    networkId: "sandbox",
  },
];
async function install(page: Page) {
  const states: State[] = [
    stateFixture,
    {
      ...stateFixture,
      market: {
        ...stateFixture.market!,
        vault: "0x9876543210987654321098765432109876543210",
        debt_units: "202000000",
        borrower_balance_units: "202000000",
        terms: {
          ...stateFixture.market!.terms,
          principal_units: "200000000",
          fee_units: "2000000",
          debt_units: "202000000",
        },
      },
    },
  ];
  let configReads = 0;
  await page.route("**/api/markets", (route) =>
    route.fulfill({ json: { apiVersion: 1, markets } }),
  );
  for (const [index, market] of markets.entries()) {
    await page.route(`**${market.apiBase}/config*`, (route) => {
      configReads++;
      return route.fulfill({
        json: {
          ...configFixture,
          csrfToken: `csrf-${market.id}`,
          near: { ...configFixture.near, controllerId: market.controllerId },
        },
      });
    });
    await page.route(`**${market.apiBase}/state*`, (route) =>
      route.fulfill({ json: states[index] }),
    );
    await page.route(`**${market.apiBase}/receipts*`, (route) =>
      route.fulfill({ json: [] }),
    );
  }
  return { states, configReads: () => configReads };
}

test("@multi-market configured positions keep distinct CREDIT contracts and debt balances", async ({
  page,
}) => {
  await install(page);
  await page.goto("/app.html");
  const table = page.getByRole("table", {
    name: "Your positions",
    exact: true,
  });
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.locator('tr[data-market="primary"]')).toContainText(
    "101 CREDIT",
  );
  await expect(table.locator('tr[data-market="second"]')).toContainText(
    "202 CREDIT",
  );
  await expect(page.getByTestId("loan-debt")).toHaveText("2 markets");
  await expect(page.getByText("303 CREDIT", { exact: true })).toHaveCount(0);
  await page
    .getByTestId("loan-debt")
    .getByRole("button", { name: "2 markets" })
    .click();
  const detail = page.getByRole("dialog");
  await expect(detail).toContainText("101 CREDIT");
  await expect(detail).toContainText("202 CREDIT");
  await expect(detail).toContainText("sandbox:controller.test");
  await expect(detail).toContainText("sandbox:second.test");
});

test("@multi-market a pending second-market request keeps its API identity and blocks another wallet write", async ({
  page,
}) => {
  const fixture = await install(page);
  const posts: { path: string; csrf: string | undefined; action: string }[] =
    [];
  let held: Route | undefined;
  for (const market of markets)
    await page.route(`**${market.apiBase}/actions`, (route) => {
      posts.push({
        path: new URL(route.request().url()).pathname,
        csrf: route.request().headers()["x-rino-csrf"],
        action: route.request().postDataJSON().action,
      });
      if (market.id === "second") {
        held = route;
        return;
      }
      return route.abort();
    });
  await page.goto("/app.html");
  await expect(
    page.getByRole("table", { name: "Your positions" }).locator("tbody tr"),
  ).toHaveCount(2);
  await submitReviewed(
    page,
    page
      .locator('tr[data-market="second"]')
      .getByRole("button", { name: "Repay loan", exact: true }),
  );
  await expect.poll(() => !!held).toBe(true);
  expect(posts).toEqual([
    {
      path: "/api/markets/second/actions",
      csrf: "csrf-second",
      action: "repay",
    },
  ]);
  await page
    .locator('tr[data-market="primary"]')
    .getByRole("button", { name: /^ETH market/ })
    .click();
  await expect(
    page.getByRole("dialog", { name: "ETH market", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Repay 101 CREDIT", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Confirm action", exact: true }),
  ).toHaveCount(0);
  await closePanel(page);
  await expect(
    page.locator('tr[data-market="primary"] .row-action'),
  ).toBeDisabled();
  expect(posts).toHaveLength(1);
  fixture.states[1] = {
    ...fixture.states[1],
    market: {
      ...fixture.states[1].market!,
      phase: "Repaid",
      debt_units: "0",
      borrower_balance_units: "0",
    },
  };
  await held!.fulfill({
    json: {
      ok: true,
      message: "Second market repayment confirmed by controlled fixture",
      state: fixture.states[1],
      receiptIds: [],
    },
  });
  await expect(page.locator('tr[data-market="second"]')).toContainText(
    "Repaid",
  );
  await expect(page.locator('tr[data-market="primary"]')).toContainText(
    "101 CREDIT",
  );
  await expect(page.getByTestId("loan-debt")).toHaveText("101 CREDIT");
  expect(posts).toHaveLength(1);
});

test("@multi-market an unknown selected market fails closed without reading or writing primary", async ({
  page,
}) => {
  const fixture = await install(page);
  let posts = 0;
  await page.route(
    /\/api(?:\/markets\/[a-z][a-z0-9-]*)?\/actions$/,
    (route) => {
      posts++;
      return route.abort();
    },
  );
  await page.goto("/app.html?market=unknown");
  await expect(page.getByRole("alert")).toContainText(
    "selected market is not configured",
  );
  await expect(
    page.getByRole("heading", {
      name: "Positions are unavailable",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("table", { name: "Your positions" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Confirm action", exact: true }),
  ).toHaveCount(0);
  expect(fixture.configReads()).toBe(0);
  expect(posts).toBe(0);
});

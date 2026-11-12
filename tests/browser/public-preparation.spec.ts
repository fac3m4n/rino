/** UI-only public setup fixtures; no wallet signing or public chain evidence. */
import { expect, test } from "@playwright/test";
import { configFixture, stateFixture } from "../../apps/web/tests/fixtures";

test("@public-preparation funded public liquidity exposes only the missing demonstration fee endowment", async ({
  page,
}) => {
  await page.route("**/api/config", (r) =>
    r.fulfill({ json: { ...configFixture, mode: "public" } }),
  );
  await page.route("**/api/state", (r) =>
    r.fulfill({
      json: {
        ...stateFixture,
        market: {
          ...stateFixture.market!,
          phase: "Offered",
          borrower_balance_units: "1",
        },
      },
    }),
  );
  await page.route("**/api/receipts", (r) => r.fulfill({ json: [] }));
  await page.goto("/");
  await page.getByRole("button", { name: "Lender", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Restore the borrower fee endowment." }),
  ).toBeVisible({ timeout: 3000 });
  await expect(
    page.getByText(
      "The CREDIT offer is funded. Transfer only the missing amount to give the borrower the 1 CREDIT demonstration repayment fee.",
      { exact: true },
    ),
  ).toBeVisible({ timeout: 3000 });
  await expect(
    page.getByRole("button", { name: /^Fund CREDIT offer/ }),
  ).toBeVisible({ timeout: 3000 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

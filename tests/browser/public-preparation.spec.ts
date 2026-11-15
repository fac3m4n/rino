import { installReadOnlyNearParticipant } from "./ui-helpers";
import { installMarketCatalog } from "./market-fixtures";
/** UI-only public setup fixtures; no wallet signing or public chain evidence. */
import { expect, test } from "@playwright/test";
import { configFixture, stateFixture } from "../../apps/web/tests/fixtures";

test.setTimeout(25000);
test.use({ actionTimeout: 4000 });
test("@public-preparation funded public liquidity exposes only the missing demonstration fee endowment", async ({
  page,
}) => {
  await installMarketCatalog(page, {
    ...configFixture,
    mode: "public",
    near: { ...configFixture.near, networkId: "testnet" },
  });
  await page.route("**/api/config*", (r) =>
    r.fulfill({
      json: {
        ...configFixture,
        mode: "public",
        near: { ...configFixture.near, networkId: "testnet" },
      },
    }),
  );
  await page.route("**/api/state*", (r) =>
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
  await installReadOnlyNearParticipant(page, configFixture.near.lenderId);
  await page.goto("/app.html");
  await page.getByRole("button", { name: "Lend", exact: true }).click();
  await page.getByRole("button", { name: "Fund offer", exact: true }).click();
  const review = page.getByRole("dialog", {
    name: "Fund CREDIT offer",
    exact: true,
  });
  await expect(review).toBeVisible({ timeout: 3000 });
  await expect(
    review.getByText("Borrower fee endowment", { exact: true }).locator(".."),
  ).toContainText("0.999999 CREDIT");
  await expect(
    review.getByText("Lender escrow", { exact: true }).locator(".."),
  ).toContainText("0 CREDIT");
  await expect(review).toContainText(
    "An earlier confirmed transfer remains real if a later request fails.",
  );
  await expect(
    review.getByRole("button", { name: "Confirm action", exact: true }),
  ).toBeEnabled({ timeout: 3000 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

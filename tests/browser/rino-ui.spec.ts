/** Controlled API/wallet boundaries only. These fixtures are not chain evidence. */
import { expect, test, type Page } from "@playwright/test";
import {
  configFixture,
  stateFixture,
  operationFixture,
} from "../../apps/web/tests/fixtures";
import type { Receipt } from "@proofcredit/coordinator/api";

test.setTimeout(30000);
test.use({ actionTimeout: 4000 });
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-13T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-13T00:00:01Z"));
  await page.route("**/api/config*", (r) => r.fulfill({ json: configFixture }));
  await page.route("**/api/state*", (r) => r.fulfill({ json: stateFixture }));
  await page.route("**/api/receipts*", (r) => r.fulfill({ json: [] }));
});
const toggle = (page: Page) =>
  page.getByRole("button", { name: /Switch to (dark|light) theme/ });

// Catches dropped preference writes, unsafe storage reads/writes and invalid preferences.
test("@rino-ui theme choice persists on reload and storage denial still allows rendering", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your position", exact: true }),
  ).toBeVisible({ timeout: 4000 });
  await toggle(page).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.evaluate(() => localStorage.setItem("rino.theme.v1", "invalid"));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Denied", "SecurityError");
      },
    });
  });

  await page.reload();
  await expect(page.getByTestId("vault-balance")).toHaveText("0.12 ETH");
  await toggle(page).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

// Catches a theme-induced App remount that loses the submission lock or triggers reads.
test("@rino-ui switching theme while an action is pending preserves disabled controls and one submission", async ({
  page,
}) => {
  let posts = 0,
    reads = 0;
  await page.route("**/api/state*", (r) => {
    reads++;
    return r.fulfill({ json: stateFixture });
  });
  await page.route("**/api/actions", () => {
    posts++;
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Repay 101 CREDIT", exact: true })
    .click();
  await expect.poll(() => posts, { timeout: 4000 }).toBe(1);
  const before = reads;
  await toggle(page).click();
  await expect(
    page.getByRole("button", { name: "Waiting for receipts…", exact: true }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  await page
    .getByRole("button", { name: "Open evidence", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await toggle(page).click();
  expect(reads).toBe(before);
  expect(posts).toBe(1);
});

// Catches invented explorer hashes, worker links and extra queries on presentation events.
test("@rino-ui activity links use actual hashes without mounting queries", async ({
  page,
}) => {
  const nearHash = "11111111111111111111111111111111";
  const ethHash = `0x${"ab".repeat(32)}`;
  let reads = 0;
  const receipts: Receipt[] = [
    {
      id: "near",
      chain: "near",
      action: "repay",
      status: "pending",
      hash: nearHash,
      blockNumber: null,
      gasUsed: null,
      feeWei: null,
      detail: "Transaction needs checking.",
    },
    {
      id: "eth",
      chain: "ethereum",
      action: "release",
      status: "uncertain",
      hash: ethHash,
      blockNumber: null,
      gasUsed: null,
      feeWei: null,
      detail: "Inclusion unknown.",
    },
    {
      id: "worker",
      chain: "worker",
      action: "proof",
      status: "success",
      hash: nearHash,
      blockNumber: null,
      gasUsed: null,
      feeWei: null,
      detail: "Worker result only.",
    },
  ];
  await page.route("**/api/**", (r) => {
    reads++;
    const path = new URL(r.request().url()).pathname;
    return r.fulfill({
      json:
        path === "/api/config"
          ? {
              ...configFixture,
              mode: "public",
              near: { ...configFixture.near, networkId: "testnet" },
            }
          : path === "/api/state"
            ? stateFixture
            : receipts,
    });
  });
  await page.goto("/");
  const activity = page.getByRole("table", { name: "Transaction activity" });
  await expect(activity).toBeVisible({ timeout: 4000 });
  await expect(activity.locator("a")).toHaveCount(2);
  await expect(
    activity.locator("a").filter({ hasText: nearHash }),
  ).toHaveAttribute("href", `https://testnet.nearblocks.io/txns/${nearHash}`);
  await expect(
    activity.locator("a").filter({ hasText: ethHash }),
  ).toHaveAttribute("href", `https://sepolia.etherscan.io/tx/${ethHash}`);
  const before = reads;
  await toggle(page).click();
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  await page
    .getByRole("button", { name: "Open evidence", exact: true })
    .click();
  await expect(page.getByRole("dialog").locator("a")).toHaveCount(2);
  await page.keyboard.press("Escape");
  expect(reads).toBe(before);
});

// Catches overflow, unnamed tablet controls, hidden identity and inaccessible recovery.
test("@rino-ui both themes reflow with long IDs and retain keyboard evidence/recovery access", async ({
  page,
}, info) => {
  const borrower = `${"long-borrower-".repeat(3)}.testnet`;
  const config = {
    ...configFixture,
    mode: "public",
    capabilities: { operations: true },
    near: { ...configFixture.near, networkId: "testnet", borrowerId: borrower },
  };
  await page.route("**/api/config*", (r) => r.fulfill({ json: config }));
  await page.route("**/api/state*", (r) =>
    r.fulfill({
      json: {
        ...stateFixture,
        market: {
          ...stateFixture.market!,
          borrower,
          terms: {
            ...stateFixture.market!.terms,
            principal_units: "200000000",
            fee_units: "3000000",
            debt_units: "203000000",
            max_ltv_bps: "4250",
            term_seconds: "600",
            reference_units_per_eth: "2500000000",
          },
        },
      },
    }),
  );
  await page.route("**/api/operations*", (r) =>
    r.fulfill({ json: [operationFixture] }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your position", exact: true }),
  ).toBeVisible({ timeout: 4000 });
  await expect(
    page.getByRole("button", { name: "Repay 203 CREDIT", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("An operation needs checking", { exact: false }).first(),
  ).toBeVisible();
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await toggle(page).click();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(
        page.getByRole("link", { name: "Rino home", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Connect NEAR testnet", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const unnamed = await page
        .locator("button:visible, a:visible")
        .evaluateAll(
          (els) =>
            els.filter(
              (el) =>
                !(el.getAttribute("aria-label") || el.textContent)?.trim(),
            ).length,
        );
      expect(unnamed).toBe(0);
      await page.screenshot({
        path: `.superpowers/sdd/2026-11-13-rino-product-experience/task2-${info.project.name}-${theme}-${width}.png`,
        fullPage: true,
      });
    }
    await page
      .getByRole("button", { name: "Open evidence", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toContainText(borrower);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Open evidence", exact: true }),
    ).toBeFocused();
    await page
      .getByRole("link", { name: "Check operation recovery", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("region", { name: "Operation recovery" }),
    ).toBeInViewport();
    await expect(
      page.getByRole("textbox", { name: /Transaction hash .* step 1/ }),
    ).toBeVisible();
  }
  await expect(page.getByText("42.5%", { exact: true })).toBeVisible();
  await expect(page.getByText("600 sec", { exact: true })).toBeVisible();
});

// Catches technical instructions dominating an idle view and terminal evidence losing disclosure access.
test("@rino-ui idle recovery stays compact and terminal evidence expands on demand", async ({
  page,
}) => {
  await page.route("**/api/config*", (r) =>
    r.fulfill({
      json: {
        ...configFixture,
        mode: "public",
        capabilities: { operations: true },
      },
    }),
  );
  let terminal = false;
  await page.route("**/api/operations*", (r) =>
    r.fulfill({
      json: terminal
        ? [
            {
              ...operationFixture,
              unresolved: false,
              stage: "failed",
              detail: "Final callback returned false.",
              steps: [
                { ...operationFixture.steps[0], status: "failed", hashes: [] },
              ],
            },
          ]
        : [],
    }),
  );
  await page.goto("/");
  const region = page.getByRole("region", { name: "Operation recovery" });
  await expect(region).toBeVisible({ timeout: 4000 });
  await expect(
    region.getByText(/Wallet observations need checking/),
  ).toBeHidden({ timeout: 3000 });
  await region
    .getByText("Recovery details & historical import", { exact: true })
    .click();
  await region
    .getByText("Import a historical NEAR receipt", { exact: true })
    .click();
  await expect(
    region.getByRole("textbox", {
      name: "Historical NEAR transaction hash",
      exact: true,
    }),
  ).toBeVisible();
  terminal = true;
  await page.reload();
  await expect(
    region.getByText("Final callback returned false.", { exact: true }),
  ).toBeHidden();
  await region.locator(".operation-record > summary").click();
  await expect(
    region.getByText("Final callback returned false.", { exact: true }),
  ).toBeVisible();
  await expect(
    region.getByRole("button", { name: "Check operation", exact: true }),
  ).toBeVisible();
});

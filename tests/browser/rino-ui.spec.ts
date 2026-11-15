import {
  installReadOnlyNearParticipant,
  submitReviewed,
  openRecovery,
  openEvidence,
  openPosition,
  closePanel,
} from "./ui-helpers";
import { installMarketCatalog } from "./market-fixtures";
/** Controlled API/wallet boundaries only. These fixtures are not chain evidence. */
import { expect, test, type Page } from "@playwright/test";
import {
  configFixture,
  stateFixture,
  operationFixture,
  settlementFixture,
} from "../../apps/web/tests/fixtures";
import type { Receipt, State } from "@rino/coordinator/api";

test.setTimeout(30000);
test.use({ actionTimeout: 4000 });
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-13T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-13T00:00:01Z"));
  await installMarketCatalog(page, configFixture);
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
  await page.goto("/app.html");
  await expect(
    page.getByRole("heading", { name: "Dashboard", exact: true }),
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
  await page.goto("/app.html");
  await submitReviewed(
    page,
    page.getByRole("button", { name: "Repay loan", exact: true }),
  );
  await expect.poll(() => posts, { timeout: 4000 }).toBe(1);
  const before = reads;
  await toggle(page).click();
  await expect(
    page.getByRole("button", { name: "Confirming", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await openEvidence(page);
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
  await installMarketCatalog(page, {
    near: { ...configFixture.near, networkId: "testnet" },
  });
  await installReadOnlyNearParticipant(page);
  await page.goto("/app.html");
  await page.getByRole("button", { name: "Activity", exact: true }).click();
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
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await openEvidence(page);
  await expect(page.getByRole("dialog").locator("a")).toHaveCount(2);
  await page.keyboard.press("Escape");
  expect(reads).toBe(before);
});

// Catches overflow, unnamed tablet controls, hidden identity and inaccessible recovery.
test("@rino-ui both themes reflow with long IDs and retain keyboard evidence/recovery access", async ({
  page,
}, info) => {
  const borrower = `${"long-borrower-".repeat(3)}account.testnet`;
  const config = {
    ...configFixture,
    mode: "public",
    capabilities: { operations: true },
    near: { ...configFixture.near, networkId: "testnet", borrowerId: borrower },
  };
  await installMarketCatalog(page, config);
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
  await installReadOnlyNearParticipant(page, borrower);
  await page.goto("/app.html");
  await expect(
    page.getByRole("heading", { name: "Dashboard", exact: true }),
  ).toBeVisible({ timeout: 4000 });
  await expect(
    page.getByRole("button", { name: "Repay loan", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Outcome needs checking", { exact: false }).first(),
  ).toBeVisible();
  for (const theme of ["light", "dark"]) {
    if (theme === "dark") await toggle(page).click();
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(
        page.getByRole("link", { name: "Rino home", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /^Wallets:/ }),
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
        path: info.outputPath(`theme-${theme}-${width}.png`),
        fullPage: true,
      });
    }
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await page
      .getByRole("button", { name: "View all evidence", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toContainText(borrower);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "View all evidence", exact: true }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "Check request", exact: true })
      .first()
      .focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("region", { name: "Operation recovery" }),
    ).toBeInViewport();
    await expect(
      page.getByRole("textbox", { name: /Transaction hash .* step 1/ }),
    ).toBeVisible();
    await closePanel(page);
  }
  await openPosition(page);
  await page.getByText("Loan terms", { exact: true }).click();
  await expect(page.getByText("42.5%", { exact: true })).toBeVisible();
  await expect(
    page.getByText("10 minutes", { exact: true }).last(),
  ).toBeVisible();
});

// Catches a historical maturity being shown as an active countdown after closure.
test("@rino-ui closed future maturity has no remaining countdown while active chain time is retained", async ({
  page,
}) => {
  let terminal = true;
  await page.route("**/api/state*", (r) => {
    const state: State = terminal
      ? {
          ...stateFixture,
          market: { ...stateFixture.market!, phase: "Closed", debt_units: "0" },
          settlement: {
            ...settlementFixture,
            stage: "Complete",
            branch: "repay",
            retired: true,
          },
          ethereum: {
            ...stateFixture.ethereum!,
            vaultBalanceWei: "0",
            vaultNonce: "1",
          },
        }
      : stateFixture;
    return r.fulfill({ json: state });
  });
  await page.goto("/app.html");
  await openPosition(page);
  const panel = page.getByRole("dialog");
  await expect(panel.getByText("Closed", { exact: true }).first()).toBeVisible({
    timeout: 4000,
  });
  await expect(panel.getByText(/s remaining$/)).toHaveCount(0, {
    timeout: 4000,
  });
  terminal = false;
  await page.reload();
  await openPosition(page);
  await expect(panel.getByText("Time remaining", { exact: true })).toBeVisible({
    timeout: 4000,
  });
  await expect(
    panel.getByText("100s remaining", { exact: true }),
  ).toBeVisible();
});

// Catches positive fees being truncated to zero, while retaining zero and ordinary values.
for (const [feeWei, display] of [
  ["0", "0"],
  ["798000", "<0.000001"],
  ["1000000000000", "0.000001"],
  ["1234567890000000", "0.001234"],
]) {
  test(`@rino-ui fee ${feeWei} retains its nonzero meaning in summary and receipt evidence`, async ({
    page,
  }) => {
    await page.route("**/api/state*", (r) =>
      r.fulfill({
        json: {
          ...stateFixture,
          settlement: {
            ...settlementFixture,
            stage: "Complete",
            branch: "repay",
            retired: true,
            fees_paid_wei: feeWei,
          },
          market: { ...stateFixture.market!, phase: "Closed", debt_units: "0" },
          ethereum: {
            ...stateFixture.ethereum!,
            vaultBalanceWei: "0",
            vaultNonce: "1",
          },
        } satisfies State,
      }),
    );
    const receipt: Receipt = {
      id: "fee",
      chain: "ethereum",
      action: "release",
      status: "success",
      hash: `0x${"ab".repeat(32)}`,
      blockNumber: "42",
      gasUsed: "21000",
      feeWei,
      detail: "Fixture fee evidence only.",
    };
    await page.route("**/api/receipts*", (r) => r.fulfill({ json: [receipt] }));
    await page.goto("/app.html");
    await openPosition(page);
    await page.getByText("Settlement details", { exact: true }).click();
    const fees = page
      .locator(".definitions > div")
      .filter({ has: page.getByText("Fees paid", { exact: true }) });
    await expect
      .soft(fees.locator("dd"))
      .toHaveText(`${display} ETH`, { timeout: 4000 });
    await openEvidence(page);
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText(new RegExp(`Fee ${display.replace(".", "\\.")} ETH$`)),
    ).toBeVisible({ timeout: 4000 });
    await dialog
      .getByText("Raw state & artifact evidence", { exact: true })
      .click();
    await expect(dialog.locator("pre")).toContainText(
      `"fees_paid_wei": "${feeWei}"`,
    );
  });
}

// Catches technical instructions dominating an idle view and terminal evidence losing disclosure access.
test("@rino-ui idle recovery stays compact and terminal evidence expands on demand", async ({
  page,
}) => {
  await installMarketCatalog(page, {
    ...configFixture,
    mode: "public",
    near: { ...configFixture.near, networkId: "testnet" },
    capabilities: { operations: true },
  });
  await page.route("**/api/config*", (r) =>
    r.fulfill({
      json: {
        ...configFixture,
        mode: "public",
        near: { ...configFixture.near, networkId: "testnet" },
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
  await installReadOnlyNearParticipant(page);
  await page.goto("/app.html");
  await openRecovery(page);
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
  await openRecovery(page);
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

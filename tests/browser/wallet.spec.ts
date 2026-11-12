import { expect, test } from "@playwright/test";
import { configFixture, stateFixture } from "../../apps/web/tests/fixtures";
import { installFundingProvider } from "../../apps/web/tests/wallet-fixtures";
test.setTimeout(30000);
for (const mode of ["timeout", "reject", "cancel", "speedup"])
  test(`@wallet actual viem ${mode} funding outcome`, async ({ page }) => {
    await page.clock.install();
    await page.addInitScript(installFundingProvider, mode);
    await page.route("**/api/config", (r) =>
      r.fulfill({
        json: {
          ...configFixture,
          mode: "public",
          near: { ...configFixture.near, networkId: "testnet" },
          ethereum: { ...configFixture.ethereum, rpcUrl: null },
        },
      }),
    );
    let observedBalance = "50000000000000000";
    await page.route("**/api/state", (r) =>
      r.fulfill({
        json: {
          ...stateFixture,
          market: {
            ...stateFixture.market!,
            phase: "Offered",
            borrowed_at: null,
            proof_fresh: false,
          },
          evidence: null,
          ethereum: {
            ...stateFixture.ethereum!,
            vaultBalanceWei: observedBalance,
          },
        },
      }),
    );
    await page.route("**/api/receipts", (r) => r.fulfill({ json: [] }));
    await page.goto("/");
    await page
      .getByRole("button", { name: "Connect Ethereum wallet", exact: true })
      .click();
    const funding = page.getByRole("button", { name: /^Fund vault/ });
    await expect(funding).toBeEnabled({ timeout: 3000 });
    await funding.click();
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (globalThis as unknown as { walletFixture: { sends: number } })
                .walletFixture.sends,
          ),
        { timeout: 3000 },
      )
      .toBe(1);
    if (mode === "timeout") {
      await page.clock.fastForward(120001);
      await expect(page.getByRole("alert")).toContainText("uncertain", {
        timeout: 3000,
      });
      await expect(page.getByRole("alert")).toContainText(
        `0x${"a".repeat(64)}`,
      );
      await expect(funding).toBeDisabled();
      const resume = page.getByRole("button", {
        name: "Continue from checked state",
        exact: true,
      });
      await expect(resume).toBeEnabled({ timeout: 3000 });
      await page
        .getByRole("button", { name: "Refresh chain state", exact: true })
        .click();
      await expect(funding).toBeDisabled();
      await expect(page.getByTestId("vault-balance")).toHaveText("0.05 ETH");
      // An unrelated dust gift cannot authenticate the still-pending known wallet payment.
      observedBalance = "50000000000000001";
      await page
        .getByRole("button", { name: "Refresh chain state", exact: true })
        .click();
      await expect(funding).toBeDisabled({ timeout: 3000 });
      await expect(resume).toBeEnabled({ timeout: 3000 });
      await resume.click();
      await expect(funding).toBeEnabled();
    } else if (mode === "speedup") {
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Ethereum funding included" }),
      ).toContainText(`0x${"b".repeat(64)}`, { timeout: 3000 });
      await expect(page.getByRole("alert")).toHaveCount(0);
    } else {
      await expect(page.getByRole("alert")).toContainText(
        mode === "reject" ? "rejected before acceptance" : "cancelled",
        { timeout: 3000 },
      );
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Ethereum funding included" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", {
          name: "Continue from checked state",
          exact: true,
        }),
      ).toHaveCount(0);
    }
    expect(
      await page.evaluate(
        () =>
          (globalThis as unknown as { walletFixture: { sends: number } })
            .walletFixture.sends,
      ),
    ).toBe(1);
    if (mode !== "reject")
      expect(
        await page.evaluate(
          () =>
            (globalThis as unknown as { walletFixture: { sentValue: string } })
              .walletFixture.sentValue,
        ),
      ).toBe("0xf8b0a10e470000"); // Exact 0.07 ETH shortfall.
  });

/** Controlled catalog metadata. No chain discovery, wallet action or extra config read. */
import type { Page } from "@playwright/test";

export async function installMarketCatalog<
  T extends { near: { controllerId: string; networkId: string } },
>(page: Page, config: T) {
  await page.route("**/api/markets", (route) =>
    route.fulfill({
      json: {
        apiVersion: 1,
        markets: [
          {
            id: "primary",
            name: "ETH market",
            apiBase: "/api",
            controllerId: config.near.controllerId,
            networkId: config.near.networkId,
          },
        ],
      },
    }),
  );
}

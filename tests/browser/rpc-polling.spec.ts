import {
  installReadOnlyNearParticipant,
  connectEthereum,
  submitReviewed,
  openRecovery,
} from "./ui-helpers";
import { installMarketCatalog } from "./market-fixtures";
/** Controlled UI/RPC fixtures only; these requests are not public chain evidence. */
import { test, expect, type Page } from "@playwright/test";
import { configFixture, stateFixture } from "../../apps/web/tests/fixtures";
import { installFundingProvider } from "../../apps/web/tests/wallet-fixtures";
test.setTimeout(30000);
async function environment(page: Page) {
  await page.addInitScript(() => {
    let visible = true,
      online = true;
    Object.defineProperty(document, "visibilityState", {
      get: () => (visible ? "visible" : "hidden"),
    });
    Object.defineProperty(navigator, "onLine", { get: () => online });
    Object.assign(globalThis, {
      rpcEnvironment: (v: boolean, o: boolean) => {
        visible = v;
        online = o;
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event(o ? "online" : "offline"));
      },
    });
  });
  await page.clock.install({ time: new Date("2026-11-13T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-11-13T00:00:01Z"));
}
async function changeEnvironment(
  page: Page,
  visible: boolean,
  online: boolean,
) {
  await page.evaluate(
    ([v, o]) =>
      (
        globalThis as unknown as {
          rpcEnvironment: (v: boolean, o: boolean) => void;
        }
      ).rpcEnvironment(v, o),
    [visible, online],
  );
}
test("@rpc App public idle/pending and failure schedules have bounded actual API request counts", async ({
  page,
}) => {
  await environment(page);
  await installReadOnlyNearParticipant(page);
  let reads = 0,
    busy = false,
    ready = true;
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
  await page.route("**/api/state*", (r) => {
    reads++;
    return r.fulfill({
      json: {
        ...stateFixture,
        busy,
        ready,
        pendingReason:
          "Awaiting liquidity, derived vault and fresh eligible collateral proof",
      },
    });
  });
  await page.route("**/api/receipts", (r) => r.fulfill({ json: [] }));
  await page.goto("/app.html");
  await expect.poll(() => reads).toBe(1);
  await expect(page.getByTestId("vault-balance")).toHaveText("0.12 ETH");
  await page.clock.runFor(29999);
  expect(reads).toBe(1);
  busy = true;
  await page.clock.runFor(1);
  await expect.poll(() => reads).toBe(2);
  await page.clock.runFor(4999);
  expect(reads).toBe(2);
  ready = false;
  await page.clock.runFor(1);
  await expect.poll(() => reads).toBe(3);
  await page.clock.runFor(14999);
  expect(reads).toBe(3);
  await page.clock.runFor(1);
  await expect.poll(() => reads).toBe(4);
  await page.clock.runFor(29999);
  expect(reads).toBe(4);
  await page.clock.runFor(1);
  await expect.poll(() => reads).toBe(5);
});
test("@rpc actual App suspends hidden/offline reads and resumes one current request per event burst", async ({
  page,
}) => {
  await environment(page);
  await installReadOnlyNearParticipant(page);
  let reads = 0;
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
  await page.route("**/api/state*", (r) => {
    reads++;
    return r.fulfill({ json: stateFixture });
  });
  await page.route("**/api/receipts", (r) => r.fulfill({ json: [] }));
  await page.goto("/app.html");
  await expect(page.getByTestId("vault-balance")).toHaveText("0.12 ETH");
  await changeEnvironment(page, false, true);
  await page.clock.runFor(120000);
  expect(reads).toBe(1);
  await changeEnvironment(page, true, false);
  await page.clock.runFor(120000);
  expect(reads).toBe(1);
  const nextBatch = () =>
    Promise.all(
      ["config", "state", "receipts"].map((path) =>
        page
          .waitForResponse(
            (response) => new URL(response.url()).pathname === `/api/${path}`,
          )
          .then((response) => response.finished()),
      ),
    );
  const resumed = nextBatch();
  await changeEnvironment(page, true, true);
  await resumed;
  await expect.poll(() => reads).toBe(2);
  await changeEnvironment(page, false, true);
  const finalBatch = nextBatch();
  await changeEnvironment(page, true, true);
  await finalBatch;
  await expect.poll(() => reads).toBe(3);
  await changeEnvironment(page, false, true);
  await page.goto("about:blank");
  await page.clock.runFor(120000);
  expect(reads).toBe(3);
});
for (const scenario of [
  "fresh-shortfall",
  "fresh-guard",
  "wallet-hidden",
] as const)
  test(`@rpc ${scenario} uses fresh action authority and fresh post-action/manual reconciliation`, async ({
    page,
  }) => {
    await environment(page);
    await installReadOnlyNearParticipant(page);
    await page.addInitScript(installFundingProvider, "success");
    await page.addInitScript((popup: boolean) => {
      const g = globalThis as unknown as {
        ethereum: { request: (r: any) => Promise<any> };
        releasePopup?: () => void;
      };
      const request = g.ethereum.request.bind(g.ethereum);
      g.ethereum.request = async (r) => {
        if (popup && r.method === "eth_sendTransaction")
          await new Promise<void>((resolve) => {
            g.releasePopup = resolve;
          });
        const result = await request(r);
        // The successful receipt fixture must describe the same included transaction.
        if (r.method === "eth_getTransactionByHash")
          return {
            ...result,
            blockHash: `0x${"c".repeat(64)}`,
            blockNumber: "0x1",
          };
        return result;
      };
    }, scenario === "wallet-hidden");
    const stateUrls: string[] = [];
    const configUrls: string[] = [];
    let phase = "Offered";
    let balance = "50000000000000000";
    let failDisplay = false;
    await installMarketCatalog(page, {
      ...configFixture,
      mode: "public",
      near: { ...configFixture.near, networkId: "testnet" },
      ethereum: { ...configFixture.ethereum, rpcUrl: null },
    });
    await page.route("**/api/config*", (r) => {
      configUrls.push(r.request().url());
      return r.fulfill({
        json: {
          ...configFixture,
          mode: "public",
          near: { ...configFixture.near, networkId: "testnet" },
          ethereum: { ...configFixture.ethereum, rpcUrl: null },
        },
      });
    });
    await page.route("**/api/state*", (r) => {
      stateUrls.push(r.request().url());
      if (failDisplay && !new URL(r.request().url()).search) return r.abort();
      return r.fulfill({
        json: {
          ...stateFixture,
          market: {
            ...stateFixture.market!,
            phase,
            proof_fresh: false,
            borrowed_at: null,
          },
          ethereum: { ...stateFixture.ethereum!, vaultBalanceWei: balance },
        },
      });
    });
    await page.route("**/api/receipts", (r) => r.fulfill({ json: [] }));
    let posts = 0;
    await page.route("**/api/actions", (r) => {
      posts++;
      return r.abort();
    });
    await page.goto("/app.html");
    await connectEthereum(page);
    const funding = page.getByRole("button", {
      name: "Add collateral",
      exact: true,
    });
    await expect(funding).toBeEnabled();
    balance = "80000000000000000";
    if (scenario === "fresh-guard") phase = "Closed";
    await submitReviewed(page, funding);
    if (scenario === "wallet-hidden") {
      await expect
        .poll(() =>
          page.evaluate(
            () => typeof (globalThis as any).releasePopup === "function",
          ),
        )
        .toBe(true);
      await changeEnvironment(page, false, true);
      await page.clock.runFor(90000);
      expect(stateUrls).toHaveLength(2);
      await page.evaluate(() => (globalThis as any).releasePopup());
    }
    if (scenario !== "fresh-guard") {
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Ethereum funding included" }),
      ).toBeVisible({ timeout: 3000 });
      expect(
        await page.evaluate(() => (globalThis as any).walletFixture.sentValue),
      ).toBe("0x8e1bc9bf040000"); // 0.04 ETH from fresh 0.08 balance.
      expect(
        await page.evaluate(() => (globalThis as any).walletFixture.sends),
      ).toBe(1);
    } else {
      await expect(page.getByRole("alert")).toBeVisible();
      expect(
        await page.evaluate(() => (globalThis as any).walletFixture.sends),
      ).toBe(0);
    }
    await expect.poll(() => stateUrls.length).toBe(3);
    expect(stateUrls.map((u) => new URL(u).search)).toEqual([
      "",
      "?fresh=1",
      "?fresh=1",
    ]);
    expect(configUrls.map((u) => new URL(u).search)).toEqual([
      "",
      "?fresh=1",
      "?fresh=1",
    ]);
    expect(posts).toBe(0);
    failDisplay = true;
    await changeEnvironment(page, true, true);
    await openRecovery(page);
    await page
      .getByRole("button", { name: "Refresh chain state", exact: true })
      .click();
    await expect
      .poll(
        () => stateUrls.filter((u) => new URL(u).search === "?fresh=1").length,
      )
      .toBe(3);
    await expect(
      page.getByRole("button", { name: "Waiting for receipts…" }),
    ).toHaveCount(0);
  });

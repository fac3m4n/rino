/** Isolated real-component harness; no wallet connection or financial requests. */
import { expect, test, type Page } from "@playwright/test";

async function harness(page: Page) {
  page.on("pageerror", (error) => console.log("HARNESS_ERROR", error.message));
  page.on("response", (response) => {
    if (response.status() >= 400)
      console.log("HARNESS_HTTP", response.status(), response.url());
  });
  await page.route("**/qa-wallet-choices", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><head><title>Wallet choices component fixture</title></head><body><div id="root"></div><script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;

      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      const { NearWalletChoices } = await import('/src/NearWalletChoices.tsx');
      import '/src/styles.css';
      globalThis.walletChoicesFixture = { loads: 0, chosen: [] };
      const f = globalThis.walletChoicesFixture;
      function Harness(){
        const [revision,update] = React.useState(0);
        return React.createElement('main',null,
          React.createElement('h1',null,'Wallet fixture'),
          React.createElement(NearWalletChoices,{load:()=>{f.loads++;return new Promise((resolve,reject)=>{f.resolve=resolve;f.reject=reject})},onChoose:id=>f.chosen.push(id)}),
          React.createElement('button',{onClick:()=>update(revision+1)},'Unrelated update'));
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
    </script></body></html>`,
    }),
  );
  await page.goto("/qa-wallet-choices");
  await expect(
    page.getByRole("heading", { name: "Wallet fixture", exact: true }),
  ).toBeVisible({ timeout: 3000 });
}

test("native wallet choice loads once, survives parent rerenders and activates with the keyboard", async ({
  page,
}) => {
  await harness(page);
  await expect(page.getByRole("status")).toHaveText("Loading wallets…", {
    timeout: 3000,
  });
  await page.getByRole("button", { name: "Unrelated update" }).click();
  expect(
    await page.evaluate(() => (globalThis as any).walletChoicesFixture.loads),
  ).toBe(1);
  await page.evaluate(() =>
    (globalThis as any).walletChoicesFixture.resolve([
      { id: "meteor-wallet", name: "Meteor" },
    ]),
  );
  const choice = page.getByRole("button", { name: "Meteor", exact: true });
  await expect(choice).toBeVisible();
  await page.getByRole("button", { name: "Unrelated update" }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(choice).toBeFocused();
  await page.keyboard.press("Enter");
  expect(
    await page.evaluate(() => (globalThis as any).walletChoicesFixture.chosen),
  ).toEqual(["meteor-wallet"]);
});

test("wallet catalog error and empty states allow only an explicit retry", async ({
  page,
}) => {
  await harness(page);
  await expect(page.getByRole("status")).toHaveText("Loading wallets…", {
    timeout: 3000,
  });
  await page.evaluate(() =>
    (globalThis as any).walletChoicesFixture.reject(
      new Error("Controlled catalog unavailable"),
    ),
  );
  await expect(page.getByRole("alert")).toContainText(
    "Controlled catalog unavailable",
  );
  expect(
    await page.evaluate(() => (globalThis as any).walletChoicesFixture.loads),
  ).toBe(1);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Loading wallets…", {
    timeout: 3000,
  });
  await page.evaluate(() =>
    (globalThis as any).walletChoicesFixture.resolve([]),
  );
  await expect(
    page.getByText("No compatible wallets are available.", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (globalThis as any).walletChoicesFixture.loads),
  ).toBe(2);
  expect(
    await page.evaluate(() => (globalThis as any).walletChoicesFixture.chosen),
  ).toEqual([]);
});

test("a stalled catalog times out and a late result cannot replace an explicit retry", async ({
  page,
}) => {
  await page.clock.install();
  await harness(page);
  await expect(page.getByRole("status")).toHaveText("Loading wallets…", {
    timeout: 3000,
  });
  await page.evaluate(() => {
    const f = (globalThis as any).walletChoicesFixture;
    f.firstResolve = f.resolve;
  });
  await page.clock.fastForward(5001);
  await expect(page.getByRole("alert")).toHaveText(
    "Wallet list timed out. Try again.",
    { timeout: 3000 },
  );
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Loading wallets…", {
    timeout: 3000,
  });
  await page.evaluate(() =>
    (globalThis as any).walletChoicesFixture.firstResolve([
      { id: "late", name: "Late wallet" },
    ]),
  );
  await expect(
    page.getByRole("button", { name: "Late wallet", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("Loading wallets…", {
    timeout: 3000,
  });
  await page.evaluate(() =>
    (globalThis as any).walletChoicesFixture.resolve([
      { id: "meteor-wallet", name: "Meteor" },
    ]),
  );
  await expect(
    page.getByRole("button", { name: "Meteor", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (globalThis as any).walletChoicesFixture.loads),
  ).toBe(2);
});

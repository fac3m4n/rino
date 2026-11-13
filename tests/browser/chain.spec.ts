import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ActionResult, Receipt, State } from "@rino/coordinator/api";

const root = resolve(import.meta.dirname, "../..");
const origin = "http://127.0.0.1:3001";
let supervisor: ChildProcess | undefined;
let diagnostics = "";
test.use({ video: "on" });
test.beforeEach(async () => {
  diagnostics = "";
  supervisor = spawn(resolve(root, "tooling/run-local-demo.sh"), [], {
    cwd: root,
    env: { ...process.env, PORT: "3001" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  supervisor.stdout?.on("data", (data) => {
    diagnostics = (diagnostics + data.toString()).slice(-16000);
  });
  supervisor.stderr?.on("data", (data) => {
    diagnostics = (diagnostics + data.toString()).slice(-16000);
  });
  const deadline = Date.now() + 120000;
  for (;;) {
    if (supervisor.exitCode !== null)
      throw new Error(`Owned supervisor exited during startup: ${diagnostics}`);
    try {
      const response = await fetch(`${origin}/api/config`);
      const config = await response.json();
      if (response.ok && config.mode === "local" && config.ready) break;
    } catch {
      /* Provisioning. */
    }
    if (Date.now() > deadline)
      throw new Error(`Owned chain startup timed out: ${diagnostics}`);
    await new Promise((r) => setTimeout(r, 300));
  }
});
test.afterEach(async ({}, info) => {
  if (supervisor && supervisor.exitCode === null) {
    const done = new Promise<void>((resolve) =>
      supervisor!.once("exit", () => resolve()),
    );
    supervisor.kill("SIGTERM");
    await Promise.race([
      done,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("Owned supervisor cleanup timed out")),
          15000,
        ),
      ),
    ]);
  }
  if (info.status !== info.expectedStatus)
    await info.attach("owned-supervisor-diagnostics", {
      body: diagnostics,
      contentType: "text/plain",
    });
});
async function action(
  page: Page,
  label: string,
  actionName: string,
): Promise<ActionResult> {
  const button = page.getByRole("button", { name: label, exact: true });
  await expect(button).toBeEnabled();
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url() === `${origin}/api/actions` &&
      response.request().method() === "POST",
  );
  await button.click();
  const response = await responsePromise;
  const result = await response.json();
  expect(response.ok(), JSON.stringify(result)).toBe(true);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  await expect(
    page.getByRole("status").filter({ hasText: result.message }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Waiting for receipts…" }),
  ).toHaveCount(0);
  return result;
}
async function fund(page: Page) {
  await action(page, "Initialize local market", "initialize");
  await page.getByRole("button", { name: "Lender", exact: true }).click();
  await action(page, "Fund offer + vault", "fund");
  await expect(page.getByTestId("vault-balance")).toHaveText("0.12 ETH");
  await page.getByRole("button", { name: "Borrower", exact: true }).click();
}
for (const scenario of ["repay", "default", "cancel"] as const) {
  test(`@chain real two-chain ${scenario} flow`, async ({ page }, info) => {
    const errors: string[] = [];
    const networkErrors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("requestfailed", (request) => {
      if (
        request.method() === "GET" &&
        new URL(request.url()).pathname.startsWith("/api/") &&
        request.failure()?.errorText === "net::ERR_ABORTED"
      )
        return;
      networkErrors.push(
        `${request.method()} ${request.url()}: ${request.failure()?.errorText}`,
      );
    });
    await page.goto(origin);
    await expect(
      page.getByText("Local two-chain demo", { exact: true }),
    ).toBeVisible();
    await fund(page);
    if (scenario === "cancel") {
      await page.getByText("Recovery & loan controls", { exact: true }).click();
      await action(page, "Cancel before borrowing", "cancel");
    } else {
      if (scenario === "repay") {
        await page.getByText("Test the safeguards", { exact: true }).click();
        const before = (await page.request
          .get(`${origin}/api/state`)
          .then((r) => r.json())) as State;
        await action(page, "Try forged proof", "challenge-forgery");
        const after = (await page.request
          .get(`${origin}/api/state`)
          .then((r) => r.json())) as State;
        expect(after.market?.borrower_balance_units).toBe(
          before.market?.borrower_balance_units,
        );
        expect(after.market?.debt_units).toBe(before.market?.debt_units);
        expect(after.market?.lender_balance_units).toBe(
          before.market?.lender_balance_units,
        );
        expect(after.market?.escrow_balance_units).toBe(
          before.market?.escrow_balance_units,
        );
        const receipts = (await page.request
          .get(`${origin}/api/receipts`)
          .then((r) => r.json())) as Receipt[];
        expect(
          receipts.some((r) => r.status === "rejected" && r.hash !== null),
        ).toBe(true);
      }
      await action(page, "Authenticate collateral", "prove");
      await action(page, "Borrow 100 CREDIT", "borrow");
      await expect(page.getByTestId("loan-debt")).toHaveText("101 CREDIT");
      await page.screenshot({
        path: `.cache/rino-browser/chain-${scenario}-${info.project.name}-active.png`,
        fullPage: true,
      });
      if (scenario === "repay") {
        const before = (await page.request
          .get(`${origin}/api/state`)
          .then((r) => r.json())) as State;
        await action(page, "Try duplicate borrow", "challenge-duplicate");
        const after = (await page.request
          .get(`${origin}/api/state`)
          .then((r) => r.json())) as State;
        expect(after.market?.borrower_balance_units).toBe(
          before.market?.borrower_balance_units,
        );
        expect(after.market?.debt_units).toBe("101000000");
        await action(page, "Repay 101 CREDIT", "repay");
      } else {
        await page.getByRole("button", { name: "Lender", exact: true }).click();
        await page
          .getByText("Recovery & loan controls", { exact: true })
          .click();
        await action(page, "Advance to maturity", "advance-maturity");
        await action(page, "Lock default", "default");
      }
    }
    await action(page, "Release collateral", "settle");
    if (scenario === "cancel") {
      await expect(
        page.getByText("Not borrowed · cancelled", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("Not required · cancellation", { exact: true }),
      ).toBeVisible();
    }
    await expect(page.getByTestId("settlement-stage")).toHaveText(
      "NEAR-authenticated release",
    );
    const state = (await page.request
      .get(`${origin}/api/state`)
      .then((r) => r.json())) as State;
    const receipts = (await page.request
      .get(`${origin}/api/receipts`)
      .then((r) => r.json())) as Receipt[];
    expect(state.market?.phase).toBe("Closed");
    expect(state.settlement?.stage).toBe("Complete");
    expect(state.settlement?.retired).toBe(true);
    expect(state.ethereum?.vaultBalanceWei).toBe("0");
    expect(
      receipts.some(
        (r) =>
          r.chain === "ethereum" &&
          r.status === "success" &&
          r.hash !== null &&
          r.gasUsed === "21000",
      ),
    ).toBe(true);
    if (scenario === "default") {
      expect(state.settlement?.lender_paid_wei).toBe("50500000000000000");
      expect(
        BigInt(state.settlement?.borrower_surplus_wei ?? "0"),
      ).toBeGreaterThan(0n);
    }
    if (scenario === "repay") {
      expect(state.market?.debt_units).toBe("0");
      expect(state.market?.borrower_balance_units).toBe("0");
    }
    await page.screenshot({
      path: `.cache/rino-browser/chain-${scenario}-${info.project.name}-complete.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Open evidence", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({
      path: `.cache/rino-browser/chain-${scenario}-${info.project.name}-evidence.png`,
      fullPage: true,
    });
    const serialized = JSON.stringify({ state, receipts });
    expect(serialized).not.toMatch(
      /secretKey|privateKey|mpcKey|sandbox-private|signerPath/,
    );
    expect(errors).toEqual([]);
    expect(networkErrors).toEqual([]);
    await mkdir(resolve(root, ".cache/rino-browser"), {
      recursive: true,
    });
    await writeFile(
      resolve(
        root,
        `.cache/rino-browser/chain-${scenario}-${info.project.name}-evidence.json`,
      ),
      JSON.stringify({ state, receipts, errors, networkErrors }, null, 2),
    );
  });
}

test("@refill real withdrawn CREDIT can be restored without depositing more ETH", async ({
  page,
}, info) => {
  await page.goto(origin);
  await fund(page);
  await page.getByRole("button", { name: "Lender", exact: true }).click();
  await page.getByText("Recovery & loan controls", { exact: true }).click();
  await action(page, "Claim lender CREDIT", "claim");
  const withdrawn = (await page.request
    .get(`${origin}/api/state`)
    .then((r) => r.json())) as State;
  const beforeReceipts = (await page.request
    .get(`${origin}/api/receipts`)
    .then((r) => r.json())) as Receipt[];
  expect(withdrawn.market?.phase).toBe("Offered");
  expect(withdrawn.market?.available_liquidity_units).toBe("0");
  expect(withdrawn.ethereum?.vaultBalanceWei).toBe("120000000000000000");
  await action(page, "Fund offer + vault", "fund");
  const restored = (await page.request
    .get(`${origin}/api/state`)
    .then((r) => r.json())) as State;
  const afterReceipts = (await page.request
    .get(`${origin}/api/receipts`)
    .then((r) => r.json())) as Receipt[];
  expect(restored.market?.available_liquidity_units).toBe("100000000");
  expect(restored.ethereum?.vaultBalanceWei).toBe(
    withdrawn.ethereum?.vaultBalanceWei,
  );
  expect(restored.ethereum?.vaultNonce).toBe(withdrawn.ethereum?.vaultNonce);
  expect(
    afterReceipts.filter((r) => r.chain === "ethereum" && r.action === "fund")
      .length,
  ).toBe(
    beforeReceipts.filter((r) => r.chain === "ethereum" && r.action === "fund")
      .length,
  );
  await page.getByRole("button", { name: "Borrower", exact: true }).click();
  await action(page, "Authenticate collateral", "prove");
  await action(page, "Borrow 100 CREDIT", "borrow");
  await expect(page.getByTestId("loan-debt")).toHaveText("101 CREDIT");
  await page.screenshot({
    path: `.cache/rino-browser/fix1-refill-active-${info.project.name}.png`,
    fullPage: true,
  });
  await mkdir(resolve(root, ".cache/rino-browser"), { recursive: true });
  await writeFile(
    resolve(
      root,
      `.cache/rino-browser/fix1-refill-${info.project.name}-evidence.json`,
    ),
    JSON.stringify(
      {
        withdrawn,
        restored,
        final: await page.request
          .get(`${origin}/api/state`)
          .then((r) => r.json()),
        receipts: afterReceipts,
      },
      null,
      2,
    ),
  );
});

test("@partial real partial collateral is funded by delta, reauthenticated and borrowed", async ({
  page,
}, info) => {
  await page.goto(origin);
  await action(page, "Initialize local market", "initialize");
  const config = await page.request
    .get(`${origin}/api/config`)
    .then((r) => r.json());
  const initial = (await page.request
    .get(`${origin}/api/state`)
    .then((r) => r.json())) as State;
  const rpc = async (method: string, params: unknown[]) => {
    expect(new URL(config.ethereum.rpcUrl).hostname).toBe("127.0.0.1");
    const response = await fetch(config.ethereum.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const data = await response.json();
    expect(data.error).toBeUndefined();
    return data.result;
  };
  const [from] = await rpc("eth_accounts", []);
  await rpc("eth_sendTransaction", [
    { from, to: initial.market!.vault, value: "0xb1a2bc2ec50000" },
  ]); // 0.05 ETH ordinary partial deposit, not setBalance.
  // General proof eligibility intentionally accepts any positive nonce-zero balance.
  const proof = await page.request.post(`${origin}/api/actions`, {
    headers: { "X-Rino-CSRF": config.csrfToken, Origin: origin },
    data: { action: "prove", role: "borrower" },
  });
  expect(proof.ok(), await proof.text()).toBe(true);
  const inadequate = (await page.request
    .get(`${origin}/api/state`)
    .then((r) => r.json())) as State;
  expect(inadequate.evidence?.balance_wei).toBe("50000000000000000");
  expect(inadequate.market?.proof_fresh).toBe(true);
  await page.reload();
  await expect(page.getByTestId("vault-balance")).toHaveText("0.05 ETH", {
    timeout: 10000,
  });
  await page.getByRole("button", { name: "Lender", exact: true }).click();
  await action(page, "Fund offer + vault", "fund");
  const topped = (await page.request
    .get(`${origin}/api/state`)
    .then((r) => r.json())) as State;
  expect(topped.ethereum?.vaultBalanceWei).toBe("120000000000000000");
  expect(topped.evidence?.balance_wei).toBe("50000000000000000");
  await page.getByRole("button", { name: "Borrower", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Authenticate collateral", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Borrow 100 CREDIT", exact: true }),
  ).toHaveCount(0);
  await action(page, "Authenticate collateral", "prove");
  await action(page, "Borrow 100 CREDIT", "borrow");
  const final = (await page.request
    .get(`${origin}/api/state`)
    .then((r) => r.json())) as State;
  const receipts = (await page.request
    .get(`${origin}/api/receipts`)
    .then((r) => r.json())) as Receipt[];
  expect(final.market?.phase).toBe("Active");
  expect(final.market?.debt_units).toBe("101000000");
  expect(final.evidence?.balance_wei).toBe("120000000000000000");
  expect(
    receipts.filter((r) => r.chain === "ethereum" && r.action === "fund"),
  ).toHaveLength(1);
  const funding = receipts.find(
    (r) => r.chain === "ethereum" && r.action === "fund",
  )!;
  const included = await rpc("eth_getTransactionByHash", [funding.hash]);
  expect(BigInt(included.value)).toBe(70000000000000000n);
  await page.screenshot({
    path: `.cache/rino-browser/partial-${info.project.name}.png`,
    fullPage: true,
  });
  await writeFile(
    resolve(
      root,
      `.cache/rino-browser/partial-${info.project.name}-evidence.json`,
    ),
    JSON.stringify({ inadequate, topped, final, receipts, included }, null, 2),
  );
});

import { it, expect } from "vitest";
import { createApp } from "../src/server.ts";
import type { LocalCoordinator } from "../src/local.ts";
it("public mode returns precise readiness without fixture state or keys and rejects action injection", async () => {
  const app = await createApp({ origin: "http://127.0.0.1:3000" });
  try {
    const config = (
      await app.inject({
        method: "GET",
        url: "/api/config",
        headers: { host: "127.0.0.1:3000" },
      })
    ).json();
    expect(config.mode).toBe("public");
    expect(config.near.rpcUrl).toBe("https://near-testnet.drpc.org");
    expect(config.ready).toBe(false);
    expect(config.readinessErrors.length).toBeGreaterThan(0);
    expect(JSON.stringify(config)).not.toMatch(
      /privateKey|mpcKey|signer|ed25519:/,
    );
    const state = (
      await app.inject({
        method: "GET",
        url: "/api/state",
        headers: { host: "127.0.0.1:3000" },
      })
    ).json();
    expect(state.market).toBe(null);
    expect(state.ethereum).toBe(null);
    const good = {
      host: "127.0.0.1:3000",
      origin: "http://127.0.0.1:3000",
      "x-proofcredit-csrf": config.csrfToken,
      "content-type": "application/json",
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/actions",
          headers: good,
          payload: { action: "borrow", role: "borrower" },
        })
      ).statusCode,
    ).toBe(409);
    for (const [headers, payload] of [
      [
        { ...good, host: "evil.test:3000" },
        { action: "borrow", role: "borrower" },
      ],
      [
        { ...good, origin: "https://evil.test" },
        { action: "borrow", role: "borrower" },
      ],
      [
        { ...good, "x-proofcredit-csrf": "" },
        { action: "borrow", role: "borrower" },
      ],
      [good, { action: "settle", role: "borrower", url: "https://evil.test" }],
    ])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/actions",
            headers,
            payload,
          })
        ).statusCode,
      ).toBeGreaterThanOrEqual(400);
  } finally {
    await app.close();
  }
});
it("preserves the owned Sandbox RPC URL supplied by the local manifest", async () => {
  const app = await createApp({
    origin: "http://127.0.0.1:3000",
    engine: {
      manifest: {
        nearUrl: "http://127.0.0.1:54321",
        anvilUrl: "http://127.0.0.1:54322",
      },
    } as unknown as LocalCoordinator,
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/config",
      headers: { host: "127.0.0.1:3000" },
    });
    expect(response.json().near).toMatchObject({
      networkId: "sandbox",
      rpcUrl: "http://127.0.0.1:54321",
    });
  } finally {
    await app.close();
  }
});

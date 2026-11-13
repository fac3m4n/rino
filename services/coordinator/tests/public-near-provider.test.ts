import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicNearProvider } from "../src/public-near-provider.ts";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const URL = "https://credential:secret@rpc.invalid/private-token";
function fetchFixture(
  respond: (id: string, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: unknown[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    calls.push([_url, init]);
    const body = JSON.parse(init.body as string);
    return respond(body.id, init);
  });
  return calls;
}
describe("bounded public NEAR provider", () => {
  it("retains SDK query/block/transaction APIs with one attempt", async () => {
    const calls = fetchFixture(
      (id) =>
        new Response(
          JSON.stringify({
            id,
            jsonrpc: "2.0",
            result: { header: { height: 101 } },
          }),
        ),
    );
    const p = createPublicNearProvider(URL);
    expect(await p.viewBlock({ blockId: "known" })).toEqual({
      header: { height: 101 },
    });
    expect(calls).toHaveLength(1);
    expect((calls[0] as any)[1].redirect).toBe("error");
    expect(JSON.stringify(p)).not.toContain("secret");
  });
  for (const method of [
    "send_tx",
    "broadcast_tx_commit",
    "EXPERIMENTAL_receipt",
    "validators",
  ])
    it(`denies ${method} before fetch`, async () => {
      const calls = fetchFixture(() => new Response("{}"));
      await expect(
        createPublicNearProvider(URL).sendJsonRpc(method as any, {} as any),
      ).rejects.toThrow("NEAR provider unavailable or response rejected");
      expect(calls).toHaveLength(0);
    });
  for (const [name, respond] of [
    ["HTTP", () => new Response("secret", { status: 500 })],
    [
      "redirect",
      () =>
        new Response("secret", {
          status: 302,
          headers: { Location: "https://other.invalid" },
        }),
    ],
    [
      "RPC",
      (id: string) =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id, error: { message: URL } }),
        ),
    ],
    [
      "wrong id",
      () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: "wrong", result: {} }),
        ),
    ],
    [
      "no result",
      (id: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id })),
    ],
    ["bad JSON", () => new Response("secret")],
    [
      "query error",
      (id: string) =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id, result: { error: URL } }),
        ),
    ],
    [
      "oversize header",
      () => new Response("{}", { headers: { "content-length": "262145" } }),
    ],
    ["oversize streamed body", () => new Response("x".repeat(262145))],
  ] as const)
    it(`redacts ${name} with no retries`, async () => {
      const calls = fetchFixture(respond);
      const p = createPublicNearProvider(URL);
      await expect(p.viewNodeStatus()).rejects.toThrow(
        /^NEAR provider unavailable or response rejected$/,
      );
      expect(calls).toHaveLength(1);
    });
  it("aborts a stalled body at fifteen seconds", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    fetchFixture((_id, init) => {
      signal = init.signal!;
      return new Response(new ReadableStream({ start() {} }));
    });
    const pending = createPublicNearProvider(URL).viewNodeStatus();
    const assertion = expect(pending).rejects.toThrow(
      /^NEAR provider unavailable or response rejected$/,
    );
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
    expect(signal?.aborted).toBe(true);
  });
  it("aborts stalled response headers and cleans its deadline", async () => {
    vi.useFakeTimers();
    fetchFixture(() => new Promise(() => {}));
    const pending = createPublicNearProvider(URL).viewNodeStatus();
    const assertion = expect(pending).rejects.toThrow(
      /^NEAR provider unavailable or response rejected$/,
    );
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("accepts the exact byte cap and denies one byte more", async () => {
    fetchFixture((id) => {
      const body = JSON.stringify({
        id,
        jsonrpc: "2.0",
        result: { ready: true },
      });
      return new Response(body + " ".repeat(262144 - Buffer.byteLength(body)));
    });
    expect(
      await createPublicNearProvider(URL).sendJsonRpc("status", []),
    ).toEqual({ ready: true });
  });
  it("redacts network rejection without another attempt", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      throw Error(URL);
    });
    await expect(
      createPublicNearProvider(URL).viewNodeStatus(),
    ).rejects.toThrow(/^NEAR provider unavailable or response rejected$/);
    expect(calls).toBe(1);
  });
  it("preserves null JSON RPC results", async () => {
    fetchFixture(
      (id) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id, result: null })),
    );
    expect(
      await createPublicNearProvider(URL).sendJsonRpc("query", {} as any),
    ).toBeNull();
  });
});

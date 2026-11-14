import { afterEach, describe, expect, it, vi } from "vitest";
import { readApi, submitAction, RequestFailure } from "../src/client";
import { configFixture } from "./fixtures";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("bounded browser transport", () => {
  for (const method of ["GET", "POST"] as const)
    for (const stall of ["headers", "body"] as const) {
      it(`bounds ${method} ${stall} delivery and marks only mutations uncertain`, async () => {
        vi.useFakeTimers();
        let signal: AbortSignal | undefined;
        let failure: unknown;
        vi.stubGlobal("fetch", (_url: unknown, init: RequestInit) => {
          signal = init.signal ?? undefined;
          if (stall === "headers") return new Promise<Response>(() => {});
          return Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"state":'));
                },
              }),
            ),
          );
        });
        const result =
          method === "GET"
            ? readApi("state", { timeoutMs: 10 })
            : submitAction(configFixture, "repay", "borrower", {
                timeoutMs: 10,
              });
        void result.catch((e) => {
          failure = e;
        });
        await vi.advanceTimersByTimeAsync(11);
        expect(failure).toBeInstanceOf(RequestFailure);
        expect((failure as RequestFailure).uncertainMutation).toBe(
          method === "POST",
        );
        expect(signal?.aborted).toBe(true);
      });
    }
  it("does not report a parsed server rejection as an uncertain mutation", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({ message: "Contract rejected repayment" }),
          { status: 400 },
        ),
    );
    await expect(
      submitAction(configFixture, "repay", "borrower", { timeoutMs: 10 }),
    ).rejects.toMatchObject({
      message: "Contract rejected repayment",
      uncertainMutation: false,
    });
  });
  it("marks a failed mutation transport uncertain instead of claiming payment failure", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Network lost");
    });
    await expect(
      submitAction(configFixture, "repay", "borrower", { timeoutMs: 10 }),
    ).rejects.toMatchObject({
      uncertainMutation: true,
      message: expect.stringContaining("uncertain"),
    });
  });
  it("honors caller cancellation even when the transport ignores its signal", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
    const cancel = new AbortController();
    let failure: unknown;
    void readApi("state", { timeoutMs: 100, signal: cancel.signal }).catch(
      (e) => {
        failure = e;
      },
    );
    cancel.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(failure).toBeInstanceOf(RequestFailure);
  });
});
it("requests fresh config/state only for explicit reconciliation or action boundaries", async () => {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (url: unknown) => {
    paths.push(String(url));
    return new Response("{}");
  });
  const { snapshot } = await import("../src/client");
  await snapshot();
  await snapshot({ fresh: true });
  expect(paths).toEqual([
    "/api/config",
    "/api/state",
    "/api/receipts",
    "/api/config?fresh=1",
    "/api/state?fresh=1",
    "/api/receipts",
  ]);
});
it("recovers public operation records before delivering an action-authorizing snapshot", async () => {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (url: unknown) => {
    paths.push(String(url));
    return new Response(
      JSON.stringify(
        String(url).endsWith("config")
          ? {
              ...configFixture,
              mode: "public",
              capabilities: { operations: true },
            }
          : String(url).endsWith("operations") ||
              String(url).endsWith("receipts")
            ? []
            : {},
      ),
    );
  });
  const { snapshot } = await import("../src/client");
  const recovered = await snapshot();
  expect(paths).toContain("/api/operations");
  expect(recovered).toHaveProperty("operations", []);
});
for (const bad of [{ unknown: [] }, [null], [{ id: "wrong" }]])
  it(`refuses malformed operation recovery instead of authorizing public actions (${JSON.stringify(bad)})`, async () => {
    vi.stubGlobal(
      "fetch",
      async (url: unknown) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("config")
              ? {
                  ...configFixture,
                  mode: "public",
                  capabilities: { operations: true },
                }
              : String(url).endsWith("operations")
                ? bad
                : String(url).endsWith("receipts")
                  ? []
                  : {},
          ),
        ),
    );
    const { snapshot } = await import("../src/client");
    await expect(snapshot()).rejects.toThrow();
  });
it("binds reads, mutation and operation recovery to the selected market API", async () => {
  const paths: string[] = [];
  vi.stubGlobal("fetch", async (url: unknown) => {
    paths.push(String(url));
    return Response.json(
      String(url).includes("config")
        ? {
            ...configFixture,
            mode: "public",
            capabilities: { operations: true },
          }
        : String(url).endsWith("operations") || String(url).endsWith("receipts")
          ? []
          : {},
    );
  });
  const { snapshot, postApi } = await import("../src/client");
  const options = { apiBase: "/api/markets/reserve" };
  await snapshot({ ...options, fresh: true });
  await submitAction(configFixture, "repay", "borrower", options);
  await postApi(configFixture, "operations/import", {}, options);
  expect(paths).toEqual([
    "/api/markets/reserve/config?fresh=1",
    "/api/markets/reserve/state?fresh=1",
    "/api/markets/reserve/receipts",
    "/api/markets/reserve/operations",
    "/api/markets/reserve/actions",
    "/api/markets/reserve/operations/import",
  ]);
});
for (const apiBase of [
  "https://other.invalid/api",
  "//other.invalid/api",
  "/api/markets/../primary",
  "/api/markets/reserve?market=primary",
  "/api/markets/a%2fb",
  "/api/",
])
  it(`rejects an unsafe market API before any wallet request is submitted (${apiBase})`, async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      submitAction(configFixture, "repay", "borrower", { apiBase }),
    ).rejects.toMatchObject({ uncertainMutation: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

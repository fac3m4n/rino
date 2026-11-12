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

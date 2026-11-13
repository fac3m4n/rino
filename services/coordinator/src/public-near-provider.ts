import { JsonRpcProvider } from "near-api-js";

const MESSAGE = "NEAR provider unavailable or response rejected";
const READ_METHODS = new Set([
  "status",
  "query",
  "block",
  "tx",
  "EXPERIMENTAL_tx_status",
]);
const MAX_BYTES = 262144;

/** Fixed-endpoint, read-only transport. One attempt, including a bounded body read. */
export function createPublicNearProvider(url: string): JsonRpcProvider {
  const provider = new JsonRpcProvider(
    { url },
    { retries: 1, wait: 0, backoff: 1 },
  );
  Object.defineProperty(provider, "toJSON", {
    value: () => ({ network: "testnet" }),
  });
  let nextId = 0;
  provider.sendJsonRpc = (async (method: string, params: unknown) => {
    if (!READ_METHODS.has(method)) throw Error(MESSAGE);
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Error(MESSAGE));
      }, 15000);
    });
    try {
      const id = String(++nextId);
      return await Promise.race([
        deadline,
        (async () => {
          const response = await fetch(url, {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          });
          if (!response.ok || response.redirected || !response.body)
            throw Error(MESSAGE);
          const length = response.headers.get("content-length");
          if (
            length !== null &&
            (!/^[0-9]+$/.test(length) || BigInt(length) > BigInt(MAX_BYTES))
          )
            throw Error(MESSAGE);
          reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            total += part.value.byteLength;
            if (total > MAX_BYTES) throw Error(MESSAGE);
            chunks.push(part.value);
          }
          const body = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const value = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(body),
          );
          if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            value.jsonrpc !== "2.0" ||
            value.id !== id ||
            Object.hasOwn(value, "error") ||
            !Object.hasOwn(value, "result")
          )
            throw Error(MESSAGE);
          if (
            value.result &&
            typeof value.result === "object" &&
            Object.hasOwn(value.result, "error")
          )
            throw Error(MESSAGE);
          return value.result;
        })(),
      ]);
    } catch {
      controller.abort();
      throw Error(MESSAGE);
    } finally {
      clearTimeout(timer);
      // A stalled stream's cancel promise need not settle; it cannot extend the deadline.
      void reader?.cancel().catch(() => {});
    }
  }) as typeof provider.sendJsonRpc;
  return provider;
}

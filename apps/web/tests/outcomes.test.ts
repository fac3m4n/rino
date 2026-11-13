import { expect, it } from "vitest";
import { submissionFailure, userRejected } from "../src/outcomes";

const nearHash = "11111111111111111111111111111111";
const ethHash = `0x${"a".repeat(64)}`;

it("retains a public hash from a bounded error cause without exposing raw error data", () => {
  const failure = submissionFailure(
    new Error("provider https://rpc.invalid/secret", {
      cause: Object.assign(new Error("ed25519:private-key"), {
        name: "TimeoutError",
        transactionHash: ethHash,
      }),
    }),
    [],
  );
  expect(failure).toMatchObject({
    outcome: "unknown",
    uncertainMutation: true,
    knownHashes: [ethHash],
    diagnostic: { category: "timeout", name: "TimeoutError" },
  });
  expect(`${failure.message}${JSON.stringify(failure)}`).not.toMatch(
    /rpc.invalid|secret|private-key/,
  );
});

it("a rejection carrying a validated hash remains uncertain alongside earlier batch hashes", () => {
  expect(
    submissionFailure({ code: 4001, transaction: { hash: nearHash } }, [
      ethHash,
    ]),
  ).toMatchObject({
    outcome: "partial",
    uncertainMutation: true,
    knownHashes: [ethHash, nearHash],
    diagnostic: { category: "rejected", code: "4001" },
  });
});

it("terminates cyclic cause chains and never invokes error getters", () => {
  const cycle: { cause?: unknown } = {};
  cycle.cause = { cause: cycle };
  expect(userRejected(cycle)).toBe(false);
  let reads = 0;
  const malicious = Object.defineProperties(
    {},
    Object.fromEntries(
      [
        "cause",
        "code",
        "name",
        "message",
        "hash",
        "transactionHash",
        "transaction",
        "transaction_outcome",
      ].map((key) => [
        key,
        {
          get() {
            reads++;
            throw new Error("untrusted getter");
          },
        },
      ]),
    ),
  );
  expect(submissionFailure(malicious, [])).toMatchObject({
    outcome: "unknown",
    knownHashes: [],
    diagnostic: { category: "unknown" },
  });
  expect(reads).toBe(0);
});

it("contains malformed proxy errors without consulting their prototype or accessors", () => {
  const error = new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("https://rpc.invalid/secret");
      },
      getOwnPropertyDescriptor() {
        throw new Error("ed25519:private-key");
      },
    },
  );
  expect(submissionFailure(error, [])).toMatchObject({
    outcome: "unknown",
    knownHashes: [],
    diagnostic: { category: "unknown" },
  });
});

it("retains independent bounded hints per chain and accepts the eighth cause node", () => {
  const hashes = [
    "11111111111111111111111111111111",
    "11111111111111111111111111111112",
    "11111111111111111111111111111113",
    "11111111111111111111111111111114",
    "11111111111111111111111111111115",
  ];
  let error: unknown = { transaction_outcome: { id: ethHash } };
  for (const hash of hashes.toReversed())
    error = { transaction: { hash }, cause: error };
  expect(submissionFailure(error, []).knownHashes).toEqual([
    ...hashes.slice(0, 4),
    ethHash,
  ]);
  let eighth: unknown = { transactionHash: ethHash, code: 4001 };
  for (let index = 0; index < 7; index++) eighth = { cause: eighth };
  expect(submissionFailure(eighth, [])).toMatchObject({
    outcome: "partial",
    knownHashes: [ethHash],
  });
});

it("ignores rejected codes and hashes beyond eight cause nodes", () => {
  let error: unknown = { code: 4001, hash: ethHash };
  for (let index = 0; index < 8; index++) error = { cause: error };
  expect(submissionFailure(error, [])).toMatchObject({
    outcome: "unknown",
    knownHashes: [],
    diagnostic: { category: "unknown" },
  });
});

it("accepts only validated bounded public hash hints, not nested data or forged status", () => {
  let error: unknown = { hash: `0x${"f".repeat(64)}` };
  for (let index = 4; index >= 0; index--)
    error = { hash: `0x${String(index).repeat(64)}`, cause: error };
  expect(submissionFailure(error, []).knownHashes).toEqual(
    [0, 1, 2, 3].map((index) => `0x${String(index).repeat(64)}`),
  );
  for (const hash of [
    "https://rpc.invalid/key",
    "ed25519:secret",
    "0".repeat(44),
    "z".repeat(44),
    "1".repeat(33),
  ]) {
    const failure = submissionFailure(
      {
        hash,
        name: "https://rpc.invalid/key",
        code: "secret",
        status: "success",
        data: { code: 4001, hash: ethHash },
      },
      [],
    );
    expect(failure).toMatchObject({
      outcome: "unknown",
      knownHashes: [],
      diagnostic: { category: "unknown" },
    });
    expect(JSON.stringify(failure)).not.toMatch(/rpc.invalid|secret|success/);
  }
});

it.each([
  [
    { name: "WalletError", message: "Wallet popup closed" },
    { category: "wallet-closed", name: "WalletError" },
  ],
  [{ name: "AbortError" }, { category: "timeout", name: "AbortError" }],
  [
    { name: "RpcError", code: "NETWORK_ERROR" },
    { category: "transport", name: "TransportError", code: "NETWORK_ERROR" },
  ],
  [
    { code: "ACTION_REJECTED" },
    { category: "rejected", code: "ACTION_REJECTED" },
  ],
])(
  "classifies fixed diagnostic labels without retaining messages (%j)",
  (error, diagnostic) => {
    expect(submissionFailure(error, []).diagnostic).toEqual(diagnostic);
  },
);

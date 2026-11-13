/** UI-only hash fixtures, not public chain evidence. */
import { expect, it } from "vitest";
import type { Config, Receipt } from "@rino/coordinator/api";
import { explorerUrl } from "../src/explorer";
import { configFixture } from "./fixtures";

const nearHash = "11111111111111111111111111111111";
const evmHash = `0x${"ab".repeat(32)}`;
const publicConfig: Config = {
  ...configFixture,
  mode: "public",
  near: { ...configFixture.near, networkId: "testnet" },
};

// Catches incorrect network routing and accidental public links for owned chains.
it("links validated hashes only to their configured public testnet", () => {
  expect(explorerUrl(publicConfig, "near", nearHash)).toBe(
    "https://testnet.nearblocks.io/txns/11111111111111111111111111111111",
  );
  expect(explorerUrl(publicConfig, "ethereum", evmHash)).toBe(
    `https://sepolia.etherscan.io/tx/0x${"ab".repeat(32)}`,
  );
  expect(explorerUrl(configFixture, "ethereum", evmHash)).toBeNull();
  expect(explorerUrl(configFixture, "near", nearHash)).toBeNull();
  expect(explorerUrl(undefined, "near", nearHash)).toBeNull();
  expect(
    explorerUrl(
      { ...publicConfig, near: { ...publicConfig.near, networkId: "sandbox" } },
      "near",
      nearHash,
    ),
  ).toBeNull();
  const unknown = {
    ...publicConfig,
    near: { ...publicConfig.near, networkId: "unknown" },
    ethereum: { ...publicConfig.ethereum, chainId: "1" },
  } as unknown as Config;
  expect(explorerUrl(unknown, "near", nearHash)).toBeNull();
  expect(explorerUrl(unknown, "ethereum", evmHash)).toBeNull();
});

// Catches accepting URL/path injection, wrong byte lengths, or worker IDs as transactions.
it("refuses worker, absent and malformed hashes without constructing a URL", () => {
  expect(explorerUrl(publicConfig, "worker", nearHash)).toBeNull();
  for (const chain of ["near", "ethereum"] as Receipt["chain"][]) {
    for (const hash of [
      null,
      undefined,
      "",
      "../transaction",
      "https://example.invalid/tx",
      "javascript:alert(1)",
      "1111111111111111111111111111111",
      "111111111111111111111111111111111",
      `0x${"ab".repeat(31)}`,
      `0x${"ab".repeat(33)}`,
      ` ${chain === "near" ? nearHash : evmHash}`,
    ]) {
      expect(explorerUrl(publicConfig, chain, hash)).toBeNull();
    }
  }
});

import { expect, it } from "vitest";
import type { NearConnector } from "@hot-labs/near-connect";
import { loadNearWalletOptions } from "../src/wallet-selector";

it("waits for the manifest and uses the SDK's network and feature filtered catalog", async () => {
  let ready!: () => void;
  let reads = 0;
  const sdk = {
    whenManifestLoaded: new Promise<void>((resolve) => {
      ready = resolve;
    }),
    get availableWallets() {
      reads++;
      return [{ manifest: { id: "meteor-wallet", name: "Meteor" } }];
    },
    wallets: [{ manifest: { id: "unsupported-wallet", name: "Unsupported" } }],
  } as unknown as NearConnector;
  const options = loadNearWalletOptions(sdk);
  await Promise.resolve();
  expect(reads).toBe(0);
  ready();
  expect(await options).toEqual([{ id: "meteor-wallet", name: "Meteor" }]);
  expect(reads).toBe(1);
});

it("retains injected wallet identifiers and plain names without exposing executors or icons", async () => {
  const manifest = {
    id: "injected.example",
    name: "Injected wallet",
    executor: "https://example.invalid/executor.js",
    icon: "https://example.invalid/icon.svg",
  };
  const sdk = {
    whenManifestLoaded: Promise.resolve(),
    availableWallets: [{ manifest }],
  } as unknown as NearConnector;
  expect(await loadNearWalletOptions(sdk)).toEqual([
    { id: manifest.id, name: manifest.name },
  ]);
});

it("returns an empty catalog rather than guessing a default wallet", async () => {
  const sdk = {
    whenManifestLoaded: Promise.resolve(),
    availableWallets: [],
  } as unknown as NearConnector;
  expect(await loadNearWalletOptions(sdk)).toEqual([]);
});

it("reports manifest readiness failures without silently retrying", async () => {
  const failure = Promise.reject(new Error("Manifest unavailable"));
  void failure.catch(() => {});
  const sdk = { whenManifestLoaded: failure } as unknown as NearConnector;
  await expect(loadNearWalletOptions(sdk)).rejects.toThrow(
    "Manifest unavailable",
  );
});

it("rejects ambiguous or malformed catalog identities instead of offering unaddressable choices", async () => {
  for (const availableWallets of [
    [{ manifest: { id: "", name: "Unnamed" } }],
    [{ manifest: { id: "wallet", name: "" } }],
    [
      { manifest: { id: "wallet", name: "Wallet" } },
      { manifest: { id: "wallet", name: "Duplicate" } },
    ],
  ]) {
    const sdk = {
      whenManifestLoaded: Promise.resolve(),
      availableWallets,
    } as unknown as NearConnector;
    await expect(loadNearWalletOptions(sdk)).rejects.toThrow(
      "Wallet list is invalid",
    );
  }
});

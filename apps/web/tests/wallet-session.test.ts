import { afterEach, expect, it, vi } from "vitest";
import type { Config } from "@proofcredit/coordinator/api";
import type { NearConnector } from "@hot-labs/near-connect";
import {
  WalletSession,
  NEAR_HINT_KEY,
  type Injected,
} from "../src/wallet-session";
import { configFixture } from "./fixtures";
const account = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const config: Config = {
  ...configFixture,
  mode: "public",
  near: { ...configFixture.near, networkId: "testnet" },
};
const hint = {
  version: 1,
  networkId: "testnet",
  walletId: "meteor-wallet",
  accountId: "borrower.test",
};
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function fixture(
  options: {
    stored?: unknown;
    restore?: Promise<unknown>;
    evm?: Promise<unknown>;
    storageFailure?: boolean;
  } = {},
) {
  const storage = new Map<string, string>();
  if (options.stored !== undefined)
    storage.set(
      NEAR_HINT_KEY,
      typeof options.stored === "string"
        ? options.stored
        : JSON.stringify(options.stored),
    );
  const listeners = new Map<string, (data: unknown) => void>();
  const nearListeners = new Map<string, (data: any) => void>();
  const wallet = {
    manifest: { id: "meteor-wallet" },
    getAccounts: vi.fn(async () => [
      { accountId: "lender.test" },
      { accountId: "borrower.test" },
    ]),
  };
  const sdk = {
    on: vi.fn((name: string, cb: (data: any) => void) =>
      nearListeners.set(name, cb),
    ),
    off: vi.fn((name: string) => nearListeners.delete(name)),
    getConnectedWallet: vi.fn(
      () =>
        options.restore ??
        Promise.resolve({
          wallet,
          accounts: [
            { accountId: "lender.test" },
            { accountId: "borrower.test" },
          ],
        }),
    ),
    connect: vi.fn(async () => {
      nearListeners.get("wallet:signIn")?.({
        wallet,
        accounts: [{ accountId: "borrower.test" }],
        success: true,
        source: "signIn",
      });
      return wallet;
    }),
    disconnect: vi.fn(async () => {}),
  };
  const provider = {
    request: vi.fn(({ method }: { method: string }) =>
      method === "eth_accounts"
        ? (options.evm ?? Promise.resolve([account]))
        : method === "eth_chainId"
          ? Promise.resolve("0xaa36a7")
          : Promise.reject(new Error(`Forbidden ${method}`)),
    ),
    on: (name: string, cb: (data: unknown) => void) => listeners.set(name, cb),
    removeListener: (name: string) => listeners.delete(name),
  };
  const factory = vi.fn(async () => sdk as unknown as NearConnector);
  const session = new WalletSession(factory, () => ({
    provider: provider as unknown as Injected,
    storage: {
      getItem: (key: string) => {
        if (options.storageFailure) throw new Error("Storage denied");
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (options.storageFailure) throw new Error("Storage denied");
        storage.set(key, value);
      },
      removeItem: (key: string) => storage.delete(key),
    },
  }));
  let state = { nearAccount: "" } as {
    nearAccount: string;
    evmAccount?: string;
    evmChainId?: number;
  };
  const start = (c = config) =>
    session.start(c, (value) => {
      state = value;
    });
  return {
    session,
    start,
    factory,
    sdk,
    storage,
    provider,
    listeners,
    nearListeners,
    state: () => state,
  };
}
async function settle() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}
afterEach(() => vi.useRealTimers());
it("restores exact hinted second account and silently checks Ethereum", async () => {
  const f = fixture({ stored: hint });
  f.start();
  await settle();
  expect(f.state()).toEqual({
    nearAccount: "borrower.test",
    evmAccount: account,
    evmChainId: 11155111,
  });
  expect(f.sdk.connect).not.toHaveBeenCalled();
  expect(f.provider.request.mock.calls.map(([p]) => p.method)).toEqual([
    "eth_accounts",
    "eth_chainId",
  ]);
});
for (const stored of [
  undefined,
  "{broken",
  { ...hint, version: 2 },
  { ...hint, networkId: "mainnet" },
  { ...hint, accountId: "" },
  { ...hint, accountId: "a..test" },
  { ...hint, privateKey: "forbidden" },
])
  it(`invalid public hint cannot cause SDK lookup (${JSON.stringify(stored)})`, async () => {
    const f = fixture({ stored });
    f.start();
    await settle();
    expect(f.state().nearAccount).toBe("");
    expect(f.factory).not.toHaveBeenCalled();
  });
it("fresh SDK wallet and exact membership must both match hint", async () => {
  for (const result of [
    {
      wallet: { manifest: { id: "wrong-wallet" } },
      accounts: [{ accountId: "borrower.test" }],
    },
    {
      wallet: { manifest: { id: "meteor-wallet" } },
      accounts: [{ accountId: "borrower.test.other" }],
    },
  ]) {
    const f = fixture({ stored: hint, restore: Promise.resolve(result) });
    f.start();
    await settle();
    expect(f.state().nearAccount).toBe("");
    expect(f.storage.has(NEAR_HINT_KEY)).toBe(false);
  }
});
it("StrictMode canceled probe and equivalent config perform only one live startup", async () => {
  const f = fixture({ stored: hint });
  const stop = f.start();
  stop();
  f.start({ ...config, near: { ...config.near } });
  await settle();
  expect(f.factory).toHaveBeenCalledTimes(1);
  expect(f.sdk.getConnectedWallet).toHaveBeenCalledTimes(1);
  expect(f.provider.request).toHaveBeenCalledTimes(2);
});
it("canceled startup does no SDK or provider work", async () => {
  const f = fixture({ stored: hint });
  f.start()();
  await settle();
  expect(f.factory).not.toHaveBeenCalled();
  expect(f.provider.request).not.toHaveBeenCalled();
});
it("missing/local/unsupported config never starts external sessions", async () => {
  for (const c of [
    undefined,
    { ...config, mode: "local" as const },
    { ...config, near: { ...config.near, networkId: "sandbox" as const } },
  ]) {
    const f = fixture({ stored: hint });
    f.session.start(c, () => {});
    await settle();
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.provider.request).not.toHaveBeenCalled();
  }
});
it("chain and account events supersede old pending Ethereum restoration", async () => {
  const old = deferred<unknown>();
  const f = fixture({ evm: old.promise });
  f.start();
  await settle();
  f.listeners.get("accountsChanged")?.([other]);
  f.listeners.get("chainChanged")?.("0x1");
  old.resolve([account]);
  await settle();
  expect(f.state()).toMatchObject({ evmAccount: other, evmChainId: 1 });
});
it("disconnect event cannot be undone by pending Ethereum reply", async () => {
  const old = deferred<unknown>();
  const f = fixture({ evm: old.promise });
  f.start();
  await settle();
  f.listeners.get("disconnect")?.({ code: 4900 });
  old.resolve([account]);
  await settle();
  expect(f.state().evmAccount).toBeUndefined();
  expect(f.state().evmChainId).toBeUndefined();
});
it("malformed events are total and cannot expose an invalid account or chain", async () => {
  const f = fixture();
  f.start();
  await settle();
  f.listeners.get("accountsChanged")?.(["garbage"]);
  f.listeners.get("chainChanged")?.("not-hex");
  expect(f.state().evmAccount).toBeUndefined();
  expect(f.state().evmChainId).toBeUndefined();
});
for (const accounts of [[], ["garbage"], "wrong", null])
  it(`invalid/empty Ethereum authorization cannot read chain or enable funding (${JSON.stringify(accounts)})`, async () => {
    const f = fixture({ evm: Promise.resolve(accounts) });
    f.start();
    await settle();
    expect(f.state().evmAccount).toBeUndefined();
    expect(f.provider.request).toHaveBeenCalledTimes(1);
  });
it("independent five-second deadline rejects late NEAR result while EVM restores", async () => {
  vi.useFakeTimers();
  const late = deferred<unknown>();
  const f = fixture({ stored: hint, restore: late.promise });
  f.start();
  await settle();
  expect(f.state().evmAccount).toBe(account);
  await vi.advanceTimersByTimeAsync(5001);
  late.resolve({
    wallet: { manifest: { id: "meteor-wallet" } },
    accounts: [{ accountId: "borrower.test" }],
  });
  await settle();
  expect(f.state().nearAccount).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});
it("independent five-second EVM deadline does not block NEAR and suppresses late reply", async () => {
  vi.useFakeTimers();
  const late = deferred<unknown>();
  const f = fixture({ stored: hint, evm: late.promise });
  f.start();
  await settle();
  expect(f.state().nearAccount).toBe("borrower.test");
  await vi.advanceTimersByTimeAsync(5001);
  late.resolve([account]);
  await settle();
  expect(f.state().evmAccount).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});
it("explicit disconnect invalidates pending restore and clears only after success", async () => {
  const old = deferred<unknown>();
  const f = fixture({ stored: hint, restore: old.promise });
  f.start();
  await settle();
  await f.session.disconnectNear();
  old.resolve({
    wallet: { manifest: { id: "meteor-wallet" } },
    accounts: [{ accountId: "borrower.test" }],
  });
  await settle();
  expect(f.state().nearAccount).toBe("");
  expect(f.storage.has(NEAR_HINT_KEY)).toBe(false);
});
it("failed explicit disconnect preserves prior account and exact hint", async () => {
  const f = fixture({ stored: hint });
  f.start();
  await settle();
  f.sdk.disconnect.mockRejectedValueOnce(new Error("signout failed"));
  await expect(f.session.disconnectNear()).rejects.toThrow("signout failed");
  expect(f.state().nearAccount).toBe("borrower.test");
  expect(JSON.parse(f.storage.get(NEAR_HINT_KEY)!)).toEqual(hint);
});
it("overlapping explicit NEAR mutations are rejected before SDK storage can race", async () => {
  const pending = deferred<any>();
  const f = fixture();
  f.start();
  await settle();
  f.sdk.connect.mockReturnValueOnce(pending.promise);
  const connect = f.session.connectNear(config);
  await settle();
  await expect(f.session.disconnectNear()).rejects.toThrow(/progress/);
  await expect(f.session.connectNear(config)).rejects.toThrow(/progress/);
  expect(f.sdk.connect).toHaveBeenCalledTimes(1);
  expect(f.sdk.disconnect).not.toHaveBeenCalled();
  pending.resolve({});
  await connect;
});
it("storage denial cannot break explicit selection", async () => {
  const f = fixture({ storageFailure: true });
  f.start();
  await settle();
  await f.session.connectNear(config);
  expect(f.state().nearAccount).toBe("borrower.test");
});
it("unmount detaches listeners and ignores pending identities and late rejection", async () => {
  vi.useFakeTimers();
  const late = deferred<unknown>();
  const f = fixture({ stored: hint, restore: late.promise });
  const stop = f.start();
  await settle();
  stop();
  const previous = f.state();
  late.reject(new Error("late"));
  await settle();
  expect(f.state()).toEqual(previous);
  expect(f.listeners.size).toBe(0);
  expect(f.nearListeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("configuration replacement clears exposed sessions before unsupported mode can use them", async () => {
  const f = fixture({ stored: hint });
  const stop = f.start();
  await settle();
  expect(f.state().nearAccount).toBe("borrower.test");
  stop();
  f.start({ ...config, mode: "local" });
  await settle();
  expect(f.state()).toEqual({ nearAccount: "" });
});
it("explicit Ethereum connection revisions cannot publish after disposal", async () => {
  const f = fixture();
  const stop = f.start();
  await settle();
  const revision = f.session.invalidateEvm();
  stop();
  f.session.setEvm(revision, other, 1);
  const snapshot = f.state();
  f.start({ ...config, mode: "local" });
  await settle();
  expect(f.state()).toEqual({ nearAccount: "" });
  expect(snapshot.evmAccount).toBe(account);
});
it("late SDK signIn outside the current explicit connect cannot resurrect disconnected identity", async () => {
  const f = fixture({ stored: hint });
  f.start();
  await settle();
  await f.session.connectNear(config);
  const event = f.sdk.on.mock.calls.find(
    ([name]) => name === "wallet:signIn",
  )![1];
  await f.session.disconnectNear();
  event({
    success: true,
    wallet: { manifest: { id: "meteor-wallet" } },
    accounts: [{ accountId: "borrower.test" }],
  });
  expect(f.state().nearAccount).toBe("");
  expect(f.storage.has(NEAR_HINT_KEY)).toBe(false);
});

it("Ethereum rejection leaves NEAR independently restored and never requests permission", async () => {
  const pending = deferred<unknown>();
  const f = fixture({ stored: hint, evm: pending.promise });
  f.start();
  await settle();
  pending.reject(new Error("locked"));
  await settle();
  expect(f.state().nearAccount).toBe("borrower.test");
  expect(f.state().evmAccount).toBeUndefined();
  expect(f.provider.request.mock.calls.map(([p]) => p.method)).toEqual([
    "eth_accounts",
  ]);
});
it("malformed Ethereum chain response cannot expose a restored session", async () => {
  const f = fixture();
  f.provider.request.mockImplementation(({ method }) =>
    Promise.resolve(method === "eth_accounts" ? [account] : "0x0garbage"),
  );
  f.start();
  await settle();
  expect(f.state().evmAccount).toBeUndefined();
  expect(f.state().evmChainId).toBeUndefined();
});
it("SDK restore rejection leaves the hint available for deliberate retry without retry loops", async () => {
  const pending = deferred<unknown>();
  const f = fixture({ stored: hint, restore: pending.promise });
  f.start();
  await settle();
  pending.reject(new Error("unavailable"));
  await settle();
  expect(f.state().nearAccount).toBe("");
  expect(f.sdk.getConnectedWallet).toHaveBeenCalledTimes(1);
  expect(f.sdk.connect).not.toHaveBeenCalled();
  expect(JSON.parse(f.storage.get(NEAR_HINT_KEY)!)).toEqual(hint);
});
it("deliberate connect supersedes a pending stale NEAR restore", async () => {
  const pending = deferred<unknown>();
  const f = fixture({
    stored: { ...hint, accountId: "lender.test" },
    restore: pending.promise,
  });
  f.start();
  await settle();
  await f.session.connectNear(config);
  pending.resolve({
    wallet: { manifest: { id: "meteor-wallet" } },
    accounts: [{ accountId: "lender.test" }],
  });
  await settle();
  expect(f.state().nearAccount).toBe("borrower.test");
  expect(JSON.parse(f.storage.get(NEAR_HINT_KEY)!)).toEqual(hint);
  expect(f.factory).toHaveBeenCalledTimes(1);
});

it("old signIn callback cannot select an account for a later explicit connection", async () => {
  const f = fixture();
  f.start();
  await settle();
  let oldEvent!: (data: unknown) => void;
  f.sdk.connect.mockImplementationOnce(async () => {
    oldEvent = f.nearListeners.get("wallet:signIn")!;
    oldEvent({
      success: true,
      wallet: { manifest: { id: "meteor-wallet" } },
      accounts: [{ accountId: "borrower.test" }],
    });
    return {} as never;
  });
  await f.session.connectNear(config);
  await f.session.disconnectNear();
  const pending = deferred<any>();
  f.sdk.connect.mockReturnValueOnce(pending.promise);
  const second = f.session.connectNear(config);
  await settle();
  oldEvent({
    success: true,
    wallet: { manifest: { id: "meteor-wallet" } },
    accounts: [{ accountId: "lender.test" }],
  });
  pending.resolve({});
  await second;
  expect(f.state().nearAccount).toBe("");
  expect(f.storage.has(NEAR_HINT_KEY)).toBe(false);
});

it("malformed SDK restoration data fails closed without an unhandled continuation", async () => {
  const f = fixture({
    stored: hint,
    restore: Promise.resolve({ accounts: [null] }),
  });
  f.start();
  await settle();
  expect(f.state().nearAccount).toBe("");
  expect(f.storage.has(NEAR_HINT_KEY)).toBe(false);
});

it("permission grant accountsChanged for the requested account completes explicit Sepolia connection", async () => {
  const f = fixture({ evm: Promise.resolve([]) });
  f.start();
  await settle();
  await f.session.connectEvm(
    async () => {
      f.listeners.get("accountsChanged")?.([account]);
      return [account];
    },
    async () => 11155111,
  );
  expect(f.state()).toMatchObject({
    evmAccount: account,
    evmChainId: 11155111,
  });
});
for (const event of ["different-account", "disconnect", "chain"])
  it(`explicit Ethereum connection preserves a competing ${event} event during permission grant`, async () => {
    const f = fixture({ evm: Promise.resolve([]) });
    f.start();
    await settle();
    await f.session.connectEvm(
      async () => {
        f.listeners.get("accountsChanged")?.([account]);
        if (event === "different-account")
          f.listeners.get("accountsChanged")?.([other]);
        if (event === "disconnect")
          f.listeners.get("disconnect")?.({ code: 4900 });
        if (event === "chain") f.listeners.get("chainChanged")?.("0x1");
        return [account];
      },
      async () => 11155111,
    );
    expect(f.state().evmAccount).toBe(
      event === "disconnect"
        ? undefined
        : event === "different-account"
          ? other
          : account,
    );
    expect(f.state().evmChainId).toBe(event === "chain" ? 1 : undefined);
  });
for (const event of ["different-account", "disconnect", "chain"])
  it(`fresh explicit Ethereum chain read cannot overwrite a later ${event} event`, async () => {
    const f = fixture({ evm: Promise.resolve([]) });
    f.start();
    await settle();
    const chain = deferred<number>();
    const reading = vi.fn(() => chain.promise);
    const pending = f.session.connectEvm(async () => {
      f.listeners.get("accountsChanged")?.([account]);
      return [account];
    }, reading);
    await settle();
    expect(reading).toHaveBeenCalledTimes(1);
    if (event === "different-account")
      f.listeners.get("accountsChanged")?.([other]);
    if (event === "disconnect") f.listeners.get("disconnect")?.({ code: 4900 });
    if (event === "chain") f.listeners.get("chainChanged")?.("0x1");
    chain.resolve(11155111);
    await pending;
    expect(f.state().evmAccount).toBe(
      event === "disconnect"
        ? undefined
        : event === "different-account"
          ? other
          : account,
    );
    expect(f.state().evmChainId).toBe(event === "chain" ? 1 : undefined);
  });

it("an older explicit permission result cannot bind to a newer matching-account operation", async () => {
  const f = fixture({ evm: Promise.resolve([]) });
  f.start();
  await settle();
  const firstAccount = deferred<readonly `0x${string}`[]>();
  const staleChain = vi.fn(async () => 11155111);
  const first = f.session.connectEvm(() => firstAccount.promise, staleChain);
  await f.session.connectEvm(
    async () => {
      f.listeners.get("accountsChanged")?.([account]);
      return [account];
    },
    async () => 1,
  );
  firstAccount.resolve([account]);
  await first;
  expect(f.state()).toMatchObject({ evmAccount: account, evmChainId: 1 });
  expect(staleChain).not.toHaveBeenCalled();
});
it("disconnect followed by matching account event cannot revive an older permission result", async () => {
  const f = fixture({ evm: Promise.resolve([]) });
  f.start();
  await settle();
  const chain = vi.fn(async () => 11155111);
  await f.session.connectEvm(async () => {
    f.listeners.get("disconnect")?.({ code: 4900 });
    f.listeners.get("accountsChanged")?.([account]);
    return [account];
  }, chain);
  expect(f.state()).toMatchObject({
    evmAccount: account,
    evmChainId: undefined,
  });
  expect(chain).not.toHaveBeenCalled();
});

it("a delayed matching permission account event still accepts its fresh pending chain read", async () => {
  const f = fixture({ evm: Promise.resolve([]) });
  f.start();
  await settle();
  const chain = deferred<number>();
  const reading = vi.fn(() => chain.promise);
  const pending = f.session.connectEvm(async () => [account], reading);
  await settle();
  expect(reading).toHaveBeenCalledTimes(1);
  f.listeners.get("accountsChanged")?.([account]);
  chain.resolve(11155111);
  await pending;
  expect(f.state()).toMatchObject({
    evmAccount: account,
    evmChainId: 11155111,
  });
});

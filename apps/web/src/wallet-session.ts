import type { NearConnector, EventMap } from "@hot-labs/near-connect";
import type { Config } from "@rino/coordinator/api";
import type { Address, EIP1193Provider } from "viem";

export const NEAR_HINT_KEY = "rino.wallet.near.v1";
type Hint = {
  version: 1;
  networkId: "testnet";
  walletId: string;
  accountId: string;
};
export type Injected = EIP1193Provider & {
  on?: (name: string, listener: (data: unknown) => void) => void;
  removeListener?: (name: string, listener: (data: unknown) => void) => void;
};
type Snapshot = {
  nearAccount: string;
  evmAccount?: Address;
  evmChainId?: number;
};
type Environment = {
  provider?: Injected;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
};
function supported(config?: Config): config is Config {
  return config?.mode === "public" && config.near.networkId === "testnet";
}
function accountId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 2 &&
    value.length <= 64 &&
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value)
  );
}
function address(value: unknown): Address | undefined {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? (value as Address)
    : undefined;
}
function chainId(value: unknown): number | undefined {
  if (
    typeof value !== "string" ||
    !/^0x[0-9a-f]+$/i.test(value) ||
    value.length > 16
  )
    return;
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : undefined;
}
export function walletEnvironment(): Environment {
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    /* Public metadata is best effort. */
  }
  return {
    provider: (window as unknown as { ethereum?: Injected }).ethereum,
    storage,
  };
}

/** Public display sessions only. Signing authority is always freshly checked by wallets.ts. */
export class WalletSession {
  private snapshot: Snapshot = { nearAccount: "" };
  private publish?: (value: Snapshot) => void;
  private active = false;
  private lifecycle = 0;
  private nearRevision = 0;
  private evmRevision = 0;
  private evmOperation = 0;
  private evmDisconnected = false;
  private evmChainEventRevision = 0;
  private connector?: Promise<NearConnector>;
  private sdk?: NearConnector;
  private sdkAttached = false;
  private binding?: string;
  private operation?: {
    kind: "connect" | "disconnect";
    revision: number;
    selection?: { walletId: string; accounts: { accountId: string }[] };
  };
  private cancellations = new Set<() => void>();
  constructor(
    private factory: (config: Config) => Promise<NearConnector>,
    private environment: () => Environment = walletEnvironment,
  ) {}
  private update(value: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...value };
    if (this.active) this.publish?.({ ...this.snapshot });
  }
  private storage() {
    try {
      return this.environment().storage;
    } catch {
      return;
    }
  }
  private clearHint() {
    try {
      this.storage()?.removeItem(NEAR_HINT_KEY);
    } catch {
      /* Best effort. */
    }
  }
  private readHint(): Hint | undefined {
    try {
      const raw = this.storage()?.getItem(NEAR_HINT_KEY);
      if (!raw) return;
      if (raw.length > 512) throw new Error("Oversized hint");
      const value = JSON.parse(raw);
      if (
        !value ||
        Object.keys(value).sort().join(",") !==
          "accountId,networkId,version,walletId" ||
        value.version !== 1 ||
        value.networkId !== "testnet" ||
        typeof value.walletId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(value.walletId) ||
        !accountId(value.accountId)
      )
        throw new Error("Invalid public hint");
      return value;
    } catch {
      this.clearHint();
      return;
    }
  }
  selectNear(walletId: string, accounts: { accountId: string }[]) {
    const selected =
      accounts.length === 1 && accountId(accounts[0]?.accountId)
        ? accounts[0].accountId
        : "";
    this.nearRevision++;
    this.update({ nearAccount: selected });
    if (!selected || !/^[a-zA-Z0-9_-]{1,80}$/.test(walletId)) {
      this.clearHint();
      return;
    }
    try {
      this.storage()?.setItem(
        NEAR_HINT_KEY,
        JSON.stringify({
          version: 1,
          networkId: "testnet",
          walletId,
          accountId: selected,
        } satisfies Hint),
      );
    } catch {
      /* Explicit connection works without storage. */
    }
  }
  private signIn?: (payload: EventMap["wallet:signIn"]) => void;
  private signOut = () => {
    if (!this.active || this.operation) return;
    this.nearRevision++;
    this.update({ nearAccount: "" });
    this.clearHint();
  };
  private attach() {
    if (!this.sdk || this.sdkAttached || !this.active) return;
    this.sdk.on("wallet:signOut", this.signOut);
    this.sdkAttached = true;
  }
  async getConnector(config: Config): Promise<NearConnector> {
    if (!supported(config))
      throw new Error(
        "External wallets are available in public testnet mode only.",
      );
    const binding = config.near.rpcUrl;
    if (this.binding && this.binding !== binding)
      throw new Error(
        "Wallet configuration changed. Reload before connecting.",
      );
    this.binding = binding;
    this.connector ??= this.factory(config)
      .then((sdk) => {
        this.sdk = sdk;
        this.attach();
        return sdk;
      })
      .catch((error) => {
        this.connector = undefined;
        throw error;
      });
    return this.connector;
  }
  private bounded<T>(
    promise: Promise<T>,
    accept: (value: T) => void,
    failed: () => void,
  ) {
    let pending = true;
    const finish = () => {
      if (!pending) return false;
      pending = false;
      clearTimeout(timer);
      this.cancellations.delete(cancel);
      return true;
    };
    const cancel = () => {
      finish();
    };
    const timer = setTimeout(() => {
      if (finish()) failed();
    }, 5000);
    this.cancellations.add(cancel);
    promise.then(
      (value) => {
        if (finish()) accept(value);
      },
      () => {
        if (finish()) failed();
      },
    );
  }
  start(
    config: Config | undefined,
    publish: (value: Snapshot) => void,
  ): () => void {
    this.active = true;
    this.publish = publish;
    this.snapshot = { nearAccount: "" };
    this.publish({ ...this.snapshot });
    const lifecycle = ++this.lifecycle;
    this.attach();
    let remove = () => {};
    // React's canceled StrictMode probe must perform no SDK/provider work.
    queueMicrotask(() => {
      if (!this.active || this.lifecycle !== lifecycle || !supported(config))
        return;
      const { provider } = this.environment();
      if (provider) {
        const event = (update: Partial<Snapshot>) => {
          if (this.evmDisconnected) return;
          this.evmRevision++;
          this.update(update);
        };
        const accounts = (list: unknown) => {
          const evmAccount = Array.isArray(list) ? address(list[0]) : undefined;
          event({
            evmAccount,
            ...(!evmAccount ? { evmChainId: undefined } : {}),
          });
          if (!evmAccount) this.evmChainEventRevision = this.evmRevision;
        };
        const chain = (id: unknown) => {
          event({ evmChainId: chainId(id) });
          this.evmChainEventRevision = this.evmRevision;
        };
        const disconnect = () => {
          event({ evmAccount: undefined, evmChainId: undefined });
          this.evmChainEventRevision = this.evmRevision;
        };
        provider.on?.("accountsChanged", accounts);
        provider.on?.("chainChanged", chain);
        provider.on?.("disconnect", disconnect);
        remove = () => {
          provider.removeListener?.("accountsChanged", accounts);
          provider.removeListener?.("chainChanged", chain);
          provider.removeListener?.("disconnect", disconnect);
        };
        const revision = this.evmRevision;
        const current = () =>
          this.active &&
          this.lifecycle === lifecycle &&
          this.evmRevision === revision;
        const restore = async () => {
          if (this.evmDisconnected) return {};
          const accounts = await provider.request({ method: "eth_accounts" });
          const evmAccount = Array.isArray(accounts)
            ? address(accounts[0])
            : undefined;
          if (!evmAccount || !current()) return {};
          const id = await provider.request({ method: "eth_chainId" });
          const evmChainId = chainId(id);
          return evmChainId ? { evmAccount, evmChainId } : {};
        };
        this.bounded(
          restore(),
          (value) => {
            if (current())
              this.update({
                evmAccount: undefined,
                evmChainId: undefined,
                ...value,
              });
          },
          () => {
            if (current()) {
              this.evmRevision++;
              this.update({ evmAccount: undefined, evmChainId: undefined });
            }
          },
        );
      }
      const hint = this.readHint();
      if (hint) {
        const revision = this.nearRevision;
        const current = () =>
          this.active &&
          this.lifecycle === lifecycle &&
          this.nearRevision === revision;
        this.bounded(
          this.getConnector(config).then((sdk) =>
            current() ? sdk.getConnectedWallet() : undefined,
          ),
          (result) => {
            if (!current()) return;
            if (
              result?.wallet?.manifest?.id === hint.walletId &&
              Array.isArray(result.accounts) &&
              result.accounts.some((item) => item?.accountId === hint.accountId)
            )
              this.update({ nearAccount: hint.accountId });
            else {
              this.update({ nearAccount: "" });
              this.clearHint();
            }
          },
          () => {
            if (current()) {
              this.nearRevision++;
              this.update({ nearAccount: "" });
            }
          },
        );
      }
    });
    return () => {
      if (this.lifecycle !== lifecycle) return;
      this.active = false;
      this.lifecycle++;
      this.nearRevision++;
      this.evmRevision++;
      remove();
      for (const cancel of this.cancellations) cancel();
      if (this.sdkAttached) {
        if (this.signIn) this.sdk?.off("wallet:signIn", this.signIn);
        this.signIn = undefined;
        this.sdk?.off("wallet:signOut", this.signOut);
        this.sdkAttached = false;
      }
    };
  }
  async connectNear(config: Config, walletId?: string) {
    if (this.operation)
      throw new Error("A NEAR wallet operation is already in progress.");
    const operation = {
      kind: "connect" as const,
      revision: ++this.nearRevision,
      selection: undefined as
        { walletId: string; accounts: { accountId: string }[] } | undefined,
    };
    this.operation = operation;
    const lifecycle = this.lifecycle;
    try {
      const sdk = await this.getConnector(config);
      if (walletId) {
        await sdk.whenManifestLoaded;
        if (
          !sdk.availableWallets.some(
            (wallet) => wallet.manifest.id === walletId,
          )
        )
          throw new Error("The selected NEAR wallet is not available.");
      }
      if (!this.active || lifecycle !== this.lifecycle)
        throw new Error("Wallet session changed before connection.");
      const listener = (payload: EventMap["wallet:signIn"]) => {
        if (
          !this.active ||
          lifecycle !== this.lifecycle ||
          this.operation !== operation ||
          operation.revision !== this.nearRevision
        )
          return;
        if (
          payload.success &&
          payload.wallet?.manifest?.id &&
          Array.isArray(payload.accounts)
        )
          operation.selection = {
            walletId: payload.wallet.manifest.id,
            accounts: payload.accounts,
          };
      };
      this.signIn = listener;
      sdk.on("wallet:signIn", listener);
      if (walletId) await sdk.connect({ walletId });
      else await sdk.connect();
      if (
        this.active &&
        lifecycle === this.lifecycle &&
        operation.revision === this.nearRevision &&
        operation.selection
      )
        this.selectNear(
          operation.selection.walletId,
          operation.selection.accounts,
        );
    } finally {
      if (this.signIn) this.sdk?.off("wallet:signIn", this.signIn);
      this.signIn = undefined;
      if (this.operation === operation) this.operation = undefined;
    }
  }
  async disconnectNear() {
    if (this.operation)
      throw new Error("A NEAR wallet operation is already in progress.");
    const operation = {
      kind: "disconnect" as const,
      revision: ++this.nearRevision,
    };
    this.operation = operation;
    const lifecycle = this.lifecycle;
    try {
      await this.sdk?.disconnect();
      if (
        this.active &&
        lifecycle === this.lifecycle &&
        operation.revision === this.nearRevision
      ) {
        this.update({ nearAccount: "" });
        this.clearHint();
      }
    } finally {
      if (this.operation === operation) this.operation = undefined;
    }
  }
  async connectEvm(
    requestAddresses: () => Promise<readonly Address[]>,
    getChainId: () => Promise<number>,
  ) {
    const revision = this.invalidateEvm();
    this.evmDisconnected = false;
    const operation = this.evmOperation;
    const lifecycle = this.lifecycle;
    const current = () =>
      this.active &&
      lifecycle === this.lifecycle &&
      operation === this.evmOperation;
    const [selected] = await requestAddresses();
    const account = address(selected);
    if (!account || !current()) return;
    // Permission grants may emit the same account before or after their reply.
    // Account-only events can share this read; chain/revocation events form a barrier.
    const accepts = (since: number) =>
      this.evmRevision === since ||
      (this.evmChainEventRevision <= since &&
        this.snapshot.evmAccount?.toLowerCase() === account.toLowerCase());
    if (!accepts(revision)) return;
    const chainRevision = this.evmRevision;
    const evmChainId = await getChainId();
    if (current() && accepts(chainRevision))
      this.setEvm(this.evmRevision, account, evmChainId);
  }

  invalidateEvm() {
    this.evmOperation++;
    return ++this.evmRevision;
  }
  disconnectEvm() {
    this.evmDisconnected = true;
    this.invalidateEvm();
    this.update({ evmAccount: undefined, evmChainId: undefined });
  }
  setEvm(revision: number, evmAccount?: Address, evmChainId?: number) {
    if (revision === this.evmRevision) this.update({ evmAccount, evmChainId });
  }
}

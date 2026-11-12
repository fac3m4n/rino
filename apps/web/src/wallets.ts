import { useEffect, useRef, useState } from "react";
import type { NearConnector } from "@hot-labs/near-connect";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type EIP1193Provider,
} from "viem";
import { sepolia } from "viem/chains";
import type { Config, WalletAction } from "@proofcredit/coordinator/api";
import { ActionFailure, submissionFailure } from "./outcomes";

type Injected = EIP1193Provider & {
  on?: (name: string, listener: (data: unknown) => void) => void;
  removeListener?: (name: string, listener: (data: unknown) => void) => void;
};
function injected(): Injected {
  const provider = (window as unknown as { ethereum?: Injected }).ethereum;
  if (!provider)
    throw new Error("Install an Ethereum wallet to connect to Sepolia.");
  return provider;
}
export function useWallets() {
  const connector = useRef<NearConnector | null>(null);
  const [nearAccount, setNear] = useState("");
  const [evmAccount, setEvm] = useState<Address>();
  const [evmChainId, setChain] = useState<number>();
  useEffect(() => {
    const provider = (window as unknown as { ethereum?: Injected }).ethereum;
    if (!provider) return;
    const chain = (id: unknown) =>
      setChain(typeof id === "string" ? Number(BigInt(id)) : undefined);
    const accounts = (list: unknown) =>
      setEvm(Array.isArray(list) ? (list[0] as Address) : undefined);
    provider.on?.("chainChanged", chain);
    provider.on?.("accountsChanged", accounts);
    return () => {
      provider.removeListener?.("chainChanged", chain);
      provider.removeListener?.("accountsChanged", accounts);
    };
  }, []);
  async function nearConnector(config: Config) {
    if (config.mode !== "public" || config.near.networkId !== "testnet")
      throw new Error(
        "External wallets are available in public testnet mode only.",
      );
    if (!connector.current) {
      const { NearConnector } = await import("@hot-labs/near-connect");
      connector.current = new NearConnector({
        network: "testnet",
        providers: { testnet: [config.near.rpcUrl] },
        features: { testnet: true, signAndSendTransaction: true },
      });
      connector.current.on("wallet:signIn", ({ accounts }) =>
        setNear(accounts[0]?.accountId ?? ""),
      );
      connector.current.on("wallet:signOut", () => setNear(""));
    }
    return connector.current;
  }
  return {
    nearAccount,
    evmAccount,
    evmChainId,
    async connectNear(config: Config) {
      const wallet = await (await nearConnector(config)).connect();
      setNear(
        (await wallet.getAccounts({ network: "testnet" }))[0]?.accountId ?? "",
      );
    },
    async connectEvm() {
      const client = createWalletClient({
        chain: sepolia,
        transport: custom(injected()),
      });
      const [account] = await client.requestAddresses();
      setEvm(account);
      setChain(await client.getChainId());
    },
    async switchEvm() {
      await createWalletClient({ transport: custom(injected()) }).switchChain({
        id: sepolia.id,
      });
      setChain(sepolia.id);
    },
    async sendNear(
      config: Config,
      actions: WalletAction[],
      expectedAccount: string,
    ) {
      // Validate the complete batch before the first irreversible wallet action.
      for (const action of actions) {
        if (
          action.chain !== "near" ||
          action.receiverId !== config.near.controllerId
        )
          throw new Error("Unexpected wallet transaction destination.");
        if (
          !/^[a-z][a-z0-9_]*$/.test(action.methodName) ||
          !/^[1-9][0-9]*$/.test(action.gas) ||
          BigInt(action.gas) > 300_000_000_000_000n ||
          !/^(0|[1-9][0-9]*)$/.test(action.deposit) ||
          BigInt(action.deposit) >= 1n << 128n ||
          !action.args ||
          typeof action.args !== "object" ||
          Array.isArray(action.args)
        )
          throw new Error("Invalid NEAR wallet action.");
        JSON.stringify(action.args);
      }
      const wallet = await (await nearConnector(config)).wallet();
      const accounts = await wallet.getAccounts({ network: "testnet" });
      if (accounts[0]?.accountId !== expectedAccount)
        throw new Error(`Connect ${expectedAccount} before signing.`);
      const hashes: string[] = [];
      for (const action of actions) {
        const earlier = hashes.length;
        try {
          const result = await wallet.signAndSendTransaction({
            network: "testnet",
            signerId: expectedAccount,
            receiverId: action.receiverId,
            actions: [
              {
                type: "FunctionCall",
                params: {
                  methodName: action.methodName,
                  args: action.args,
                  gas: action.gas,
                  deposit: action.deposit,
                },
              },
            ],
          });
          const hash =
            result.transaction?.hash ?? result.transaction_outcome?.id;
          if (hash) hashes.push(hash);
          const failed = (status: unknown) =>
            !!status && typeof status === "object" && "Failure" in status;
          if (
            failed(result.status) ||
            result.receipts_outcome.some(
              (receipt: { outcome: { status: unknown } }) =>
                failed(receipt.outcome.status),
            )
          )
            throw new ActionFailure(
              `NEAR execution failed.${earlier ? " Earlier transactions were confirmed; reconcile their effects." : " Review the wallet receipt."} Known hashes: ${hashes.join(", ")}.`,
              earlier ? "partial" : "failed",
              "confirmation",
              [...hashes],
            );
          if (
            !result.status ||
            typeof result.status !== "object" ||
            !("SuccessValue" in result.status)
          )
            throw new ActionFailure(
              `Outcome uncertain. NEAR final execution is not confirmed. Known hashes: ${hashes.join(", ")}. Reconcile before resubmitting.`,
              "unknown",
              "confirmation",
              [...hashes],
            );
        } catch (error) {
          throw submissionFailure(error, hashes);
        }
      }
    },
    async fundEvm(config: Config, vault: Address, shortfallWei: bigint) {
      if (config.mode !== "public")
        throw new Error("Use the local actor in local mode.");
      const provider = injected();
      const wallet = createWalletClient({
        chain: sepolia,
        transport: custom(provider),
      });
      if ((await wallet.getChainId()) !== sepolia.id)
        throw new Error("Switch the Ethereum wallet to Sepolia.");
      const [account] = await wallet.getAddresses();
      if (!account) throw new Error("Connect your Ethereum wallet first.");
      if (
        typeof shortfallWei !== "bigint" ||
        shortfallWei <= 0n ||
        shortfallWei > 120_000_000_000_000_000n
      )
        throw new Error("No valid collateral shortfall to fund.");
      const hashes: string[] = [];
      try {
        const hash = await wallet.sendTransaction({
          account,
          to: vault,
          value: shortfallWei,
          data: "0x",
        });
        hashes.push(hash);
        const client = createPublicClient({
          chain: sepolia,
          transport: config.ethereum.rpcUrl
            ? http(config.ethereum.rpcUrl)
            : custom(provider),
        });
        let replacementReason: string | undefined;
        const receipt = await client.waitForTransactionReceipt({
          hash,
          confirmations: 1,
          timeout: 120000,
          onReplaced(replacement) {
            replacementReason = replacement.reason;
            hashes.push(replacement.transactionReceipt.transactionHash);
          },
        });
        const includedHash = receipt.transactionHash;
        if (!hashes.includes(includedHash)) hashes.push(includedHash);
        if (receipt.status !== "success")
          throw new ActionFailure(
            `Ethereum funding reverted: ${includedHash}`,
            "failed",
            "confirmation",
            [...hashes],
          );
        if (replacementReason === "cancelled")
          throw new ActionFailure(
            `Ethereum funding cancelled: ${includedHash}. The vault was not funded.`,
            "cancelled",
            "confirmation",
            [...hashes],
          );
        const included = await client.getTransaction({ hash: includedHash });
        if (
          included.hash !== includedHash ||
          included.chainId !== sepolia.id ||
          included.from.toLowerCase() !== account.toLowerCase() ||
          included.to?.toLowerCase() !== vault.toLowerCase() ||
          included.value !== shortfallWei ||
          included.input !== "0x" ||
          included.blockHash !== receipt.blockHash ||
          receipt.from.toLowerCase() !== account.toLowerCase() ||
          receipt.to?.toLowerCase() !== vault.toLowerCase()
        )
          throw new ActionFailure(
            `Included transaction does not match the intended vault funding: ${includedHash}. Funding was not confirmed.`,
            "failed",
            "confirmation",
            [...hashes],
          );
        return includedHash;
      } catch (error) {
        const failure = submissionFailure(error, hashes);
        if (failure.uncertainMutation && hashes.length)
          throw new ActionFailure(failure.message, "unknown", "confirmation", [
            ...hashes,
          ]);
        throw failure;
      }
    },
  };
}

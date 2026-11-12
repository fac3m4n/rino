import { useEffect, useRef, useState } from "react";
import type { NearConnector } from "@hot-labs/near-connect";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseEther,
  type Address,
  type EIP1193Provider,
} from "viem";
import { sepolia } from "viem/chains";
import type { Config, WalletAction } from "@proofcredit/coordinator/api";

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
      const wallet = await (await nearConnector(config)).wallet();
      const accounts = await wallet.getAccounts({ network: "testnet" });
      if (accounts[0]?.accountId !== expectedAccount)
        throw new Error(`Connect ${expectedAccount} before signing.`);
      for (const action of actions) {
        if (action.receiverId !== config.near.controllerId)
          throw new Error("Unexpected wallet transaction destination.");
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
        if (typeof result.status === "object" && "Failure" in result.status)
          throw new Error(
            "The NEAR transaction failed. Review the wallet receipt.",
          );
        if (
          result.receipts_outcome.some(
            (receipt: { outcome: { status: unknown } }) =>
              typeof receipt.outcome.status === "object" &&
              receipt.outcome.status !== null &&
              "Failure" in receipt.outcome.status,
          )
        )
          throw new Error(
            "A NEAR execution receipt failed. Refresh chain state before retrying.",
          );
      }
    },
    async fundEvm(config: Config, vault: Address) {
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
      const hash = await wallet.sendTransaction({
        account,
        to: vault,
        value: parseEther("0.12"),
      });
      const client = createPublicClient({
        chain: sepolia,
        transport: config.ethereum.rpcUrl
          ? http(config.ethereum.rpcUrl)
          : custom(provider),
      });
      const receipt = await client.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: 120000,
      });
      if (receipt.status !== "success")
        throw new Error(`Ethereum funding reverted: ${hash}`);
      return hash;
    },
  };
}

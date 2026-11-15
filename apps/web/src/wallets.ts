import { useEffect, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
} from "viem";
import { sepolia } from "viem/chains";
import type { Config, WalletAction } from "@rino/coordinator/api";
import { ActionFailure, submissionFailure, userRejected } from "./outcomes";

import { WalletSession, type Injected } from "./wallet-session";
import { loadNearWalletOptions } from "./wallet-selector";

export type WalletProgress = (event: {
  step: number;
  event: "submission-started" | "hash";
  hash?: string;
}) => Promise<void>;

async function acknowledgeStart(
  progress: WalletProgress | undefined,
  step: number,
  hashes: string[],
) {
  try {
    await progress?.({ step, event: "submission-started" });
  } catch (error) {
    throw new ActionFailure(
      "Wallet submission was not started because its progress acknowledgement was unavailable.",
      hashes.length ? "partial" : "failed",
      "before-submission",
      [...hashes],
      submissionFailure(error, []).diagnostic,
    );
  }
}
async function acknowledgeHash(
  progress: WalletProgress | undefined,
  step: number,
  hash: string,
  hashes: string[],
) {
  try {
    await progress?.({ step, event: "hash", hash });
  } catch (error) {
    throw new ActionFailure(
      "Outcome uncertain. A transaction hash was received but its progress acknowledgement was unavailable. Reconcile before resubmitting.",
      "unknown",
      "confirmation",
      [...hashes],
      submissionFailure(error, []).diagnostic,
    );
  }
}

async function acknowledgeErrorHints(
  failure: ActionFailure,
  chain: "near" | "ethereum",
  step: number,
  emitted: Set<string>,
  progress?: WalletProgress,
) {
  for (const hash of failure.knownHashes) {
    if (
      emitted.has(hash) ||
      (hash.startsWith("0x") ? "ethereum" : "near") !== chain
    )
      continue;
    emitted.add(hash);
    try {
      await acknowledgeHash(progress, step, hash, failure.knownHashes);
    } catch {
      throw new ActionFailure(
        "Outcome uncertain. A wallet error supplied a transaction hash whose progress acknowledgement was unavailable. Reconcile before resubmitting.",
        "unknown",
        "confirmation",
        [...failure.knownHashes],
        failure.diagnostic,
      );
    }
  }
}

function injected(): Injected {
  const provider = (window as unknown as { ethereum?: Injected }).ethereum;
  if (!provider)
    throw new Error("Install an Ethereum wallet to connect to Sepolia.");
  return provider;
}
export function useWallets(config?: Config) {
  const [state, setState] = useState<{
    nearAccount: string;
    evmAccount?: Address;
    evmChainId?: number;
  }>({ nearAccount: "" });
  const sessionRef = useRef<WalletSession | null>(null);
  if (!sessionRef.current)
    sessionRef.current = new WalletSession(async (config) => {
      const { NearConnector } = await import("@hot-labs/near-connect");
      return new NearConnector({
        network: "testnet",
        autoConnect: false,
        providers: { testnet: [config.near.rpcUrl] },
        features: { testnet: true, signAndSendTransaction: true },
      });
    });
  const session = sessionRef.current;
  useEffect(
    () => session.start(config, setState),
    [session, config?.mode, config?.near.networkId, config?.near.rpcUrl],
  );
  const { nearAccount, evmAccount, evmChainId } = state;
  const nearConnector = (config: Config) => session.getConnector(config);
  return {
    nearAccount,
    evmAccount,
    evmChainId,
    async nearWalletOptions(config: Config) {
      return loadNearWalletOptions(await session.getConnector(config));
    },
    async connectNear(config: Config, walletId?: string) {
      // The connector emits the validated signIn accounts before resolving.
      await session.connectNear(config, walletId);
    },
    async disconnectNear() {
      await session.disconnectNear();
    },
    disconnectEvm() {
      session.disconnectEvm();
    },
    async connectEvm() {
      const client = createWalletClient({
        chain: sepolia,
        transport: custom(injected()),
      });
      await session.connectEvm(
        () => client.requestAddresses(),
        () => client.getChainId(),
      );
    },
    async switchEvm() {
      const revision = session.invalidateEvm();
      await createWalletClient({ transport: custom(injected()) }).switchChain({
        id: sepolia.id,
      });
      session.setEvm(revision, evmAccount, sepolia.id);
    },
    async sendNear(
      config: Config,
      actions: WalletAction[],
      expectedAccount: string,
      progress?: WalletProgress,
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
      const accountIds = (list: { accountId: string }[]) =>
        list.map(({ accountId }) => accountId).join(", ") || "none";
      if (!accounts.some(({ accountId }) => accountId === expectedAccount))
        throw new ActionFailure(
          `Connect ${expectedAccount} on NEAR testnet before signing. Wallet accounts: ${accountIds(accounts)}. Disconnect NEAR, then reconnect with the expected account.`,
          "failed",
          "before-submission",
        );
      const meteor = wallet.manifest.id === "meteor-wallet";
      if (meteor) {
        // Meteor lists imported accounts, but signs with the account cached by signIn.
        // Confirm that selection once for this batch without requesting a function-call key.
        let selected;
        try {
          selected = await wallet.signIn({ network: "testnet" });
        } catch (error) {
          const rejected = userRejected(error);
          throw new ActionFailure(
            `Meteor account confirmation ${rejected ? "rejected" : "failed"}. No financial transaction was submitted. Select ${expectedAccount} on NEAR testnet and try again.`,
            rejected ? "rejected" : "failed",
            "before-submission",
            [],
            submissionFailure(error, []).diagnostic,
          );
        }
        session.selectNear(wallet.manifest.id, selected);
        if (selected.length !== 1 || selected[0].accountId !== expectedAccount)
          throw new ActionFailure(
            `Meteor selected accounts: ${accountIds(selected)}. Select ${expectedAccount} on NEAR testnet before signing. Disconnect NEAR, then reconnect with the expected account. No financial transaction was submitted.`,
            "failed",
            "before-submission",
          );
      }
      const hashes: string[] = [];
      for (const [step, action] of actions.entries()) {
        const earlier = hashes.length;
        const emitted = new Set<string>();
        await acknowledgeStart(progress, step, hashes);
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
          if (hash) {
            hashes.push(hash);
            emitted.add(hash);
            await acknowledgeHash(progress, step, hash, hashes);
          }
          if (meteor && result.transaction?.signer_id !== expectedAccount)
            throw new ActionFailure(
              `Outcome uncertain. Meteor returned transaction signer ${result.transaction?.signer_id || "none"}; expected ${expectedAccount}. Known hashes: ${hashes.join(", ")}. Reconcile chain state and receipts before resubmitting.`,
              "unknown",
              "confirmation",
              [...hashes],
            );
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
          const failure = submissionFailure(error, hashes);
          // Earlier batch hashes were already attributed to their own steps.
          for (const hash of hashes) emitted.add(hash);
          await acknowledgeErrorHints(failure, "near", step, emitted, progress);
          throw failure;
        }
      }
    },
    async fundEvm(
      config: Config,
      vault: Address,
      shortfallWei: bigint,
      progress?: WalletProgress,
      expectedFrom?: Address,
    ) {
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
      if (expectedFrom && account.toLowerCase() !== expectedFrom.toLowerCase())
        throw new ActionFailure(
          "The connected Ethereum account changed after funding preparation. Prepare a new funding intent for the selected account.",
          "failed",
          "before-submission",
        );
      if (
        typeof shortfallWei !== "bigint" ||
        shortfallWei <= 0n ||
        shortfallWei > 120_000_000_000_000_000n
      )
        throw new Error("No valid collateral shortfall to fund.");
      const hashes: string[] = [];
      const emitted = new Set<string>();
      await acknowledgeStart(progress, 0, hashes);
      try {
        const hash = await wallet.sendTransaction({
          account,
          to: vault,
          value: shortfallWei,
          data: "0x",
        });
        hashes.push(hash);
        emitted.add(hash);
        await acknowledgeHash(progress, 0, hash, hashes);
        const client = createPublicClient({
          chain: sepolia,
          transport: config.ethereum.rpcUrl
            ? http(config.ethereum.rpcUrl)
            : custom(provider),
        });
        let replacementReason: string | undefined;
        const acknowledgements: Promise<void>[] = [];
        const receipt = await client.waitForTransactionReceipt({
          hash,
          confirmations: 1,
          timeout: 120000,
          onReplaced(replacement) {
            replacementReason = replacement.reason;
            const replacementHash =
              replacement.transactionReceipt.transactionHash;
            if (!hashes.includes(replacementHash)) {
              hashes.push(replacementHash);
              emitted.add(replacementHash);
              const acknowledgement = acknowledgeHash(
                progress,
                0,
                replacementHash,
                hashes,
              );
              // viem's onReplaced hook is synchronous; observe rejection now and
              // await its acknowledgement before treating confirmation as done.
              void acknowledgement.catch(() => {});
              acknowledgements.push(acknowledgement);
            }
          },
        });
        await Promise.all(acknowledgements);
        const includedHash = receipt.transactionHash;
        if (!hashes.includes(includedHash)) {
          hashes.push(includedHash);
          emitted.add(includedHash);
          await acknowledgeHash(progress, 0, includedHash, hashes);
        }
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
        await acknowledgeErrorHints(failure, "ethereum", 0, emitted, progress);
        if (failure.uncertainMutation && failure.knownHashes.length)
          throw new ActionFailure(
            failure.message,
            "unknown",
            "confirmation",
            [...failure.knownHashes],
            failure.diagnostic,
          );
        throw failure;
      }
    },
  };
}

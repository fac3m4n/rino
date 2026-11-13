import type { Config, Receipt } from "@rino/coordinator/api";
import { validHash } from "./operation-client";

export function explorerUrl(
  config: Config | undefined,
  chain: Receipt["chain"],
  hash: string | null | undefined,
): string | null {
  if (
    config?.mode !== "public" ||
    !hash ||
    chain === "worker" ||
    !validHash(hash, chain)
  )
    return null;
  if (chain === "near" && config.near.networkId === "testnet")
    return `https://testnet.nearblocks.io/txns/${hash}`;
  if (chain === "ethereum" && config.ethereum.chainId === "11155111")
    return `https://sepolia.etherscan.io/tx/${hash}`;
  return null;
}

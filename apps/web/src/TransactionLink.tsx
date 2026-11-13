import type { Config, Receipt } from "@proofcredit/coordinator/api";
import { explorerUrl } from "./explorer";

export function TransactionLink({
  config,
  chain,
  hash,
  label,
}: {
  config: Config | undefined;
  chain: Receipt["chain"];
  hash: string | null | undefined;
  label?: string;
}) {
  const url = explorerUrl(config, chain, hash);
  if (!hash)
    return <span className="transaction-missing">No transaction hash</span>;
  if (!url) return <code className="transaction-hash">{hash}</code>;
  return (
    <a
      className="transaction-link"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${label ?? "View transaction"}: ${hash} (opens in a new tab)`}
    >
      {label && <span>{label} </span>}
      <code className="transaction-hash">{hash}</code>
    </a>
  );
}

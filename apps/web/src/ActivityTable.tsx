import type { Config, Receipt } from "@rino/coordinator/api";
import { TransactionLink } from "./TransactionLink";

const source: Record<Receipt["chain"], string> = {
  near: "NEAR",
  ethereum: "Ethereum",
  worker: "Worker",
};
const outcome: Record<Receipt["status"], string> = {
  pending: "Pending",
  success: "Verified step",
  rejected: "Failed",
  uncertain: "Needs checking",
};

export function ActivityTable({
  config,
  receipts,
  onOpenEvidence,
}: {
  config: Config | undefined;
  receipts: Receipt[];
  onOpenEvidence: () => void;
}) {
  return (
    <section
      className="activity-panel"
      aria-labelledby="activity-heading"
      id="activity"
    >
      <div className="activity-heading">
        <h2 id="activity-heading">Activity</h2>
        <button
          className="button secondary"
          type="button"
          onClick={onOpenEvidence}
        >
          View all evidence
        </button>
      </div>
      {receipts.length === 0 ? (
        <p className="activity-empty">No recorded activity yet.</p>
      ) : (
        <>
          <div className="activity-scroll">
            <table className="activity-table" aria-label="Transaction activity">
              <thead>
                <tr>
                  <th scope="col">Action</th>
                  <th scope="col">Source</th>
                  <th scope="col">Status</th>
                  <th scope="col">Transaction</th>
                </tr>
              </thead>
              <tbody>
                {[...receipts].reverse().map((receipt) => (
                  <tr key={receipt.id}>
                    <td>
                      <b>{receipt.action}</b>
                      <p className="activity-detail">{receipt.detail}</p>
                    </td>
                    <td>{source[receipt.chain]}</td>
                    <td>
                      <span
                        className={`activity-status status-${receipt.status}`}
                        data-status={receipt.status}
                      >
                        {receipt.chain === "worker" &&
                        receipt.status === "success"
                          ? "Worker result"
                          : outcome[receipt.status]}
                      </span>
                    </td>
                    <td>
                      <TransactionLink
                        config={config}
                        chain={receipt.chain}
                        hash={receipt.hash}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="activity-note">
            A verified step does not establish loan closure. Worker results are
            not chain confirmations.
          </p>
        </>
      )}
    </section>
  );
}

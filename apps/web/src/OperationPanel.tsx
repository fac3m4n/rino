import { useState } from "react";
import type {
  ActionName,
  OperationView,
  Role,
} from "@proofcredit/coordinator/api";
import { validHash } from "./operation-client";

export function OperationPanel({
  operations,
  disabled,
  onCheck,
  onHash,
  onContinue,
  onImport,
  onError,
}: {
  operations: OperationView[];
  disabled: boolean;
  onCheck: (operation: OperationView) => Promise<void>;
  onHash: (
    operation: OperationView,
    step: number,
    hash: string,
  ) => Promise<void>;
  onContinue: (operation: OperationView) => Promise<void>;
  onImport: (action: ActionName, role: Role, hash: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [working, setWorking] = useState(false);
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const [historicalHash, setHistoricalHash] = useState("");
  const [action, setAction] = useState<ActionName>("prove");
  const [role, setRole] = useState<Role>("borrower");
  const run = async (task: () => Promise<void>) => {
    if (working || disabled) return;
    setWorking(true);
    try {
      await task();
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : "Operation evidence could not be checked. The request remains recorded.",
      );
    } finally {
      setWorking(false);
    }
  };
  return (
    <section
      className="trust-panel"
      role="region"
      aria-label="Operation recovery"
    >
      <h2>Operation recovery</h2>
      <p>
        Wallet observations need checking against the exact transaction. A
        successful step does not mean collateral is authenticated or the loan is
        closed. Checking never opens a wallet.
      </p>
      {operations.length === 0 && <p>No recorded operations.</p>}
      {[...operations].reverse().map((op) => (
        <article className="receipt" key={op.id}>
          <div className="receipt-title">
            <b>
              {op.action} · {op.role}
            </b>
            <em>{op.stage}</em>
            {op.historical && <span>Historical receipt</span>}
          </div>
          <p>{op.detail}</p>
          <code>{op.id}</code>
          {op.unresolved && (
            <p>
              Submission needs checking. Missing evidence does not mean no
              transaction was submitted.
            </p>
          )}
          {op.continued && (
            <p>
              The client pause was deliberately released. This original
              operation remains recorded and may complete later.
            </p>
          )}
          {op.steps.map((step) => {
            const key = `${op.id}:${step.index}`;
            return (
              <div className="receipt-facts" key={step.index}>
                <b>
                  Step {step.index + 1}: {step.method} · {step.status}
                </b>
                {step.diagnostic && (
                  <span>
                    Wallet observation: {step.diagnostic.category}
                    {step.diagnostic.name ? ` · ${step.diagnostic.name}` : ""}
                    {step.diagnostic.code ? ` · ${step.diagnostic.code}` : ""}
                  </span>
                )}
                {step.hashes.map((hash) => (
                  <div key={hash.hash}>
                    <code>{hash.hash}</code>
                    <p>
                      {hash.status === "failed"
                        ? "Verified failure: "
                        : hash.status === "succeeded"
                          ? "Verified step success: "
                          : "Unverified transaction hint: "}
                      {hash.detail}
                    </p>
                  </div>
                ))}
                {op.unresolved &&
                  !["succeeded", "failed"].includes(step.status) && (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        void run(() =>
                          onHash(op, step.index, hashes[key] ?? ""),
                        );
                      }}
                    >
                      <label>
                        Transaction hash for step {step.index + 1}
                        <input
                          aria-label={`Transaction hash ${op.id} step ${step.index + 1}`}
                          maxLength={66}
                          value={hashes[key] ?? ""}
                          onChange={(event) =>
                            setHashes({
                              ...hashes,
                              [key]: event.target.value.trim(),
                            })
                          }
                        />
                      </label>
                      <button
                        className="button secondary"
                        disabled={
                          disabled ||
                          working ||
                          !validHash(hashes[key] ?? "", step.chain)
                        }
                      >
                        Attach hash and check
                      </button>
                    </form>
                  )}
              </div>
            );
          })}
          <div className="secondary-actions">
            <button
              className="button secondary"
              disabled={disabled || working}
              onClick={() => void run(() => onCheck(op))}
            >
              Check operation
            </button>
            {!op.historical &&
              !op.continued &&
              (op.unresolved ||
                ["preparing", "awaiting-wallet"].includes(op.stage)) && (
                <button
                  className="button secondary"
                  disabled={disabled || working}
                  onClick={() => void run(() => onContinue(op))}
                >
                  Continue after fresh check
                </button>
              )}
          </div>
        </article>
      ))}
      <details>
        <summary>Import a historical NEAR receipt</summary>
        <p>
          Import creates a separate historical record and cannot clear another
          operation’s pause.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => onImport(action, role, historicalHash));
          }}
        >
          <label>
            Historical action
            <select
              value={action}
              onChange={(event) => setAction(event.target.value as ActionName)}
            >
              {[
                "initialize",
                "fund",
                "prove",
                "borrow",
                "repay",
                "default",
                "cancel",
                "settle",
                "claim",
                "recover",
              ].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Historical role
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              <option>borrower</option>
              <option>lender</option>
            </select>
          </label>
          <label>
            Historical NEAR transaction hash
            <input
              aria-label="Historical NEAR transaction hash"
              maxLength={44}
              value={historicalHash}
              onChange={(event) => setHistoricalHash(event.target.value.trim())}
            />
          </label>
          <button
            className="button secondary"
            disabled={disabled || working || !validHash(historicalHash, "near")}
          >
            Import historical receipt
          </button>
        </form>
      </details>
    </section>
  );
}

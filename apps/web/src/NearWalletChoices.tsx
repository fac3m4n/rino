import { useEffect, useRef, useState } from "react";
import type { NearWalletOption } from "./wallet-selector";

type ChoiceState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; options: NearWalletOption[] };

export function NearWalletChoices({
  load,
  onChoose,
}: {
  load: () => Promise<NearWalletOption[]>;
  onChoose: (id: string) => void;
}) {
  const latestLoad = useRef(load);
  latestLoad.current = load;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ChoiceState>({ status: "loading" });
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    const timer = setTimeout(() => {
      if (!active) return;
      active = false;
      setState({
        status: "error",
        message: "Wallet list timed out. Try again.",
      });
    }, 5000);
    void Promise.resolve()
      .then(() => latestLoad.current())
      .then(
        (options) => {
          if (active) {
            clearTimeout(timer);
            setState({ status: "ready", options });
          }
        },
        (error: unknown) => {
          if (active) {
            clearTimeout(timer);
            setState({
              status: "error",
              message:
                error instanceof Error
                  ? error.message
                  : "Wallet list is unavailable.",
            });
          }
        },
      );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [attempt]);
  return (
    <section aria-label="Available NEAR wallets">
      <h3>Choose a wallet</h3>
      {state.status === "loading" ? (
        <p className="inline-status" role="status">
          Loading wallets…
        </p>
      ) : state.status === "error" ? (
        <p className="warning-box" role="alert">
          {state.message}
        </p>
      ) : state.options.length === 0 ? (
        <p className="inline-status" role="status">
          No compatible wallets are available.
        </p>
      ) : (
        <div className="sheet-actions">
          {state.options.map((option) => (
            <button
              key={option.id}
              className="button secondary"
              onClick={() => onChoose(option.id)}
            >
              {option.name}
            </button>
          ))}
        </div>
      )}
      {(state.status === "error" ||
        (state.status === "ready" && state.options.length === 0)) && (
        <button
          className="button secondary"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Try again
        </button>
      )}
    </section>
  );
}

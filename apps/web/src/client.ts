import type {
  ActionName,
  ActionResult,
  Config,
  Receipt,
  Role,
  State,
} from "@proofcredit/coordinator/api";
export const GET_TIMEOUT_MS = 15000;
export const ACTION_TIMEOUT_MS = 180000;
export interface RequestOptions {
  timeoutMs?: number;
  fresh?: boolean;
  signal?: AbortSignal;
}
import { ActionFailure } from "./outcomes";
export class RequestFailure extends ActionFailure {
  constructor(message: string, uncertainMutation = false) {
    super(
      message,
      uncertainMutation ? "unknown" : "failed",
      uncertainMutation ? "submission" : "before-submission",
    );
  }
}
async function requestJson<T>(
  path: string,
  init: RequestInit,
  options: RequestOptions,
): Promise<T> {
  const mutation = init.method === "POST";
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onCancel: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    const stop = (reason: string) => {
      reject(
        new RequestFailure(
          mutation
            ? `Outcome uncertain. ${reason} Do not resubmit; reconcile chain state and receipts.`
            : reason,
          mutation,
        ),
      );
      controller.abort();
    };
    onCancel = () => stop("Coordinator request cancelled.");
    options.signal?.addEventListener("abort", onCancel, { once: true });
    if (options.signal?.aborted) onCancel();
    timer = setTimeout(
      () => stop("Coordinator request deadline exceeded."),
      options.timeoutMs ?? (mutation ? ACTION_TIMEOUT_MS : GET_TIMEOUT_MS),
    );
  });
  const delivery = (async () => {
    const response = await fetch(`/api/${path}`, {
      ...init,
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok)
      throw new RequestFailure(
        data.message ?? "The coordinator rejected this request.",
      );
    return data as T;
  })();
  try {
    return await Promise.race([delivery, stopped]);
  } catch (error) {
    if (error instanceof RequestFailure) throw error;
    throw new RequestFailure(
      mutation
        ? "Outcome uncertain. The action response was not received. Do not resubmit; reconcile chain state and receipts."
        : "Unable to receive coordinator state. Financial actions remain paused until a fresh snapshot is available.",
      mutation,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCancel);
    controller.abort();
  }
}
export function readApi<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  return requestJson<T>(
    options.fresh && ["config", "state"].includes(path)
      ? `${path}?fresh=1`
      : path,
    { headers: { Accept: "application/json" }, cache: "no-store" },
    options,
  );
}
export function submitAction(
  config: Config,
  action: ActionName,
  role: Role,
  options: RequestOptions = {},
): Promise<ActionResult> {
  return requestJson<ActionResult>(
    "actions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ProofCredit-CSRF": config.csrfToken,
      },
      body: JSON.stringify({ action, role }),
    },
    options,
  );
}
export interface Snapshot {
  config: Config;
  state: State;
  receipts: Receipt[];
}
export async function snapshot(
  options: RequestOptions = {},
): Promise<Snapshot> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    const requestOptions = { ...options, signal: controller.signal };
    const [config, state, receipts] = await Promise.all([
      readApi<Config>("config", requestOptions),
      readApi<State>("state", requestOptions),
      readApi<Receipt[]>("receipts", requestOptions),
    ]);
    return { config, state, receipts };
  } finally {
    controller.abort();
    options.signal?.removeEventListener("abort", cancel);
  }
}

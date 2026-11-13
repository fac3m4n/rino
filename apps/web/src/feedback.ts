/** Display phases only. Never use these to authorize, retry or reconcile work. */
export type UiPhase = "checking-state" | "preparing" | "wallet" | "reconciling";
export interface FeedbackNotice {
  id: string;
  kind: "info" | "pending" | "success" | "error" | "uncertain";
  title: string;
  detail?: string;
}
export const phaseTitle: Record<UiPhase, string> = {
  "checking-state": "Checking fresh state",
  preparing: "Preparing request",
  wallet: "Waiting for wallet approval or evidence",
  reconciling: "Refreshing results",
};

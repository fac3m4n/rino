import type { ActionName, Role, State, WalletAction } from "./api.ts";
export interface OperationRequest {
  id: string;
  action: ActionName;
  role: Role;
  evmSender?: string;
}
export interface OperationDiagnostic {
  category: "wallet-closed" | "timeout" | "rejected" | "transport" | "unknown";
  name?: string;
  code?: string;
}
export interface OperationObservation {
  step: number;
  event: "submission-started" | "hash" | "wallet-rejected" | "wallet-unknown";
  hash?: string;
  diagnostic?: OperationDiagnostic;
}
export interface OperationHashView {
  hash: string;
  status: "hint" | "pending" | "succeeded" | "failed";
  detail: string;
  blockNumber?: string;
  gasUsed?: string;
  feeWei?: string;
}
export interface OperationStepView {
  index: number;
  chain: "near" | "ethereum";
  method: string;
  signerId: string;
  receiverId: string;
  started: boolean;
  status: "prepared" | "processing" | "needs-check" | "succeeded" | "failed";
  hashes: OperationHashView[];
}
export interface OperationView {
  id: string;
  controllerId: string;
  action: ActionName;
  role: Role;
  historical: boolean;
  createdAt: string;
  updatedAt: string;
  stage:
    | "preparing"
    | "awaiting-wallet"
    | "processing"
    | "needs-check"
    | "succeeded"
    | "failed"
    | "partial";
  unresolved: boolean;
  continued: boolean;
  detail: string;
  steps: OperationStepView[];
}
export interface FundingIntent {
  chainId: "11155111";
  from: string;
  to: string;
  valueWei: string;
  data: "0x";
}
export interface OperationResult {
  operation: OperationView;
  walletActions?: WalletAction[];
  funding?: FundingIntent;
  state?: State;
}

export const DIAGNOSTIC_NAMES = [
  "Error",
  "TimeoutError",
  "AbortError",
  "UserRejectedRequestError",
  "WalletError",
  "TransportError",
  "TransactionExecutionError",
  "UnknownError",
] as const;
export const DIAGNOSTIC_CODES = [
  "4001",
  "4100",
  "4900",
  "4901",
  "ACTION_REJECTED",
  "TIMEOUT",
  "NETWORK_ERROR",
  "UNKNOWN_ERROR",
] as const;

/** Browser-safe API v1. Amounts, times, gas and nonces are decimal strings. */
export const API_VERSION = 1 as const;
export type Role = "borrower" | "lender";
export type ActionName =
  | "initialize"
  | "fund"
  | "prove"
  | "borrow"
  | "repay"
  | "default"
  | "cancel"
  | "settle"
  | "claim"
  | "challenge-forgery"
  | "challenge-duplicate"
  | "advance-maturity"
  | "recover";
export interface ActionRequest {
  action: ActionName;
  role: Role;
}
export interface Terms {
  version: string;
  principal_units: string;
  fee_units: string;
  debt_units: string;
  reference_units_per_eth: string;
  max_ltv_bps: string;
  term_seconds: string;
  fee_cap_wei_per_gas: string;
  gas_limit: string;
  initial_fee_budget_wei: string;
}
export interface Market {
  phase:
    | "Offered"
    | "Active"
    | "Repaid"
    | "DefaultLocked"
    | "CancelLocked"
    | "Closed";
  borrower: string;
  lender: string;
  vault: string | null;
  borrower_recipient: string;
  lender_recipient: string;
  settlement_wasm_url: string;
  settlement_wasm_sha256: string;
  terms: Terms;
  available_liquidity_units: string;
  lender_claim_units: string;
  debt_units: string;
  borrowed_at: string | null;
  maturity: string | null;
  borrower_balance_units: string;
  lender_balance_units: string;
  escrow_balance_units: string;
  proof_timestamp: string | null;
  proof_fresh: boolean;
  pending_reason: string;
}
export interface TransferIntent {
  chain_id: string;
  nonce: string;
  to: string;
  value: string;
  gas_limit: string;
  gas_price: string;
}
export interface SignedTransaction {
  raw: string;
  hash: string;
  signing_digest: string;
  r: string;
  s: string;
  y_parity: string;
}
export interface Pending {
  kind: string;
  request_id: string;
  expires_at: string;
  input_hash: string;
}
export interface Settlement {
  stage:
    | "Idle"
    | "Preparing"
    | "ReadyToSign"
    | "Signing"
    | "Signed"
    | "Confirming"
    | "NeedsTopup"
    | "Complete";
  branch: "repay" | "cancel" | "default" | null;
  expected_nonce: string;
  balance_wei: string;
  accounted_balance_wei: string;
  unallocated_incoming_wei: string;
  remaining_fee_budget_wei: string;
  fees_paid_wei: string;
  lender_cap_wei: string;
  lender_paid_wei: string;
  remaining_lender_cap_wei: string;
  recovered_credit_units: string;
  shortfall_credit_units: string;
  borrower_surplus_wei: string;
  checkpoint_block_number: string | null;
  current_intent: {
    transfer: TransferIntent;
    signing_preimage: string;
    signing_digest: string;
    before_balance_wei: string;
    minimum_block_number: string;
  } | null;
  candidate_count: number;
  last_confirmation: {
    transaction_hash: string;
    nonce: string;
    success: boolean;
    paid_value: string;
    fee: string;
    block_number: string;
  } | null;
  pending: Pending | null;
  pending_reason: string;
  retired: boolean;
}
export interface Config {
  apiVersion: 1;
  mode: "local" | "public";
  ready: boolean;
  readinessErrors: string[];
  csrfToken: string;
  near: {
    networkId: "sandbox" | "testnet";
    rpcUrl: string;
    controllerId: string;
    borrowerId: string;
    lenderId: string;
  };
  ethereum: { chainId: "11155111"; name: string; rpcUrl: string | null };
  authority: string[];
  termSeconds: string;
  artifactHashes: {
    collateral: string;
    settlement: string;
    controller: string;
  };
}
export interface Receipt {
  id: string;
  chain: "near" | "ethereum" | "worker";
  action: string;
  status: "pending" | "success" | "rejected" | "uncertain";
  hash: string | null;
  blockNumber: string | null;
  gasUsed: string | null;
  feeWei: string | null;
  detail: string;
}
export interface State {
  apiVersion: 1;
  ready: boolean;
  market: Market | null;
  settlement: Settlement | null;
  proofStatus: string | null;
  evidence: Record<string, unknown> | null;
  ethereum: {
    vaultBalanceWei: string;
    vaultNonce: string;
    borrowerBalanceWei: string;
    lenderBalanceWei: string;
    finalizedBlock: string;
  } | null;
  totalSupplyUnits: string | null;
  nearTimeSeconds: string | null;
  busy: boolean;
  pendingReason: string;
}
export interface ActionResult {
  ok: boolean;
  message: string;
  state: State;
  receiptIds: string[];
  walletActions?: WalletAction[];
}
export interface WalletAction {
  chain: "near";
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gas: string;
  deposit: string;
}
export interface ApiError {
  error: string;
  message: string;
}

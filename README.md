# Rino / ЯINO

**Borrow on NEAR. Keep your ETH collateral on Ethereum.**

Rino is a cross-chain lending prototype: a borrower deposits native ETH into a Rino-controlled vault on Ethereum and borrows CREDIT on NEAR. NEAR coordinates the loan, verifies collateral evidence and authorizes the permitted collateral settlement through Chain Signatures.

The ETH stays on Ethereum throughout the loan. It moves into Rino's controlled collateral address; existing deposits in other protocols are not automatically eligible collateral.

## Why Rino

Using collateral on one chain to access liquidity on another often requires moving or wrapping the collateral first. Rino demonstrates a different flow: keep native ETH on Ethereum and use a NEAR contract to enforce the borrowing and settlement rules.

The demo makes the entire lifecycle inspectable: collateral evidence, loan accounting, repayment, authorized ETH release and confirmed receipts. It also implements a default branch that caps the lender's payout and accounts for borrower surplus.

## How it works

1. **Fund the offer.** The lender supplies CREDIT liquidity on NEAR.
2. **Deposit collateral.** The borrower sends ETH to the position's derived Ethereum vault.
3. **Verify.** A pinned WASI worker checks Ethereum account-proof evidence for that vault. The NEAR controller accepts results only through its configured authenticated callback path.
4. **Borrow.** Once collateral and liquidity requirements pass, the borrower receives **100 CREDIT** on NEAR.
5. **Repay and release.** The borrower repays **101 CREDIT**, then requests collateral release. Restricted Chain Signatures requests authorize the ETH settlement; receipt and state checks establish completion.

A default after maturity follows the stored settlement policy rather than granting the lender unrestricted control of the vault. Completed vaults retire instead of being reused for another loan.

## Why NEAR is essential

| Component                     | Role in Rino                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NEAR smart contract**       | Stores loan terms, CREDIT balances, debt and lifecycle; checks collateral eligibility and settlement authority.                                                                 |
| **NEAR Chain Signatures**     | Derives the Ethereum collateral address and signs only settlement transactions permitted by the controller.                                                                     |
| **OutLayer workers**          | Run the Rust/WASI collateral-proof and settlement-verification workloads bound to reviewed module hashes.                                                                       |
| **Ethereum**                  | Holds the native ETH collateral and executes the authorized ETH transfers.                                                                                                      |
| **Coordinator and interface** | Prepare evidence, request wallet approvals, relay authorized transactions and reconcile receipts with bounded RPC reads. Public mode holds no participant or vault signing key. |

## What judges can inspect

- Native ETH collateral on Ethereum with CREDIT borrowing and repayment on NEAR.
- Account-proof verification, authenticated callbacks and explicit pending states.
- Repayment release, pre-loan cancellation and capped default with borrower-surplus accounting.
- Rejection of forged/stale evidence, duplicate borrowing and unauthorized settlement requests.
- Wallet-signed actions, transaction-linked activity and recovery for uncertain submission outcomes.
- Local integration tests using real NEAR Sandbox and Anvil receipts, plus production WASI workers.

## Testnet deployment

| Binding               | Network / address                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Controller            | [rino-c-3b5ef6.testnet](https://testnet.nearblocks.io/address/rino-c-3b5ef6.testnet)                                          |
| ETH collateral vault  | [0x6a4375a6fd142f97a0d54a9d60b8def40903cad2](https://sepolia.etherscan.io/address/0x6a4375a6fd142f97a0d54a9d60b8def40903cad2) |
| Controller deployment | [NEAR testnet transaction](https://testnet.nearblocks.io/txns/85DRkMR7NqPB68DQhvDhJ8sDdybNTs4PnbP3RqriAYqC)                   |
| Vault initialization  | [NEAR testnet transaction](https://testnet.nearblocks.io/txns/2fr6QdfhFXqYQaiRUpnqQsef5G6ijxPmjKDEHApgxyUc)                   |

Controller configuration, hosted worker bytes and the independently derived vault address have been verified. The complete fresh public wallet/financial round trip and fresh-job TEE attestation remain unverified. The local walkthrough below is reproducible without public funds or private RPC credentials.

## Run the local demo

Reference environment: **macOS Apple Silicon**, Node **24.19.0**, npm **12.2.2**, Python **3.9+**, Git, curl, Xcode command-line tools and an existing rustup launcher. The setup script installs the pinned Rust/tool dependencies into repository-local paths.

```sh
./tooling/setup-local.sh --download
source tooling/local-env.sh
./tooling/check.sh --unit-build
npm run dev:local
```

For an already populated checkout, use `./tooling/setup-local.sh --cached` instead of `--download`. Open the URL printed by the supervisor. It creates owned NEAR Sandbox/Anvil chains, local mock MPC/executor services and a fresh demonstration market.

Initialize as borrower, switch to lender to fund the offer and collateral, then return to borrower: verify collateral, borrow 100 CREDIT, repay 101 CREDIT and release the ETH. The local actor controls are demonstration tooling; the public flow requires the connected participant's wallet. Stop the supervisor with Ctrl-C.

## Test and build

```sh
source tooling/local-env.sh
npm test
npm run test:web
npm run build

# Native tests, linting, frontend and worker/contract builds
./tooling/check.sh --unit-build

# Also run WASI/TLS, Sandbox/Anvil financial flows,
# artifact reproduction/tamper checks and browser tests
./tooling/check.sh --all
```

## Scope and trust model

This is a **testnet prototype**. CREDIT is a six-decimal demonstration token with no redemption promise. The current offer has a fixed principal, fee and reference valuation; it does not use a live price oracle.

Each controller manages one borrower, one lender, one loan and one derived vault. Supported collateral is native ETH in that controlled vault. Arbitrary external vaults, yield-bearing positions and pooled borrowing power across vaults are outside the implemented collateral model.

Local MPC/executor services are mocks, and the two local RPC routes share one Anvil instance. Public verification trusts the configured RPC, executor and MPC services; provider agreement is not an Ethereum consensus light client. Developer full-access account keys remain trusted. The executor encryption-key HTTPS channel is trusted, and independent fresh-job TEE verification is not claimed. The current 21,000-gas ETH payout policy requires compatible activated recipients. This project has not undergone a professional security audit.

## Stack

Rust · near-sdk · NEAR Chain Signatures · OutLayer · WASI · TypeScript · React · Vite · near-api-js · viem · Vitest · Playwright · NEAR Sandbox · Anvil

## License

[MIT](LICENSE). See the retained [third-party notices](crates/collateral-proof/THIRD_PARTY_NOTICES.md) for attribution and applicable upstream terms.

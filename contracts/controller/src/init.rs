//! Fresh deployment only; no migration or administrative update route.
// near generates an eight-argument Ext builder for the compatible constructor.
#![allow(clippy::too_many_arguments)]
use crate::*;
#[near]
impl Controller {
    /// Immutable deployment policy. Fund the account separately for operational work.
    #[init]
    pub fn new(
        borrower: AccountId,
        executor: AccountId,
        wasm_url: String,
        wasm_sha256: String,
        operation_deposit: U128,
        network: NetworkMode,
        loan_config: Option<LoanConfig>,
    ) -> Self {
        assert!(
            operation_deposit.0 <= MAX_OPERATION_DEPOSIT,
            "operation deposit exceeds cap"
        );
        assert!(
            wasm_sha256.len() == 64
                && wasm_sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid WASM SHA-256"
        );
        executor::validate_url(&wasm_url);
        let mpc = match &network {
            NetworkMode::NearTestnet => {
                assert_eq!(
                    executor.as_str(),
                    "outlayer.testnet",
                    "wrong testnet executor"
                );
                "v1.signer-prod.testnet".parse().expect("fixed account")
            }
            NetworkMode::Sandbox { mpc } => mpc.clone(),
        };
        if let Some(c) = &loan_config {
            assert!(
                c.lender != borrower && borrower != env::current_account_id(),
                "distinct loan participants required"
            );
        }
        let loan = loan_config.map(|c| loan::Loan::new(c, &network));
        Self {
            token: loan.as_ref().map(|l| Self::initial_credit(l, &borrower)),
            loan,
            config: Config {
                borrower,
                executor,
                mpc,
                wasm_url,
                wasm_sha256,
                operation_deposit,
                network,
            },
            status: Status::Uninitialized,
            vault: None,
            generation: 0,
            pending: None,
            evidence: None,
        }
    }
}

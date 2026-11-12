mod settlement;
mod terms;
mod transaction;
pub use settlement::*;
pub use terms::*;
pub use transaction::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Overflow,
    InvalidTerms,
    InsufficientCollateral,
    InvalidFee,
    InvalidAddress,
    InvalidIntent,
    InvalidPaid,
    SignatureTooLarge,
    MalformedSignature,
    InvalidSignature,
    HighS,
    WrongVault,
}

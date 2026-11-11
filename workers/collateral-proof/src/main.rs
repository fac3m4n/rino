use proofcredit_proof_worker::{rpc::WasiTransport, run_entry};
fn main() {
    #[cfg(target_os = "wasi")]
    let now = wasi::clocks::wall_clock::now().seconds;
    #[cfg(not(target_os = "wasi"))]
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_secs())
        .unwrap_or(0);
    if run_entry(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        std::io::stderr().lock(),
        &WasiTransport,
        now,
    )
    .is_err()
    {
        // No remote bodies, request payloads or runtime error strings in diagnostics.
        eprintln!("proof worker output unavailable");
        std::process::exit(1);
    }
}

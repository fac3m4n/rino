//! Own the Sandbox independently of the restartable HTTP coordinator.
use near_api::NearToken;
use near_sandbox::{Sandbox, config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY};
use serde_json::json;
use std::{io::Write, os::unix::fs::OpenOptionsExt, path::PathBuf};
use tokio::io::{AsyncBufReadExt, BufReader};
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("private manifest path required")?,
    );
    // Keep long outage tests within one explicitly local epoch. Time still comes
    // from actual produced headers and is measured by the coordinator.
    let sandbox = Sandbox::start_sandbox_with_config(near_sandbox::SandboxConfig {
        additional_genesis: Some(json!({"epoch_length": 100000})),
        ..Default::default()
    })
    .await?;
    for name in ["borrower", "lender", "controller", "executor", "mpc"] {
        sandbox
            .create_account(name.parse()?)
            .initial_balance(NearToken::from_near(100))
            .send()
            .await?;
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(serde_json::to_string(&json!({"rpcUrl":sandbox.rpc_addr,"signer":DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY,"supervisorPid":std::process::id()}))?.as_bytes())?;
    file.sync_all()?;
    println!("ready");
    // EOF or parent death drops Sandbox, whose child has kill_on_drop.
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        if line == "stop" {
            break;
        }
        if line == "tick" {
            sandbox.fast_forward(100).await?;
            println!("tick");
        }
    }
    drop(sandbox);
    Ok(())
}

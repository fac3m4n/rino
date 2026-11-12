use anyhow::{Context, Result, ensure};
use proofcredit_worker_host::{Adapter, Runner, gateway::Gateway};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
};
#[tokio::main]
async fn main() {
    match run().await {
        Ok(success) => {
            if !success {
                std::process::exit(1)
            }
        }
        Err(e) => {
            eprintln!("worker host: {e:#}");
            std::process::exit(2)
        }
    }
}
async fn run() -> Result<bool> {
    let mut args = BTreeMap::new();
    let mut words = std::env::args().skip(1);
    while let Some(key) = words.next() {
        ensure!(
            [
                "--module",
                "--input",
                "--mode",
                "--rpc-url",
                "--near-time",
                "--report"
            ]
            .contains(&key.as_str()),
            "unknown argument {key}"
        );
        let value = words.next().context("flag value missing")?;
        ensure!(args.insert(key, value).is_none(), "duplicate flag");
    }
    let module = args.get("--module").context("--module required")?;
    let input = args.get("--input").context("--input required")?;
    let mode = args
        .get("--mode")
        .context("--mode production|local-sandbox required")?;
    let mut production_key = None;
    let gateway = match mode.as_str() {
        "production" => {
            ensure!(
                !args.contains_key("--rpc-url") && !args.contains_key("--near-time"),
                "Production forbids local RPC/clock overrides"
            );
            let key = std::env::var("ALCHEMY_API_KEY").map_err(|_| {
                anyhow::anyhow!(proofcredit_worker_host::transport::CREDENTIAL_ERROR)
            })?;
            proofcredit_worker_host::transport::alchemy_path(&key)?;
            production_key = Some(key);
            None
        }
        "local-sandbox" => {
            let now = args
                .get("--near-time")
                .context("owned Sandbox --near-time required")?
                .parse()?;
            Some(
                Gateway::start(
                    args.get("--rpc-url")
                        .context("owned Anvil --rpc-url required")?,
                    now,
                )
                .await?,
            )
        }
        _ => anyhow::bail!("mode must be production or local-sandbox"),
    };
    let mut bytes = Vec::new();
    let reader: Box<dyn Read> = if input == "-" {
        Box::new(std::io::stdin())
    } else {
        Box::new(std::fs::File::open(input)?)
    };
    reader.take(32770).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 32769, "stdin exceeds host bound");
    let runner = Runner::new(module)?;
    let adapter = gateway
        .as_ref()
        .map_or(Adapter::Production, |g| Adapter::LocalSandbox(g.adapter()));
    let out = if let Some(key) = production_key {
        runner.run_production(&bytes, &key).await
    } else {
        runner.run(&bytes, adapter).await
    };
    if let Some(gateway) = gateway {
        gateway.shutdown().await;
    }
    let out = out?;
    if let Some(path) = args.get("--report") {
        let status = serde_json::from_slice::<serde_json::Value>(&out.stdout)
            .ok()
            .and_then(|v| v["status"].as_str().map(str::to_owned));
        std::fs::write(
            path,
            serde_json::to_vec_pretty(
                &serde_json::json!({"mode":out.mode,"guest_exit_success":out.exit_success,"application_status":status,"elapsed_ms":out.elapsed.as_millis(),"resources_before":out.resources_before,"resources_after":out.resources_after,"http_resources_after":out.http_resources_after,"resource_kinds_after":out.resource_kinds_after}),
            )?,
        )?;
    }
    std::io::stdout().write_all(&out.stdout)?;
    std::io::stderr().write_all(&out.stderr)?;
    Ok(out.exit_success)
}

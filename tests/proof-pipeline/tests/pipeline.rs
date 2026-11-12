//! Real local receipts; the two services and Ethereum checkpoint are synthetic.
use base64::{Engine, engine::general_purpose::STANDARD as B64};
use near_api::{Contract, NearGas, NearToken, NetworkConfig, Signer};
use near_sandbox::{Sandbox, config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY};
use proofcredit_proof_worker::{Provider, RpcResponse, RpcTransport, WorkerError, run_entry};
use rlp::RlpStream;
use serde_json::{Value, json};
use std::{io::Cursor, path::PathBuf, sync::Arc, time::Duration};
use tiny_keccak::{Hasher, Keccak};
use tokio::task::JoinHandle;

const VAULT: &str = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const DEPOSIT: &str = "50000000000000000000000";
const HASH: &str = "be818d821f076d5e1dbf3650b03811b7658c85b14fd5c2fa7abce4ac87184c69";
const URL: &str = "https://example.invalid/proof-worker.wasm";
type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn hex(bytes: &[u8]) -> String {
    format!(
        "0x{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}
fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|n| u8::from_str_radix(&s[n..n + 2], 16).unwrap())
        .collect()
}
fn keccak(b: &[u8]) -> [u8; 32] {
    let mut h = Keccak::v256();
    h.update(b);
    let mut out = [0; 32];
    h.finalize(&mut out);
    out
}
fn bundle(now: u64) -> Value {
    let mut account = RlpStream::new_list(4);
    account.append(&0u64);
    account.append(&1_000_000_000_000_000_000u64);
    account.append(&unhex(
        "56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
    ));
    account.append(&unhex(
        "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    ));
    let mut path = vec![0x20];
    path.extend(keccak(&unhex(&VAULT[2..])));
    let mut leaf = RlpStream::new_list(2);
    leaf.append(&path);
    leaf.append(&account.out().to_vec());
    let leaf = leaf.out();
    json!({"block_number":"123","block_hash":hex(&[0x22;32]),"state_root":hex(&keccak(&leaf)),"block_timestamp":(now-1).to_string(),"account_proof":[hex(&leaf)]})
}
struct FixtureRpc(Value);
impl RpcTransport for FixtureRpc {
    fn post(
        &self,
        provider: Provider,
        bytes: &[u8],
    ) -> std::result::Result<RpcResponse, WorkerError> {
        assert!(["publicnode", "alchemy"].contains(&provider.id));
        let q: Value = serde_json::from_slice(bytes).unwrap();
        let b = &self.0;
        let result = match q["method"].as_str().unwrap() {
            "eth_chainId" => json!("0xaa36a7"),
            "eth_getBlockByNumber" => {
                json!({"number":"0x7b","hash":b["block_hash"],"stateRoot":b["state_root"],"timestamp":format!("0x{:x}",b["block_timestamp"].as_str().unwrap().parse::<u64>().unwrap()),"transactions":[]})
            }
            other => panic!("unexpected fixture RPC {other}"),
        };
        Ok(RpcResponse {
            status: 200,
            body: Box::new(Cursor::new(
                serde_json::to_vec(&json!({"jsonrpc":"2.0","id":q["id"],"result":result})).unwrap(),
            )),
        })
    }
}
struct Harness {
    sandbox: Sandbox,
    net: NetworkConfig,
    signer: Arc<Signer>,
    case: &'static str,
    seq: std::sync::atomic::AtomicUsize,
}
impl Harness {
    async fn new(case: &'static str) -> Result<Arc<Self>> {
        let sandbox =
            tokio::time::timeout(Duration::from_secs(40), Sandbox::start_sandbox()).await??;
        let net =
            NetworkConfig::from_rpc_url("proofcredit-local-sandbox", sandbox.rpc_addr.parse()?);
        let signer = Signer::from_secret_key(DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
        let h = Arc::new(Self {
            sandbox,
            net,
            signer,
            case,
            seq: std::sync::atomic::AtomicUsize::new(0),
        });
        for name in ["borrower", "controller", "executor", "mpc"] {
            h.sandbox
                .create_account(name.parse()?)
                .initial_balance(NearToken::from_near(100))
                .send()
                .await?;
        }
        for name in ["executor", "mpc"] {
            h.deploy(name, "proofcredit_pipeline_services.wasm").await?;
        }
        h.deploy("controller", "proofcredit_controller.wasm")
            .await?;
        h.ok("controller","new",json!({"borrower":"borrower","executor":"executor","wasm_url":URL,"wasm_sha256":HASH,"operation_deposit":DEPOSIT,"network":{"Sandbox":{"mpc":"mpc"}}})).await?;
        Ok(h)
    }
    async fn deploy(&self, account: &str, file: &str) -> Result<()> {
        let code = std::fs::read(
            root()
                .join("target/wasm32-unknown-unknown/release")
                .join(file),
        )?;
        Contract::deploy(account.parse()?)
            .use_code(code)
            .without_init_call()
            .with_signer(self.signer.clone())
            .send_to(&self.net)
            .await?
            .assert_success();
        Ok(())
    }
    async fn rpc(&self, method: &str, params: Value) -> Result<Value> {
        let value: Value = reqwest::Client::new()
            .post(&self.sandbox.rpc_addr)
            .timeout(Duration::from_secs(40))
            .json(&json!({"jsonrpc":"2.0","id":"pipeline","method":method,"params":params}))
            .send()
            .await?
            .json()
            .await?;
        if value.get("error").is_some() {
            return Err(format!("local RPC {method}: {}", value["error"]).into());
        }
        Ok(value["result"].clone())
    }
    async fn now(&self) -> Result<u64> {
        Ok(
            self.rpc("block", json!({"finality":"final"})).await?["header"]["timestamp_nanosec"]
                .as_str()
                .unwrap()
                .parse::<u64>()?
                / 1_000_000_000,
        )
    }
    async fn call_as(
        &self,
        caller: &str,
        account: &str,
        method: &str,
        args: Value,
    ) -> Result<Value> {
        let result = tokio::time::timeout(
            Duration::from_secs(70),
            Contract(account.parse()?)
                .call_function(method, args)
                .transaction()
                .gas(NearGas::from_tgas(300))
                .with_signer(caller.parse()?, self.signer.clone())
                .send_to(&self.net),
        )
        .await??;
        let value=self.rpc("tx",json!({"tx_hash":result.into_full().expect("full execution outcome").outcome().transaction_hash.to_string(),"sender_account_id":caller,"wait_until":"FINAL"})).await?;
        let n = self.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = root()
            .join(".cache/proof-pipeline/receipts")
            .join(self.case);
        std::fs::create_dir_all(&dir)?;
        std::fs::write(
            dir.join(format!("{n:03}-{account}-{method}.json")),
            serde_json::to_vec_pretty(&value)?,
        )?;
        Ok(value)
    }
    async fn call(&self, account: &str, method: &str, args: Value) -> Result<Value> {
        self.call_as("borrower", account, method, args).await
    }
    async fn ok(&self, account: &str, method: &str, args: Value) -> Result<Value> {
        let v = self.call(account, method, args).await?;
        assert_success(&v);
        Ok(v)
    }
    async fn view(&self, account: &str, method: &str) -> Result<Value> {
        let value: near_api::types::Data<Value> = Contract(account.parse()?)
            .call_function(method, json!({}))
            .read_only()
            .fetch_from(&self.net)
            .await?;
        Ok(value.data)
    }
    async fn funded(&self) -> Result<()> {
        let result = self.ok("controller", "initialize_vault", json!({})).await?;
        assert_eq!(result_value(&result), json!(true));
        assert_eq!(self.view("controller", "get_vault").await?, VAULT);
        assert_eq!(self.view("controller", "get_status").await?, "Funding");
        Ok(())
    }
    async fn start(self: &Arc<Self>, b: Value) -> Result<(JoinHandle<Result<Value>>, Value)> {
        let old = self.view("executor", "get_count").await?.as_u64().unwrap();
        let h = self.clone();
        let tx = tokio::spawn(async move {
            h.call("controller", "request_proof", json!({"bundle":b}))
                .await
        });
        let record = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let records = self.view("executor", "get_records").await?;
                if let Some(r) = records.as_array().unwrap().get(old as usize) {
                    return Ok::<_, Box<dyn std::error::Error + Send + Sync>>(r.clone());
                }
                if tx.is_finished() {
                    panic!(
                        "request finished before executor recorded input: {:?}",
                        self.view("controller", "get_status").await
                    )
                }
                tokio::time::sleep(Duration::from_millis(100)).await
            }
        })
        .await??;
        Ok((tx, record))
    }
    fn worker_bytes(&self, record: &Value) -> Vec<u8> {
        let input = record["args"]["input_data"].as_str().unwrap();
        let r: Value = serde_json::from_str(input).unwrap();
        let mut output = Vec::new();
        let mut diagnostics = Vec::new();
        run_entry(
            input.as_bytes(),
            &mut output,
            &mut diagnostics,
            &FixtureRpc(r["bundle"].clone()),
            r["requested_at"].as_str().unwrap().parse().unwrap(),
        )
        .unwrap();
        assert!(
            diagnostics.is_empty(),
            "native worker must accept the fixture"
        );
        output
    }
    fn worker(&self, record: &Value) -> String {
        String::from_utf8(self.worker_bytes(record)).unwrap()
    }
    async fn resume(&self, record: &Value, output: String, fail: bool) -> Result<()> {
        let result = self
            .ok(
                "executor",
                "resume",
                json!({"index":record["index"],"output":output,"fail":fail}),
            )
            .await?;
        assert_eq!(
            result_value(&result),
            true,
            "mock yielded receipt must still be live"
        );
        Ok(())
    }
    async fn no_evidence(&self, status: &str) -> Result<()> {
        assert_eq!(self.view("controller", "get_evidence").await?, Value::Null);
        assert_eq!(self.view("controller", "get_status").await?, status);
        Ok(())
    }
}
fn assert_success(result: &Value) {
    assert!(
        result["status"].get("SuccessValue").is_some(),
        "transaction did not finish successfully: {result}"
    )
}
fn result_value(result: &Value) -> Value {
    let bytes = B64
        .decode(result["status"]["SuccessValue"].as_str().unwrap())
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
fn executor_return_bytes(result: &Value) -> Vec<Vec<u8>> {
    result["receipts_outcome"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["outcome"]["executor_id"] == "executor")
        .filter_map(|r| r["outcome"]["status"]["SuccessValue"].as_str())
        .map(|value| B64.decode(value).unwrap())
        .collect()
}
fn assert_proof_gas(result: &Value) {
    let controller: Vec<_> = result["receipts_outcome"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["outcome"]["executor_id"] == "controller")
        .collect();
    assert_eq!(controller.len(), 2, "entry and callback receipts required");
    assert!(controller[0]["outcome"]["gas_burnt"].as_u64().unwrap() < 70_000_000_000_000);
    assert!(controller[1]["outcome"]["gas_burnt"].as_u64().unwrap() < 30_000_000_000_000);
    for receipt in result["receipts_outcome"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["outcome"]["executor_id"] == "executor")
    {
        assert!(receipt["outcome"]["gas_burnt"].as_u64().unwrap() < 200_000_000_000_000);
    }
}
async fn finish(tx: JoinHandle<Result<Value>>, expected: bool) -> Result<Value> {
    let r = tx.await??;
    assert_success(&r);
    assert_eq!(result_value(&r), expected);
    assert_proof_gas(&r);
    Ok(r)
}

#[tokio::test]
async fn valid_pipeline_records_exact_proven_account() -> Result<()> {
    let h = Harness::new("valid").await?;
    h.funded().await?;
    let (tx, r) = h.start(bundle(h.now().await?)).await?;
    let raw_output = h.worker_bytes(&r);
    let output: Value = serde_json::from_slice(&raw_output)?;
    assert_eq!(output["balance_wei"], "1000000000000000000");
    assert_eq!(output["nonce"], "0");
    assert_eq!(output["vault"], VAULT);
    assert_eq!(output["chain_id"], "11155111");
    assert_eq!(
        output["code_hash"],
        "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    );
    h.resume(&r, h.worker(&r), false).await?;
    let receipts = finish(tx, true).await?;
    assert_eq!(
        executor_return_bytes(&receipts),
        vec![raw_output],
        "executor dependency must return the original native worker bytes"
    );
    assert_eq!(h.view("controller", "get_evidence").await?, output);
    assert_eq!(h.view("controller", "get_status").await?, "ProofReady");
    assert!(receipts["receipts_outcome"].as_array().unwrap().len() >= 3);
    let retry = h
        .call(
            "controller",
            "request_proof",
            json!({"bundle":bundle(h.now().await?)}),
        )
        .await?;
    assert!(retry["status"].get("Failure").is_some());
    Ok(())
}
#[tokio::test]
async fn direct_callback_cannot_accept_evidence() -> Result<()> {
    let h = Harness::new("direct").await?;
    h.funded().await?;
    let (tx, r) = h.start(bundle(h.now().await?)).await?;
    for caller in ["borrower", "executor"] {
        for method in ["on_proof_result", "on_vault_derived"] {
            let v = h
                .call_as(caller, "controller", method, json!({"request_id":"2"}))
                .await?;
            assert!(
                v["status"].get("Failure").is_some(),
                "private wrapper admitted external predecessor {caller}"
            );
            assert!(v.to_string().contains("private"));
        }
    }
    h.no_evidence("ProofPending").await?;
    h.resume(&r, h.worker(&r), false).await?;
    finish(tx, true).await?;
    Ok(())
}
#[tokio::test]
async fn successful_null_and_failed_execution_leave_no_evidence() -> Result<()> {
    let h = Harness::new("null-failure").await?;
    h.ok("mpc", "set_mpc_failure", json!({"fail":true})).await?;
    let derivation = h.ok("controller", "initialize_vault", json!({})).await?;
    assert_eq!(result_value(&derivation), false);
    assert!(
        derivation["receipts_outcome"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["outcome"]["executor_id"] == "mpc"
                && r["outcome"]["status"].get("Failure").is_some())
    );
    h.no_evidence("Uninitialized").await?;
    assert!(h.view("controller", "get_vault").await?.is_null());
    h.ok("mpc", "set_mpc_failure", json!({"fail":false}))
        .await?;
    h.funded().await?;
    for fail in [false, true] {
        let (tx, r) = h.start(bundle(h.now().await?)).await?;
        h.resume(&r, "null".into(), fail).await?;
        let result = finish(tx, false).await?;
        if fail {
            assert!(
                result["receipts_outcome"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|r| r["outcome"]["status"].get("Failure").is_some())
            );
        }
        h.no_evidence("Funding").await?;
    }
    Ok(())
}
#[tokio::test]
async fn cancellation_is_terminal_despite_late_valid_result() -> Result<()> {
    let h = Harness::new("cancel").await?;
    h.funded().await?;
    let (tx, r) = h.start(bundle(h.now().await?)).await?;
    let out = h.worker(&r);
    h.ok("controller", "cancel", json!({})).await?;
    assert_eq!(h.view("controller", "get_generation").await?, "3");
    h.resume(&r, out, false).await?;
    finish(tx, false).await?;
    h.no_evidence("Cancelled").await?;
    Ok(())
}
#[tokio::test]
async fn wrong_context_and_oversized_result_reject() -> Result<()> {
    let h = Harness::new("wrong-size").await?;
    h.funded().await?;
    for mode in [
        "request_id",
        "request_hash",
        "controller_id",
        "vault",
        "large",
        "exact",
    ] {
        let (tx, r) = h.start(bundle(h.now().await?)).await?;
        let raw = h.worker(&r);
        let mut output: Value = serde_json::from_str(&raw)?;
        let text = match mode {
            "large" | "exact" => {
                let limit = if mode == "large" { 8193 } else { 8192 };
                let mut s = raw;
                s.push_str(&" ".repeat(limit - s.len()));
                s
            }
            field => {
                output[field] = match field {
                    "request_id" => json!("999"),
                    "request_hash" => json!(hex(&[0x33; 32])),
                    "controller_id" => json!("other-controller"),
                    "vault" => json!(hex(&[0x11; 20])),
                    _ => unreachable!(),
                };
                output.to_string()
            }
        };
        if mode == "large" || mode == "exact" {
            assert_eq!(text.len(), if mode == "large" { 8193 } else { 8192 });
        }
        h.resume(&r, text.clone(), false).await?;
        let receipts = finish(tx, mode == "exact").await?;
        assert_eq!(executor_return_bytes(&receipts), vec![text.into_bytes()]);
        if mode != "exact" {
            h.no_evidence("Funding").await?;
        }
    }
    Ok(())
}
#[tokio::test]
async fn pinned_source_resources_and_budget_match_outbound_receipt() -> Result<()> {
    let h = Harness::new("pinned-budget").await?;
    h.funded().await?;
    let mpc = h.view("mpc", "get_mpc_args").await?;
    assert_eq!(
        mpc,
        json!({"path":"proofcredit:sepolia:v1:0","predecessor":"controller","domain_id":0})
    );
    let (tx, r) = h.start(bundle(h.now().await?)).await?;
    assert_eq!(r["deposit"], DEPOSIT);
    assert_eq!(r["predecessor"], "controller");
    let a = &r["args"];
    assert_eq!(a.as_object().unwrap().len(), 7);
    assert_eq!(
        a["source"],
        json!({"WasmUrl":{"url":URL,"hash":HASH,"build_target":"wasm32-wasip2"}})
    );
    assert_eq!(
        a["resource_limits"],
        json!({"max_instructions":1_000_000_000u64,"max_memory_mb":128,"max_execution_seconds":60})
    );
    assert_eq!(a["response_format"], "Json");
    assert_eq!(a["payer_account_id"], "controller");
    assert!(a["secrets_ref"].is_null() && a["params"].is_null());
    assert_eq!(r["prepaid_gas"], "200000000000000");
    h.resume(&r, h.worker(&r), false).await?;
    let result = finish(tx, true).await?;
    let outcomes = result["receipts_outcome"].as_array().unwrap();
    assert!(
        outcomes
            .iter()
            .all(|o| o["outcome"]["gas_burnt"].as_u64().unwrap() < 200_000_000_000_000)
    );
    Ok(())
}

// The production 600s TTL exceeds runtime yield lifetime. This is an explicitly
// prepared expired state, constructed with the public native API, not private layout.
fn expired_state(now: u64) -> Vec<u8> {
    use near_sdk::{
        Gas, NearToken, PromiseResult,
        json_types::{U64, U128},
        test_utils::VMContextBuilder,
        testing_env,
    };
    use proofcredit_controller::{Controller, NetworkMode};
    fn ctx(who: &str, now: u64, results: Vec<PromiseResult>) {
        let context = VMContextBuilder::new()
            .current_account_id("controller".parse().unwrap())
            .predecessor_account_id(who.parse().unwrap())
            .signer_account_id("borrower".parse().unwrap())
            .block_timestamp(now * 1_000_000_000)
            .prepaid_gas(Gas::from_tgas(300))
            .account_balance(NearToken::from_near(100))
            .build();
        testing_env!(
            context,
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            results
        );
    }
    let old = now - 610;
    ctx("borrower", old, vec![]);
    let mut c = Controller::new(
        "borrower".parse().unwrap(),
        "executor".parse().unwrap(),
        URL.into(),
        HASH.into(),
        U128(DEPOSIT.parse().unwrap()),
        NetworkMode::Sandbox {
            mpc: "mpc".parse().unwrap(),
        },
        None,
    );
    drop(c.initialize_vault());
    let xy = unhex(
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8",
    );
    let key = near_sdk::PublicKey::from_parts(near_sdk::CurveType::SECP256K1, xy).unwrap();
    ctx(
        "controller",
        old,
        vec![PromiseResult::Successful(serde_json::to_vec(&key).unwrap())],
    );
    assert!(c.on_vault_derived(U64(1)));
    ctx("borrower", old, vec![]);
    drop(c.request_proof(serde_json::from_value(bundle(old)).unwrap()));
    assert_eq!(c.get_generation().0, 2);
    assert_eq!(c.get_pending().unwrap().expires_at.0, old + 600);
    near_sdk::borsh::to_vec(&c).unwrap()
}
impl Harness {
    async fn patch_state(&self, bytes: &[u8]) -> Result<()> {
        self.sandbox
            .patch_state("controller".parse()?)
            .storage(B64.encode(b"STATE"), B64.encode(bytes))
            .send()
            .await?;
        Ok(())
    }
    async fn state_bytes(&self) -> Result<Vec<u8>> {
        let state=self.rpc("query",json!({"request_type":"view_state","finality":"optimistic","account_id":"controller","prefix_base64":B64.encode(b"STATE")})).await?;
        let entries = state["values"].as_array().unwrap();
        let state = entries
            .iter()
            .find(|e| e["key"] == B64.encode(b"STATE"))
            .unwrap();
        Ok(B64.decode(state["value"].as_str().unwrap())?)
    }
}
#[tokio::test]
async fn timeout_recovers_and_late_old_result_cannot_clobber_new_request() -> Result<()> {
    let h = Harness::new("expiry-prepared").await?;
    h.funded().await?;
    let (old_tx, old_r) = h.start(bundle(h.now().await?)).await?;
    let old_result = h.worker(&old_r);
    let state = expired_state(h.now().await?);
    h.patch_state(&state).await?;
    let before = h.now().await?;
    let pending = h.view("controller", "get_pending").await?;
    assert!(before > pending["expires_at"].as_str().unwrap().parse::<u64>()?);
    h.ok("controller", "expire_pending", json!({})).await?;
    assert_eq!(h.view("controller", "get_generation").await?, "3");
    h.no_evidence("Funding").await?;
    let (new_tx, new_r) = h.start(bundle(h.now().await?)).await?;
    assert_eq!(h.view("controller", "get_generation").await?, "4");
    let pending = h.view("controller", "get_pending").await?;
    h.resume(&old_r, old_result, false).await?;
    finish(old_tx, false).await?;
    h.no_evidence("ProofPending").await?;
    assert_eq!(h.view("controller", "get_pending").await?, pending);
    h.resume(&new_r, h.worker(&new_r), false).await?;
    finish(new_tx, true).await?;
    assert_eq!(h.view("controller", "get_status").await?, "ProofReady");
    Ok(())
}
#[tokio::test]
async fn successful_deposit_failed_callback_recovers_after_real_expiry() -> Result<()> {
    let h = Harness::new("callback-fault-elapsed").await?;
    h.funded().await?;
    let (tx, r) = h.start(bundle(h.now().await?)).await?;
    assert_eq!(r["deposit"], DEPOSIT);
    let pending = h.view("controller", "get_pending").await?;
    let saved = h.state_bytes().await?;
    let saved_controller: proofcredit_controller::Controller = near_sdk::borsh::from_slice(&saved)?;
    assert_eq!(saved_controller.get_pending().unwrap().request_id.0, 2);
    assert!(saved_controller.get_evidence().is_none());
    h.patch_state(b"deliberately-invalid-controller-state")
        .await?;
    h.resume(&r, h.worker(&r), false).await?;
    let failed = tx.await??;
    assert!(failed["status"].get("Failure").is_some());
    assert_proof_gas(&failed);
    let outcomes = failed["receipts_outcome"].as_array().unwrap();
    assert!(
        outcomes
            .iter()
            .filter(|r| r["outcome"]["executor_id"] == "executor")
            .all(|r| r["outcome"]["status"].get("Failure").is_none()),
        "executor deposit and result receipts must succeed"
    );
    assert!(
        failed.to_string().contains("deserialize"),
        "fault was not state deserialization: {failed}"
    );
    // Exact restoration is test setup; expire_pending cannot repair corrupt storage.
    h.patch_state(&saved).await?;
    assert_eq!(h.state_bytes().await?, saved);
    h.no_evidence("ProofPending").await?;
    let early = h.call("controller", "expire_pending", json!({})).await?;
    assert!(early["status"].get("Failure").is_some());
    let before = h.now().await?;
    let mut after = before;
    let expires_at = pending["expires_at"].as_str().unwrap().parse::<u64>()?;
    let mut advances = Vec::new();
    // Fast-forward advances heights; timestamp-per-block varies by runtime epoch.
    // Wait for each actual height and measure time, never infer expiry from count.
    for _ in 0..4 {
        let start = h.rpc("block", json!({"finality":"final"})).await?;
        let target = start["header"]["height"].as_u64().unwrap() + 1000;
        let acknowledgement = h
            .rpc("sandbox_fast_forward", json!({"delta_height":1000}))
            .await?;
        let end = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let block = h.rpc("block", json!({"finality":"final"})).await?;
                if block["header"]["height"].as_u64().unwrap() >= target {
                    return Ok::<_, Box<dyn std::error::Error + Send + Sync>>(block);
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await??;
        after = end["header"]["timestamp_nanosec"]
            .as_str()
            .unwrap()
            .parse::<u64>()?
            / 1_000_000_000;
        advances.push(json!({"requested_blocks":1000,"acknowledgement":acknowledgement,"before_height":start["header"]["height"],"after_height":end["header"]["height"],"before_timestamp_ns":start["header"]["timestamp_nanosec"],"after_timestamp_ns":end["header"]["timestamp_nanosec"]}));
        if after > expires_at && after > before + 600 {
            break;
        }
    }
    assert!(
        after > expires_at && after > before + 600,
        "bounded fast-forward did not cross expiry: {advances:?}"
    );
    h.ok("controller", "expire_pending", json!({})).await?;
    h.no_evidence("Funding").await?;
    assert_eq!(h.view("controller", "get_generation").await?, "3");
    let path = root().join(".cache/proof-pipeline/elapsed-expiry.json");
    std::fs::write(
        path,
        serde_json::to_vec_pretty(
            &json!({"before":before,"after":after,"actual_elapsed_chain_seconds":after-before,"expires_at":pending["expires_at"],"advances":advances,"setup":"corrupt STATE then restore exact saved bytes before elapsed expiry"}),
        )?,
    )?;
    Ok(())
}

#[tokio::test]
async fn maximum_serialized_envelopes_fit_configured_receipt_gas() -> Result<()> {
    let h = Harness::new("max-envelope").await?;
    h.funded().await?;
    let now = h.now().await?;
    let mut b = bundle(now);
    b["account_proof"] = json!([]);
    let shape = json!({"schema_version":1,"policy_id":"rpc-finalized-2of2-v1","controller_id":"controller","request_id":"2","chain_id":"11155111","vault":VAULT,"requested_at":now.to_string(),"expires_at":(now+600).to_string(),"bundle":b});
    let empty_len = shape.to_string().len();
    // All node encodings and per-node/total limits are admissible. These are
    // intentionally synthetic zero nodes: entry gas, not valid-trie host sizing.
    let mut nodes = vec![format!("0x{}", "00".repeat(1024)); 15];
    // JSON contributes two quotes and a separator per string. The empty array
    // contributed two brackets already; 16 node strings add 16*4+15 overhead.
    let mut remaining = 32768 - empty_len - (15 * 2048 + 16 * 4 + 15);
    if !remaining.is_multiple_of(2) {
        b["block_number"] = json!("1234");
        remaining -= 1;
    }
    assert!(remaining <= 2048 && remaining.is_multiple_of(2));
    nodes.push(format!("0x{}", "00".repeat(remaining / 2)));
    b["account_proof"] = json!(nodes);
    let (tx, r) = h.start(b.clone()).await?;
    assert_eq!(r["args"]["input_data"].as_str().unwrap().len(), 32768);
    h.resume(&r, "null".into(), false).await?;
    finish(tx, false).await?;
    h.no_evidence("Funding").await?;
    // One more proof byte adds two hex characters and exceeds the envelope.
    b["account_proof"][15] = json!(format!("{}00", b["account_proof"][15].as_str().unwrap()));
    let fail = h
        .call("controller", "request_proof", json!({"bundle":b}))
        .await?;
    assert!(fail["status"].get("Failure").is_some());
    assert!(fail.to_string().contains("serialized input exceeds limit"));
    assert_eq!(h.view("executor", "get_count").await?, 1);
    h.no_evidence("Funding").await?;
    Ok(())
}

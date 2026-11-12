//! Fixed-provider purpose-bound settlement worker. Reuses the production bounded
//! HTTPS transport and its single absolute deadline per request/body/trailers.
use proofcredit_proof_protocol::{quantities::format_u256, CheckpointObservation};
use proofcredit_proof_worker::read_bounded;
pub use proofcredit_proof_worker::rpc::WasiTransport;
pub use proofcredit_proof_worker::{Provider, RpcResponse, RpcTransport, WorkerError, PROVIDERS};
use proofcredit_settlement_protocol::*;
use serde_json::{json, Value};
use std::io::{self, Read, Write};
fn rpc(
    t: &impl RpcTransport,
    p: Provider,
    id: u32,
    method: &str,
    params: Value,
) -> Result<Value, WorkerError> {
    let bytes =
        serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .map_err(|_| WorkerError::Rpc)?;
    let r = t.post(p, &bytes)?;
    if r.status != 200 {
        return Err(WorkerError::Http);
    }
    let raw = read_bounded(r.body, MAX_RPC_BYTES, WorkerError::RpcTooLarge)?;
    let v: Value = serde_json::from_slice(&raw).map_err(|_| WorkerError::Rpc)?;
    let o = v.as_object().ok_or(WorkerError::Rpc)?;
    if o.get("jsonrpc") != Some(&json!("2.0"))
        || o.get("id") != Some(&json!(id))
        || o.contains_key("error")
    {
        return Err(WorkerError::Rpc);
    }
    o.get("result")
        .filter(|v| !v.is_null())
        .cloned()
        .ok_or(WorkerError::Rpc)
}
fn quantity(v: &Value) -> Result<String, WorkerError> {
    let s = v
        .as_str()
        .and_then(|s| s.strip_prefix("0x"))
        .ok_or(WorkerError::Rpc)?;
    if s.is_empty()
        || s.len() > 64
        || (s.len() > 1 && s.starts_with('0'))
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(WorkerError::Rpc);
    }
    let padded = format!("{s:0>64}");
    let b: [u8; 32] = decode_hex(&format!("0x{padded}"))
        .map_err(|_| WorkerError::Rpc)?
        .try_into()
        .map_err(|_| WorkerError::Rpc)?;
    Ok(format_u256(&b))
}
fn data(v: &Value, len: usize) -> Result<String, WorkerError> {
    let s = v.as_str().ok_or(WorkerError::Rpc)?.to_ascii_lowercase();
    if s.len() != 2 + len * 2 {
        return Err(WorkerError::Rpc);
    }
    decode_hex(&s).map_err(|_| WorkerError::Rpc)?;
    Ok(s)
}
fn scalar(v: &Value) -> Result<String, WorkerError> {
    quantity(v)?;
    let s = v.as_str().ok_or(WorkerError::Rpc)?;
    Ok(format!("0x{:0>64}", &s[2..]))
}
fn transaction(v: &Value) -> Result<TransactionObservation, WorkerError> {
    let parity = if v.get("yParity").is_some() {
        quantity(&v["yParity"])?
    } else {
        quantity(&v["v"])?
    };
    if v.get("v").is_some() && quantity(&v["v"])? != parity {
        return Err(WorkerError::Rpc);
    }
    let input = v["input"]
        .as_str()
        .ok_or(WorkerError::Rpc)?
        .to_ascii_lowercase();
    decode_hex(&input).map_err(|_| WorkerError::Rpc)?;
    Ok(TransactionObservation {
        hash: data(&v["hash"], 32)?,
        chain_id: quantity(&v["chainId"])?,
        nonce: quantity(&v["nonce"])?,
        from: data(&v["from"], 20)?,
        to: data(&v["to"], 20)?,
        value: quantity(&v["value"])?,
        gas: quantity(&v["gas"])?,
        max_fee_per_gas: quantity(&v["maxFeePerGas"])?,
        max_priority_fee_per_gas: quantity(&v["maxPriorityFeePerGas"])?,
        transaction_type: quantity(&v["type"])?,
        input,
        empty_access_list: v["accessList"]
            .as_array()
            .ok_or(WorkerError::Rpc)?
            .is_empty(),
        r: scalar(&v["r"])?,
        s: scalar(&v["s"])?,
        y_parity: parity,
        block_hash: data(&v["blockHash"], 32)?,
        block_number: quantity(&v["blockNumber"])?,
        transaction_index: quantity(&v["transactionIndex"])?,
    })
}
fn receipt(v: &Value) -> Result<ReceiptObservation, WorkerError> {
    let contract = match v.get("contractAddress") {
        Some(Value::Null) => None,
        Some(value) => Some(data(value, 20)?),
        None => return Err(WorkerError::Rpc),
    };
    Ok(ReceiptObservation {
        transaction_hash: data(&v["transactionHash"], 32)?,
        transaction_index: quantity(&v["transactionIndex"])?,
        block_hash: data(&v["blockHash"], 32)?,
        block_number: quantity(&v["blockNumber"])?,
        from: data(&v["from"], 20)?,
        to: data(&v["to"], 20)?,
        transaction_type: quantity(&v["type"])?,
        status: quantity(&v["status"])?,
        gas_used: quantity(&v["gasUsed"])?,
        effective_gas_price: quantity(&v["effectiveGasPrice"])?,
        contract_address: contract,
    })
}
fn inclusion_header(header: &Value) -> Result<InclusionHeader, WorkerError> {
    Ok(InclusionHeader {
        block_number: quantity(&header["number"])?,
        block_hash: data(&header["hash"], 32)?,
        state_root: data(&header["stateRoot"], 32)?,
        block_timestamp: quantity(&header["timestamp"])?,
        base_fee_per_gas: quantity(&header["baseFeePerGas"])?,
    })
}

fn observation(
    t: &impl RpcTransport,
    p: Provider,
    r: &SettlementRequest,
) -> Result<SettlementObservation, WorkerError> {
    let number = decimal_u64(&r.bundle.block_number).map_err(|_| WorkerError::Protocol)?;
    let chain = quantity(&rpc(t, p, 1, "eth_chainId", json!([]))?)?;
    let finalized = rpc(t, p, 2, "eth_getBlockByNumber", json!(["finalized", false]))?;
    let header = rpc(
        t,
        p,
        3,
        "eth_getBlockByNumber",
        json!([format!("0x{number:x}"), false]),
    )?;
    let checkpoint = CheckpointObservation {
        provider_id: p.id.into(),
        chain_id: chain,
        finalized_number: quantity(&finalized["number"])?,
        block_number: quantity(&header["number"])?,
        block_hash: data(&header["hash"], 32)?,
        state_root: data(&header["stateRoot"], 32)?,
        block_timestamp: quantity(&header["timestamp"])?,
    };
    let (transaction, receipt, inclusion_header) = match &r.purpose {
        SettlementPurpose::Prepare => (None, None, None),
        SettlementPurpose::Confirm { candidate, .. } => {
            let tx = rpc(t, p, 4, "eth_getTransactionByHash", json!([candidate.hash]))?;
            let re = rpc(
                t,
                p,
                5,
                "eth_getTransactionReceipt",
                json!([candidate.hash]),
            )?;
            let tx = transaction(&tx)?;
            let receipt = receipt(&re)?;
            let inclusion = if receipt.block_number == r.bundle.block_number {
                inclusion_header(&header)?
            } else {
                let inclusion_number =
                    decimal_u64(&receipt.block_number).map_err(|_| WorkerError::Rpc)?;
                let historical = rpc(
                    t,
                    p,
                    6,
                    "eth_getBlockByNumber",
                    json!([format!("0x{inclusion_number:x}"), false]),
                )?;
                inclusion_header(&historical)?
            };
            (Some(tx), Some(receipt), Some(inclusion))
        }
    };
    Ok(SettlementObservation {
        inclusion_header,
        base_fee_per_gas: quantity(&header["baseFeePerGas"])?,
        checkpoint,
        transaction,
        receipt,
    })
}
pub fn run_settlement(
    input: &[u8],
    transport: &impl RpcTransport,
    now: u64,
) -> Result<Vec<u8>, WorkerError> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(WorkerError::InputTooLarge);
    }
    let request = parse_settlement_request(input, now).map_err(|_| WorkerError::Protocol)?;
    let observations = [
        observation(transport, PROVIDERS[0], &request)?,
        observation(transport, PROVIDERS[1], &request)?,
    ];
    let evidence = match request.purpose {
        SettlementPurpose::Prepare => verify_prepare(input, &observations, now),
        SettlementPurpose::Confirm { .. } => verify_confirmation(input, &observations, now),
    }
    .map_err(|_| WorkerError::Protocol)?;
    let output = serde_json::to_vec(&evidence).map_err(|_| WorkerError::Protocol)?;
    if output.len() > MAX_OUTPUT_BYTES {
        return Err(WorkerError::Protocol);
    }
    Ok(output)
}
pub fn run_entry(
    input: impl Read,
    mut out: impl Write,
    mut diagnostics: impl Write,
    transport: &impl RpcTransport,
    now: u64,
) -> io::Result<()> {
    let result = read_bounded(input, MAX_INPUT_BYTES, WorkerError::InputTooLarge)
        .and_then(|b| run_settlement(&b, transport, now));
    let bytes = match result {
        Ok(bytes) => bytes,
        Err(e) => {
            writeln!(diagnostics, "settlement worker rejected: {}", e.code())?;
            serde_json::to_vec(&json!({"status":"rejected","code":e.code()}))?
        }
    };
    out.write_all(&bytes)?;
    out.write_all(b"\n")?;
    out.flush()
}

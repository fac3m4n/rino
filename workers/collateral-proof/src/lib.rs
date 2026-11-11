//! Bounded adapter for the fixed two-provider RPC trust policy.
use proofcredit_proof_protocol::{
    parse_request, verify_request, CheckpointObservation, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES,
    MAX_RPC_BYTES,
};
use serde_json::{json, Value};
use std::io::{self, Read, Write};
pub mod rpc;
pub use rpc::{Provider, RpcResponse, RpcTransport, PROVIDERS};

#[derive(Debug, PartialEq, Eq)]
pub enum WorkerError {
    Unavailable,
    InputTooLarge,
    RpcTooLarge,
    Rpc,
    Timeout,
    Http,
    Protocol,
    Io,
}
impl WorkerError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unavailable => "transport_unavailable",
            Self::InputTooLarge => "input_too_large",
            Self::RpcTooLarge => "rpc_too_large",
            Self::Rpc => "invalid_rpc",
            Self::Timeout => "rpc_timeout",
            Self::Http => "http_rejected",
            Self::Protocol => "protocol_rejected",
            Self::Io => "io_error",
        }
    }
}
impl std::fmt::Display for WorkerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for WorkerError {}

/// Reads at most limit+1 bytes; never appends the overflow sentinel to the buffer.
/// Each read is limited before the remote/host stream can allocate a chunk.
pub fn read_bounded(
    mut reader: impl Read,
    limit: usize,
    overflow: WorkerError,
) -> Result<Vec<u8>, WorkerError> {
    let mut result = Vec::with_capacity(limit.min(4096));
    let mut chunk = [0; 4096];
    loop {
        let wanted = (limit - result.len() + 1).min(chunk.len());
        let n = match reader.read(&mut chunk[..wanted]) {
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == io::ErrorKind::TimedOut => return Err(WorkerError::Timeout),
            Err(_) => return Err(WorkerError::Io),
        };
        if n == 0 {
            return Ok(result);
        }
        if n > limit - result.len() {
            return Err(overflow);
        }
        result.extend_from_slice(&chunk[..n]);
    }
}
fn quantity(v: &Value) -> Result<u64, WorkerError> {
    let s = v
        .as_str()
        .ok_or(WorkerError::Rpc)?
        .strip_prefix("0x")
        .ok_or(WorkerError::Rpc)?;
    if s.is_empty()
        || s.len() > 16
        || (s.len() > 1 && s.starts_with('0'))
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(WorkerError::Rpc);
    }
    u64::from_str_radix(s, 16).map_err(|_| WorkerError::Rpc)
}
fn rpc(
    transport: &impl RpcTransport,
    provider: Provider,
    id: u32,
    method: &str,
    params: Value,
) -> Result<Value, WorkerError> {
    let request =
        serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .map_err(|_| WorkerError::Rpc)?;
    let response = transport.post(provider, &request)?;
    // Redirects are never followed; all non-success statuses fail before body reads.
    if response.status != 200 {
        return Err(WorkerError::Http);
    }
    let bytes = read_bounded(response.body, MAX_RPC_BYTES, WorkerError::RpcTooLarge)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| WorkerError::Rpc)?;
    let object = value.as_object().ok_or(WorkerError::Rpc)?;
    if object.get("jsonrpc") != Some(&json!("2.0"))
        || object.get("id") != Some(&json!(id))
        || object.contains_key("error")
    {
        return Err(WorkerError::Rpc);
    }
    object
        .get("result")
        .filter(|v| !v.is_null())
        .cloned()
        .ok_or(WorkerError::Rpc)
}
fn observation(
    transport: &impl RpcTransport,
    p: Provider,
    number: u64,
) -> Result<CheckpointObservation, WorkerError> {
    let chain = quantity(&rpc(transport, p, 1, "eth_chainId", json!([]))?)?;
    let finalized = rpc(
        transport,
        p,
        2,
        "eth_getBlockByNumber",
        json!(["finalized", false]),
    )?;
    let header = rpc(
        transport,
        p,
        3,
        "eth_getBlockByNumber",
        json!([format!("0x{number:x}"), false]),
    )?;
    Ok(CheckpointObservation {
        provider_id: p.id.into(),
        chain_id: chain.to_string(),
        finalized_number: quantity(&finalized["number"])?.to_string(),
        block_number: quantity(&header["number"])?.to_string(),
        block_hash: header["hash"].as_str().ok_or(WorkerError::Rpc)?.into(),
        state_root: header["stateRoot"].as_str().ok_or(WorkerError::Rpc)?.into(),
        block_timestamp: quantity(&header["timestamp"])?.to_string(),
    })
}
/// Verifies exact original input bytes. The clock and transport are trusted runtime
/// inputs; request JSON cannot choose endpoints, provider identity, or time.
pub fn run_worker(
    input: &[u8],
    transport: &impl RpcTransport,
    now_seconds: u64,
) -> Result<Vec<u8>, WorkerError> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(WorkerError::InputTooLarge);
    }
    let request = parse_request(input, now_seconds).map_err(|_| WorkerError::Protocol)?;
    let number = request
        .bundle
        .block_number
        .parse()
        .map_err(|_| WorkerError::Protocol)?;
    let observations = [
        observation(transport, PROVIDERS[0], number)?,
        observation(transport, PROVIDERS[1], number)?,
    ];
    let evidence =
        verify_request(input, &observations, now_seconds).map_err(|_| WorkerError::Protocol)?;
    let output = serde_json::to_vec(&evidence).map_err(|_| WorkerError::Protocol)?;
    if output.len() > MAX_OUTPUT_BYTES {
        return Err(WorkerError::Protocol);
    }
    Ok(output)
}
/// One JSON line on stdout, bounded static diagnostics on stderr, also on rejection.
pub fn run_entry(
    input: impl Read,
    mut out: impl Write,
    mut diagnostics: impl Write,
    transport: &impl RpcTransport,
    now: u64,
) -> io::Result<()> {
    let result = read_bounded(input, MAX_INPUT_BYTES, WorkerError::InputTooLarge)
        .and_then(|bytes| run_worker(&bytes, transport, now));
    let bytes = match result {
        Ok(bytes) => bytes,
        Err(error) => {
            writeln!(diagnostics, "proof worker rejected: {}", error.code())?;
            serde_json::to_vec(&json!({"status":"rejected","code":error.code()}))?
        }
    };
    out.write_all(&bytes)?;
    out.write_all(b"\n")?;
    out.flush()
}

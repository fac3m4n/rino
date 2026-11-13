use crate::{Config, NetworkMode};
use near_sdk::env;

pub fn validate_url(value: &str) {
    assert!(
        value.len() <= 2048 && !value.chars().any(|c| c.is_whitespace() || c.is_control()),
        "invalid WASM URL"
    );
    let url = url::Url::parse(value).expect("invalid WASM URL");
    assert!(
        value.starts_with("https://")
            && url.scheme() == "https"
            && url.host_str().is_some()
            && url.port_or_known_default() == Some(443)
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none(),
        "invalid HTTPS WASM URL"
    );
}

pub fn execution_args(config: &Config, input: &[u8]) -> Vec<u8> {
    let secrets_ref = match config.network {
        NetworkMode::NearTestnet => serde_json::json!({
            "profile": "rino-rpc-v1",
            "account_id": env::current_account_id(),
        }),
        NetworkMode::Sandbox { .. } => serde_json::Value::Null,
    };
    serde_json::to_vec(&serde_json::json!({
        "source":{"WasmUrl":{"url":config.wasm_url,"hash":config.wasm_sha256,"build_target":"wasm32-wasip2"}},
        "resource_limits":{"max_instructions":1_000_000_000u64,"max_memory_mb":128,"max_execution_seconds":60},
        "input_data":std::str::from_utf8(input).expect("serialized UTF-8"),
        "secrets_ref":secrets_ref,
        "response_format":"Json",
        "payer_account_id":env::current_account_id(),
        "params":null
    })).expect("fixed execution arguments")
}

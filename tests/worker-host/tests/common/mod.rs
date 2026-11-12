use rlp::RlpStream;
use serde_json::{Value, json};
use tiny_keccak::{Hasher, Keccak};
fn hex(b: &[u8]) -> String {
    format!(
        "0x{}",
        b.iter().map(|v| format!("{v:02x}")).collect::<String>()
    )
}
fn keccak(b: &[u8]) -> [u8; 32] {
    let mut h = Keccak::v256();
    h.update(b);
    let mut out = [0; 32];
    h.finalize(&mut out);
    out
}
// Synthetic funded EOA and synthetic two-provider headers, never a live vault/finality claim.
pub fn fixture() -> Value {
    fixture_nonce(0)
}
pub fn fixture_nonce(nonce: u64) -> Value {
    let mut account = RlpStream::new_list(4);
    account.append(&nonce);
    account.append(&1_000_000_000_000_000_000u64);
    let storage = hex_bytes("56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421");
    let code = hex_bytes("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    account.append(&storage);
    account.append(&code);
    let mut path = vec![0x20];
    path.extend(keccak(&[0x11; 20]));
    let mut leaf = RlpStream::new_list(2);
    leaf.append(&path);
    leaf.append(&account.out().to_vec());
    let leaf = leaf.out();
    json!({"schema_version":1,"policy_id":"rpc-finalized-2of2-v1","controller_id":"controller.testnet","request_id":"42","chain_id":"11155111","vault":hex(&[0x11;20]),"requested_at":"10000","expires_at":"10600","bundle":{"block_number":"123","block_hash":hex(&[0x22;32]),"state_root":hex(&keccak(&leaf)),"block_timestamp":"9900","account_proof":[hex(&leaf)]}})
}
fn hex_bytes(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

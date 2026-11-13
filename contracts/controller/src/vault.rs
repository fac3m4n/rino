use near_sdk::{CurveType, PublicKey, env};
pub const DERIVATION_PATH: &str = "rino:sepolia:v1:0";

/// MPC JSON is a typed NEAR secp256k1 key; Ethereum hashes only its x/y bytes.
pub fn derive_address(raw: &[u8]) -> Option<String> {
    let key: PublicKey = serde_json::from_slice(raw).ok()?;
    if key.curve_type() != CurveType::SECP256K1 {
        return None;
    }
    let bytes = key.as_bytes().get(1..)?;
    if bytes.len() != 64 {
        return None;
    }
    let mut uncompressed = [0u8; 65];
    uncompressed[0] = 4;
    uncompressed[1..].copy_from_slice(bytes);
    k256::PublicKey::from_sec1_bytes(&uncompressed).ok()?;
    let hash = env::keccak256(bytes);
    Some(hex(&hash[12..]))
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(2 + bytes.len() * 2);
    text.push_str("0x");
    for b in bytes {
        text.push(DIGITS[(b >> 4) as usize] as char);
        text.push(DIGITS[(b & 15) as usize] as char);
    }
    text
}

//! Checked unsigned decimal conversion; all quantities stay in integer bytes.
use crate::ProtocolError;

fn canonical(value: &str, max_digits: usize) -> Result<(), ProtocolError> {
    if value.is_empty()
        || value.len() > max_digits
        || !value.bytes().all(|b| b.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(ProtocolError::InvalidQuantity);
    }
    Ok(())
}

pub(crate) fn parse_u64(value: &str) -> Result<u64, ProtocolError> {
    canonical(value, 20)?;
    value.parse().map_err(|_| ProtocolError::InvalidQuantity)
}

/// Parse a canonical decimal uint256 into 32 big-endian bytes without truncation.
pub fn parse_u256(value: &str) -> Result<[u8; 32], ProtocolError> {
    canonical(value, 78)?;
    let mut result = [0u8; 32];
    for digit in value.bytes() {
        let mut carry = u16::from(digit - b'0');
        for byte in result.iter_mut().rev() {
            let product = u16::from(*byte) * 10 + carry;
            *byte = product as u8;
            carry = product >> 8;
        }
        if carry != 0 {
            return Err(ProtocolError::InvalidQuantity);
        }
    }
    Ok(result)
}

/// Format 32 big-endian bytes as canonical decimal, including zero.
pub fn format_u256(value: &[u8; 32]) -> String {
    if *value == [0; 32] {
        return "0".into();
    }
    let mut remaining = *value;
    let mut digits = Vec::with_capacity(78);
    while remaining != [0; 32] {
        let mut remainder = 0u16;
        for byte in &mut remaining {
            let dividend = (remainder << 8) | u16::from(*byte);
            *byte = (dividend / 10) as u8;
            remainder = dividend % 10;
        }
        digits.push(char::from(b'0' + remainder as u8));
    }
    digits.into_iter().rev().collect()
}

use rino_settlement_protocol::*;
use serde_json::json;
mod common;
use common::*;
#[test]
fn prepare_proves_zero_and_nonzero_nonce_without_minting_credit() {
    for (n, b) in [(0, 0), (1, 0), (111, 400)] {
        let r = fixture(n, b, EMPTY_CODE_HASH, None);
        let e = prepare(&r).unwrap();
        assert_eq!(e.nonce, n.to_string());
        assert_eq!(e.balance_wei, b.to_string());
        assert_eq!(e.beneficiary_code_hash, Some(EMPTY_CODE_HASH.into()));
        assert_eq!(
            validate_settlement_evidence(&enc(&e), &r, &settlement_request_digest(&enc(&r)), NOW),
            Ok(e)
        );
    }
}
#[test]
fn account_absence_only_allows_zero_expected_nonce() {
    let mut r = fixture(0, 0, EMPTY_CODE_HASH, None);
    r.bundle.state_root = hx(&keccak(&[0x80]));
    r.bundle.vault_account_proof.clear();
    r.bundle.beneficiary_account_proof.clear();
    assert_eq!(prepare(&r).unwrap().balance_wei, "0");
    r.expected_nonce = "1".into();
    assert!(prepare(&r).is_err());
}
#[test]
fn recipient_code_and_delegation_and_sender_code_reject() {
    assert!(prepare(&fixture(3, 1, EMPTY_CODE_HASH, Some(EMPTY_CODE_HASH))).is_ok());
    for code in [hx(&[0x77; 32]), hx(&keccak(&[0xef, 0x01, 0x00, 1]))] {
        assert!(prepare(&fixture(3, 1, EMPTY_CODE_HASH, Some(&code))).is_err());
        assert!(prepare(&fixture(3, 1, &code, None)).is_err());
    }
}
#[test]
fn both_receipt_statuses_require_exact_post_nonce_and_allow_incoming_eth() {
    for status in ["0", "1"] {
        let (r, o) = confirm_fixture(status, 3_000_000_000_000_000);
        let e = confirm(&r, &o).unwrap();
        assert_eq!(e.receipt.as_ref().unwrap().status, status);
        assert_eq!(e.inclusion_header.as_ref().unwrap().block_number, "123");
        assert_eq!(e.nonce, "112");
        assert_eq!(
            validate_settlement_evidence(&enc(&e), &r, &settlement_request_digest(&enc(&r)), NOW),
            Ok(e)
        );
    }
    // A drained successful transfer may prove an actual zero balance.
    let (mut drained, drained_obs) = confirm_fixture("1", 0);
    if let SettlementPurpose::Confirm {
        before_balance_wei, ..
    } = &mut drained.purpose
    {
        *before_balance_wei = "2223456789012345".into();
    }
    assert_eq!(confirm(&drained, &drained_obs).unwrap().balance_wei, "0");
    // Recipient code may change after preparation. Authentic included failure
    // still consumes nonce/fee and must be confirmed rather than left locked.
    let (mut changed, mut changed_obs) = confirm_fixture("0", 3_000_000_000_000_000);
    changed.bundle = fixture(
        112,
        3_000_000_000_000_000,
        EMPTY_CODE_HASH,
        Some(&hx(&[0x77; 32])),
    )
    .bundle;
    for observation in &mut changed_obs {
        observation.checkpoint.state_root = changed.bundle.state_root.clone();
        observation.inclusion_header.as_mut().unwrap().state_root =
            changed.bundle.state_root.clone();
    }
    assert!(confirm(&changed, &changed_obs).is_ok());
    let (mut r, o) = confirm_fixture("1", 3_000_000_000_000_000);
    let n2 = fixture(113, 3_000_000_000_000_000, EMPTY_CODE_HASH, None);
    r.bundle = n2.bundle;
    let mut o = o;
    for e in &mut o {
        e.checkpoint.state_root = r.bundle.state_root.clone();
        e.inclusion_header.as_mut().unwrap().state_root = r.bundle.state_root.clone();
    }
    assert!(confirm(&r, &o).is_err());
}
#[test]
fn contradictory_balance_and_status_and_missing_receipt_hold() {
    let (r, o) = confirm_fixture("1", 776_543_210_987_655);
    assert!(confirm(&r, &o).is_ok());
    for status in ["0", "2", "01"] {
        let (r, o) = confirm_fixture(status, 776_543_210_987_655);
        assert!(confirm(&r, &o).is_err());
    }
    let (r, o) = confirm_fixture("1", 776_543_210_987_654);
    assert!(confirm(&r, &o).is_err());
    let (r, mut o) = confirm_fixture("1", 3_000_000_000_000_000);
    o[1].receipt = None;
    assert!(confirm(&r, &o).is_err());
}
#[test]
fn transaction_and_receipt_every_binding_is_enforced() {
    let (r, o) = confirm_fixture("1", 3_000_000_000_000_000);
    assert!(confirm(&r, &o).is_ok());
    let original = serde_json::to_value(o[1].transaction.as_ref().unwrap()).unwrap();
    for (field, value) in original.as_object().unwrap() {
        let mut mutated = original.clone();
        mutated[field] = if value.is_boolean() {
            json!(false)
        } else {
            json!("wrong")
        };
        let mut wrong = o.clone();
        wrong[1].transaction = Some(serde_json::from_value(mutated).unwrap());
        assert!(confirm(&r, &wrong).is_err(), "tx {field}");
    }
    let original = serde_json::to_value(o[1].receipt.as_ref().unwrap()).unwrap();
    for field in original.as_object().unwrap().keys() {
        let mut mutated = original.clone();
        mutated[field] = json!("wrong");
        let mut wrong = o.clone();
        wrong[1].receipt = Some(serde_json::from_value(mutated).unwrap());
        assert!(confirm(&r, &wrong).is_err(), "receipt {field}");
    }
}
#[test]
fn immutable_candidate_fields_and_signature_are_verified() {
    let (r, o) = confirm_fixture("1", 3_000_000_000_000_000);
    assert!(confirm(&r, &o).is_ok());
    for path in ["raw", "hash", "signing_digest", "r", "s", "y_parity"] {
        let mut v = serde_json::to_value(&r).unwrap();
        v["purpose"]["candidate"][path] = json!(if path == "y_parity" {
            "0".into()
        } else {
            hx(&[0; 32])
        });
        assert!(verify_confirmation(&enc(&v), &o, NOW).is_err(), "{path}");
    }
    for field in ["nonce", "chain_id", "value", "gas_limit", "gas_price", "to"] {
        let mut v = serde_json::to_value(&r).unwrap();
        v["purpose"]["intent"][field] = json!("0");
        assert!(verify_confirmation(&enc(&v), &o, NOW).is_err(), "{field}");
    }
}
#[test]
fn provider_disagreement_and_finality_fail_closed() {
    let r = fixture(1, 1, EMPTY_CODE_HASH, None);
    assert!(prepare(&r).is_ok());
    for field in [
        "provider_id",
        "chain_id",
        "block_number",
        "block_hash",
        "state_root",
        "block_timestamp",
        "finalized_number",
    ] {
        let mut o = obs(&r);
        let mut v = serde_json::to_value(&o[1].checkpoint).unwrap();
        v[field] = json!("0");
        o[1].checkpoint = serde_json::from_value(v).unwrap();
        assert!(verify_prepare(&enc(&r), &o, NOW).is_err());
    }
    let mut o = obs(&r);
    o[1].checkpoint.provider_id = o[0].checkpoint.provider_id.clone();
    assert!(verify_prepare(&enc(&r), &o, NOW).is_err());
}
#[test]
fn strict_quantities_time_hex_purpose_and_size_bounds() {
    let r = fixture(1, 1, EMPTY_CODE_HASH, None);
    assert!(prepare(&r).is_ok());
    for field in [
        "generation",
        "request_id",
        "chain_id",
        "expected_nonce",
        "requested_at",
        "expires_at",
    ] {
        for bad in [
            json!("01"),
            json!(1),
            json!("-1"),
            json!("18446744073709551616"),
        ] {
            let mut v = serde_json::to_value(&r).unwrap();
            v[field] = bad;
            assert!(parse_settlement_request(&enc(&v), NOW).is_err(), "{field}");
        }
    }
    for now in [9999, 10601] {
        assert!(verify_prepare(&enc(&r), &obs(&r), now).is_err());
    }
    let mut v = serde_json::to_value(&r).unwrap();
    v["purpose"]["unexpected"] = json!(1);
    assert!(parse_settlement_request(&enc(&v), NOW).is_err());
    v = serde_json::to_value(&r).unwrap();
    v["bundle"]["block_timestamp"] = json!("6399");
    assert!(parse_settlement_request(&enc(&v), NOW).is_err());
    v["bundle"]["block_timestamp"] = json!("10001");
    assert!(parse_settlement_request(&enc(&v), NOW).is_err());
    let mut b = enc(&r);
    b.resize(32768, b' ');
    assert!(parse_settlement_request(&b, NOW).is_ok());
    b.push(b' ');
    assert_eq!(
        parse_settlement_request(&b, NOW),
        Err(ProtocolError::InputTooLarge)
    );
    assert!(verify_confirmation(&enc(&r), &obs(&r), NOW).is_err());
}
#[test]
fn evidence_binds_all_context_and_exact_input_and_acceptance_time() {
    let r = fixture(1, 1, EMPTY_CODE_HASH, None);
    let e = prepare(&r).unwrap();
    let digest = settlement_request_digest(&enc(&r));
    assert_eq!(
        hx(&settlement_request_digest(b"abc")),
        "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    let mut spaced = enc(&r);
    spaced.push(b' ');
    assert_ne!(digest, settlement_request_digest(&spaced));
    let original = serde_json::to_value(&e).unwrap();
    for field in original.as_object().unwrap().keys() {
        let mut v = original.clone();
        v[field] = if field == "schema_version" {
            json!(2)
        } else {
            json!("wrong")
        };
        assert!(
            validate_settlement_evidence(&enc(&v), &r, &digest, NOW).is_err(),
            "{field}"
        );
    }
    let mut b = enc(&e);
    b.resize(8192, b' ');
    assert!(validate_settlement_evidence(&b, &r, &digest, NOW).is_ok());
    b.push(b' ');
    assert_eq!(
        validate_settlement_evidence(&b, &r, &digest, NOW),
        Err(ProtocolError::OutputTooLarge)
    );
    assert!(validate_settlement_evidence(&enc(&e), &r, &digest, 10601).is_err());
}

#[test]
fn prepare_authenticates_canonical_matching_base_fee_from_both_headers() {
    let r = fixture(0, 1, EMPTY_CODE_HASH, None);
    assert!(prepare(&r).is_ok());
    for bad in [
        "",
        "01",
        "-1",
        "1.0",
        "340282366920938463463374607431768211456",
        "10000000001",
    ] {
        let mut observations = obs(&r);
        observations[1].base_fee_per_gas = bad.into();
        assert!(
            verify_prepare(&enc(&r), &observations, NOW).is_err(),
            "{bad}"
        );
    }
    let mut observations = obs(&r);
    for o in &mut observations {
        o.base_fee_per_gas = "01".into();
    }
    assert!(verify_prepare(&enc(&r), &observations, NOW).is_err());
}
#[test]
fn evidence_carries_authenticated_checkpoint_base_fee_and_checks_its_encoding() {
    let r = fixture(0, 1, EMPTY_CODE_HASH, None);
    let e = prepare(&r).unwrap();
    assert_eq!(e.base_fee_per_gas, "10000000000");
    let mut v = serde_json::to_value(&e).unwrap();
    for bad in [
        json!("01"),
        json!("-1"),
        json!(1),
        json!("340282366920938463463374607431768211456"),
    ] {
        v["base_fee_per_gas"] = bad;
        assert!(validate_settlement_evidence(
            &enc(&v),
            &r,
            &settlement_request_digest(&enc(&r)),
            NOW
        )
        .is_err());
    }
    v.as_object_mut().unwrap().remove("base_fee_per_gas");
    assert!(
        validate_settlement_evidence(&enc(&v), &r, &settlement_request_digest(&enc(&r)), NOW)
            .is_err()
    );
}
#[test]
fn confirmation_cannot_claim_inclusion_below_authenticated_base_fee() {
    let (r, mut observations) = confirm_fixture("1", 3_000_000_000_000_000);
    assert!(confirm(&r, &observations).is_ok());
    for observation in &mut observations {
        observation.base_fee_per_gas = "100000000001".into();
        observation
            .inclusion_header
            .as_mut()
            .unwrap()
            .base_fee_per_gas = "100000000001".into();
    }
    assert!(confirm(&r, &observations).is_err());
}

#[test]
fn historical_receipt_uses_fresh_poststate_after_long_outage_and_inclusion_fee() {
    for status in ["0", "1"] {
        let (r, observations) = historical_confirm_fixture(status, 3_000_000_000_000_000);
        let evidence = confirm(&r, &observations).unwrap();
        assert_eq!(evidence.block_number, "124");
        assert_eq!(evidence.base_fee_per_gas, "200000000000");
        let inclusion = evidence.inclusion_header.as_ref().unwrap();
        assert_eq!(inclusion.block_number, "123");
        assert_eq!(inclusion.block_timestamp, "1000");
        assert_eq!(inclusion.base_fee_per_gas, "10000000000");
        assert_eq!(evidence.receipt.as_ref().unwrap().block_number, "123");
        assert_eq!(
            validate_settlement_evidence(
                &enc(&evidence),
                &r,
                &settlement_request_digest(&enc(&r)),
                NOW
            ),
            Ok(evidence)
        );
    }
}
#[test]
fn inclusion_header_requires_canonical_quorum_linkage_and_prepared_lower_bound() {
    let (r, observations) = historical_confirm_fixture("1", 3_000_000_000_000_000);
    assert!(confirm(&r, &observations).is_ok());
    let original =
        serde_json::to_value(observations[0].inclusion_header.as_ref().unwrap()).unwrap();
    for field in original.as_object().unwrap().keys() {
        let mut wrong = observations.clone();
        let mut value = original.clone();
        value[field] = json!("wrong");
        wrong[1].inclusion_header = Some(serde_json::from_value(value).unwrap());
        assert!(confirm(&r, &wrong).is_err(), "{field}");
    }
    for (field, value) in [
        ("block_number", "122".to_string()),
        ("block_hash", hx(&[0x77; 32])),
        ("state_root", hx(&[0x77; 32])),
        ("block_timestamp", "1001".into()),
        ("base_fee_per_gas", "10000000001".into()),
    ] {
        let mut wrong = observations.clone();
        let mut header = original.clone();
        header[field] = json!(value);
        wrong[1].inclusion_header = Some(serde_json::from_value(header).unwrap());
        assert!(
            confirm(&r, &wrong).is_err(),
            "canonical provider disagreement {field}"
        );
    }
    for number in ["121", "125", "0123"] {
        let mut wrong = observations.clone();
        for observation in &mut wrong {
            observation.inclusion_header.as_mut().unwrap().block_number = number.into();
            observation.receipt.as_mut().unwrap().block_number = number.into();
            observation.transaction.as_mut().unwrap().block_number = number.into();
        }
        assert!(confirm(&r, &wrong).is_err(), "{number}");
    }
    for timestamp in ["9901", "10001", "01"] {
        let mut wrong = observations.clone();
        for observation in &mut wrong {
            observation
                .inclusion_header
                .as_mut()
                .unwrap()
                .block_timestamp = timestamp.into();
        }
        assert!(confirm(&r, &wrong).is_err());
    }
    let mut wrong = observations.clone();
    wrong[1].inclusion_header = None;
    assert!(confirm(&r, &wrong).is_err());
    let mut wrong = observations.clone();
    for o in &mut wrong {
        o.inclusion_header.as_mut().unwrap().block_hash = hx(&[0x77; 32]);
    }
    assert!(confirm(&r, &wrong).is_err());
}
#[test]
fn historical_confirmation_preserves_nonce_balance_and_evidence_bounds() {
    let (mut r, mut observations) = historical_confirm_fixture("1", 3_000_000_000_000_000);
    let evidence = confirm(&r, &observations).unwrap();
    let mut output = serde_json::to_value(&evidence).unwrap();
    output["inclusion_header"]["unexpected"] = json!(true);
    assert!(validate_settlement_evidence(
        &enc(&output),
        &r,
        &settlement_request_digest(&enc(&r)),
        NOW
    )
    .is_err());
    output = serde_json::to_value(&evidence).unwrap();
    output["inclusion_header"] = serde_json::Value::Null;
    assert!(validate_settlement_evidence(
        &enc(&output),
        &r,
        &settlement_request_digest(&enc(&r)),
        NOW
    )
    .is_err());
    let newer = fixture(113, 3_000_000_000_000_000, EMPTY_CODE_HASH, None);
    r.bundle.state_root = newer.bundle.state_root;
    r.bundle.vault_account_proof = newer.bundle.vault_account_proof;
    for o in &mut observations {
        o.checkpoint.state_root = r.bundle.state_root.clone();
    }
    assert!(confirm(&r, &observations).is_err());
    let (r, o) = historical_confirm_fixture("1", 776_543_210_987_654);
    assert!(confirm(&r, &o).is_err());
}

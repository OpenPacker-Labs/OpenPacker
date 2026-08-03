//! String-based WASM boundary for the pure resolver.
//!
//! JSON strings keep the wire contract byte-oriented and avoid exposing Rust or
//! Resolvo implementation types to JavaScript.

use openpacker_resolver::{
    SolveInput, brute_force_oracle, canonical_json as canonical_bytes, check_json as check_wire,
    digest_json as digest_value, normalize_purl as normalize_purl_value, parse_json,
    parse_vers as parse_vers_value, solve_json as solve_wire,
    validate_universe_json as validate_wire, version_satisfies as satisfies,
};
use sha2::{Digest as _, Sha256};
use wasm_bindgen::prelude::*;

#[cfg(not(target_arch = "wasm32"))]
#[allow(dead_code)] // Exported through Node-API registration rather than Rust callers.
mod native;

fn js_error(error: impl ToString) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[wasm_bindgen]
pub fn solve_json(input: &str) -> Result<String, JsValue> {
    solve_wire(input).map_err(js_error)
}

#[wasm_bindgen]
pub fn check_json(input: &str, output: &str) -> Result<String, JsValue> {
    check_wire(input, output).map_err(js_error)
}

#[wasm_bindgen]
pub fn validate_universe_json(input: &str) -> Result<(), JsValue> {
    validate_wire(input).map_err(js_error)
}

#[wasm_bindgen]
pub fn brute_force_oracle_json(input: &str) -> Result<String, JsValue> {
    let input: SolveInput = openpacker_resolver::parse_json_as(input).map_err(js_error)?;
    let result = brute_force_oracle(&input).map_err(js_error)?;
    String::from_utf8(canonical_bytes(&result).map_err(js_error)?).map_err(js_error)
}

#[wasm_bindgen]
pub fn canonicalize_json(input: &str) -> Result<String, JsValue> {
    let value = parse_json(input).map_err(js_error)?;
    String::from_utf8(canonical_bytes(&value).map_err(js_error)?).map_err(js_error)
}

#[wasm_bindgen]
pub fn digest_json(input: &str) -> Result<String, JsValue> {
    let value = parse_json(input).map_err(js_error)?;
    let digest = digest_value(&value).map_err(js_error)?;
    serde_json::to_string(&digest).map_err(js_error)
}

#[wasm_bindgen]
pub fn version_satisfies(version: &str, vers: &str) -> bool {
    satisfies(version, vers)
}

#[wasm_bindgen]
pub fn normalize_purl(value: &str) -> Result<String, JsValue> {
    normalize_purl_value(value).map_err(js_error)
}

#[wasm_bindgen]
pub fn parse_vers_json(value: &str) -> Result<String, JsValue> {
    serde_json::to_string(&parse_vers_value(value).map_err(js_error)?).map_err(js_error)
}

#[wasm_bindgen]
pub fn verify_sha256(bytes: &[u8], expected: &str) -> bool {
    let actual = Sha256::digest(bytes);
    let mut formatted = String::from("sha256:");
    for byte in actual {
        use std::fmt::Write as _;
        write!(&mut formatted, "{byte:02x}").expect("writing to String cannot fail");
    }
    formatted == expected
}

#[wasm_bindgen]
pub fn verify_receipt_digest(receipt_json: &str, expected: &str) -> Result<bool, JsValue> {
    let value = parse_json(receipt_json).map_err(js_error)?;
    Ok(digest_value(&value).map_err(js_error)?.as_string() == expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_digest_verification() {
        assert!(verify_sha256(
            b"",
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        ));
        assert!(!verify_sha256(
            b"changed",
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        ));
    }

    #[test]
    fn canonical_boundary_is_stable() {
        assert_eq!(
            canonicalize_json(r#"{"z":1,"a":true}"#).unwrap(),
            r#"{"a":true,"z":1}"#
        );
        assert_eq!(canonicalize_json("1.0").unwrap(), "1");
        assert_eq!(
            canonicalize_json("{\"\":1,\"𐀀\":2}").unwrap(),
            "{\"𐀀\":2,\"\":1}"
        );
        assert!(version_satisfies("1.0.0-alpha", "vers:npm/<1.0.0"));
        assert!(version_satisfies(
            "1.0.0+build.1",
            "vers:npm/=1.0.0+build.2"
        ));
    }
}

use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;
use openpacker_resolver::{
    SolveInput, brute_force_oracle, canonical_json as canonical_bytes, check_json as check_wire,
    digest_json as digest_value, normalize_purl as normalize_purl_value, parse_json, parse_json_as,
    parse_vers as parse_vers_value, solve_json as solve_wire,
    validate_universe_json as validate_wire, version_satisfies as satisfies,
};
use sha2::{Digest as _, Sha256};

fn native_error(error: impl ToString) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

#[napi(js_name = "solve_json")]
pub fn solve_json(input: String) -> napi::Result<String> {
    solve_wire(&input).map_err(native_error)
}

#[napi(js_name = "check_json")]
pub fn check_json(input: String, output: String) -> napi::Result<String> {
    check_wire(&input, &output).map_err(native_error)
}

#[napi(js_name = "validate_universe_json")]
pub fn validate_universe_json(input: String) -> napi::Result<()> {
    validate_wire(&input).map_err(native_error)
}

#[napi(js_name = "brute_force_oracle_json")]
pub fn brute_force_oracle_json(input: String) -> napi::Result<String> {
    let input: SolveInput = parse_json_as(&input).map_err(native_error)?;
    let result = brute_force_oracle(&input).map_err(native_error)?;
    String::from_utf8(canonical_bytes(&result).map_err(native_error)?).map_err(native_error)
}

#[napi(js_name = "canonicalize_json")]
pub fn canonicalize_json(input: String) -> napi::Result<String> {
    let value = parse_json(&input).map_err(native_error)?;
    String::from_utf8(canonical_bytes(&value).map_err(native_error)?).map_err(native_error)
}

#[napi(js_name = "digest_json")]
pub fn digest_json(input: String) -> napi::Result<String> {
    let value = parse_json(&input).map_err(native_error)?;
    let digest = digest_value(&value).map_err(native_error)?;
    serde_json::to_string(&digest).map_err(native_error)
}

#[napi(js_name = "version_satisfies")]
pub fn version_satisfies(version: String, vers: String) -> bool {
    satisfies(&version, &vers)
}

#[napi(js_name = "normalize_purl")]
pub fn normalize_purl(value: String) -> napi::Result<String> {
    normalize_purl_value(&value).map_err(native_error)
}

#[napi(js_name = "parse_vers_json")]
pub fn parse_vers_json(value: String) -> napi::Result<String> {
    serde_json::to_string(&parse_vers_value(&value).map_err(native_error)?).map_err(native_error)
}

#[napi(js_name = "verify_sha256")]
pub fn verify_sha256(bytes: Uint8Array, expected: String) -> bool {
    let actual = Sha256::digest(bytes.as_ref());
    let mut formatted = String::from("sha256:");
    for byte in actual {
        use std::fmt::Write as _;
        write!(&mut formatted, "{byte:02x}").expect("writing to String cannot fail");
    }
    formatted == expected
}

#[napi(js_name = "verify_receipt_digest")]
pub fn verify_receipt_digest(receipt_json: String, expected: String) -> napi::Result<bool> {
    let value = parse_json(&receipt_json).map_err(native_error)?;
    Ok(digest_value(&value).map_err(native_error)?.as_string() == expected)
}

//! Cross-checks this crate's canonical JSON against a reference RFC 8785
//! implementation.
//!
//! PREX canonical bytes are computed independently in TypeScript and in Rust.
//! Two hand-written implementations of one specification, with nothing
//! comparing them, is how the ordered-set collation bug reached `main`: Rust
//! sorted by UTF-8 bytes where ECMAScript sorts by UTF-16 code units, and the
//! JavaScript side got the right answer for free because that is what its
//! `sort()` and `<` already do.
//!
//! `serde_jcs` is a dev-dependency rather than a production one on purpose.
//! PREX canonical JSON is a *restriction* of JCS — safe integers only, no lone
//! surrogates — so the crate keeps its own validating serializer and this test
//! pins it to the reference on everything the restriction admits.

use openpacker_resolver::canonical_json;
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};

fn json_files(directory: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            json_files(&path, out);
        } else if path.extension().is_some_and(|value| value == "json") {
            out.push(path);
        }
    }
}

/// PREX admits only safe integers, so documents carrying floats are outside
/// the restriction and are not comparable cases.
fn only_safe_integers(value: &Value) -> bool {
    match value {
        Value::Number(number) => number.is_i64() || number.is_u64(),
        Value::Array(items) => items.iter().all(only_safe_integers),
        Value::Object(members) => members.values().all(only_safe_integers),
        _ => true,
    }
}

#[test]
fn canonical_json_matches_the_reference_jcs_implementation() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("workspace root");

    let mut files = Vec::new();
    json_files(&root.join("fixtures"), &mut files);
    json_files(&root.join("spec"), &mut files);
    assert!(!files.is_empty(), "no corpus found to compare against");

    let mut compared = 0usize;
    for file in files {
        let Ok(text) = fs::read_to_string(&file) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if !only_safe_integers(&value) {
            continue;
        }
        let Ok(mine) = canonical_json(&value) else {
            continue;
        };
        let theirs = serde_jcs::to_vec(&value).expect("reference canonicalization");
        assert_eq!(
            String::from_utf8_lossy(&mine),
            String::from_utf8_lossy(&theirs),
            "canonical bytes disagree with RFC 8785 for {}",
            file.display()
        );
        compared += 1;
    }
    assert!(compared > 0, "corpus produced no comparable documents");
    eprintln!("compared {compared} corpus documents against serde_jcs");
}

#[test]
fn object_name_collation_matches_the_reference() {
    // The exact hazard: U+10000 sorts before U+E000 by UTF-16 code units and
    // after it by UTF-8 bytes. Getting this wrong in either direction puts
    // this crate's digests at odds with every other implementation.
    let value = json!({ "\u{10000}": 1, "\u{E000}": 2 });
    let mine = canonical_json(&value).expect("canonical");
    let theirs = serde_jcs::to_vec(&value).expect("reference");
    assert_eq!(
        String::from_utf8_lossy(&mine),
        String::from_utf8_lossy(&theirs)
    );
}

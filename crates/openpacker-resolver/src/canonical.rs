use std::{collections::BTreeSet, fmt};

use serde::{
    Deserialize, Deserializer, Serialize,
    de::{DeserializeOwned, MapAccess, SeqAccess, Visitor},
};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

use crate::{Digest, ResolverError};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Parse an I-JSON value without silently accepting duplicate object members.
///
/// `serde_json::Value` alone is deliberately not used at wire boundaries: its
/// map deserializer keeps the last duplicate member, which makes signatures
/// and digests ambiguous.
pub fn parse_json(input: &str) -> Result<Value, ResolverError> {
    validate_raw_numbers(input)?;
    let mut deserializer = serde_json::Deserializer::from_str(input);
    let value = StrictValue::deserialize(&mut deserializer)?.0;
    deserializer.end()?;
    validate_canonical_value(&value)?;
    Ok(value)
}

fn validate_raw_numbers(input: &str) -> Result<(), ResolverError> {
    let bytes = input.as_bytes();
    let mut index = 0;
    let mut in_string = false;
    let mut escaped = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            index += 1;
            continue;
        }
        if byte == b'-' || byte.is_ascii_digit() {
            let start = index;
            index += 1;
            while index < bytes.len()
                && !matches!(
                    bytes[index],
                    b',' | b']' | b'}' | b' ' | b'\t' | b'\r' | b'\n'
                )
            {
                index += 1;
            }
            let token = &input[start..index];
            if let Ok(value) = token.parse::<f64>()
                && (!value.is_finite()
                    || value.fract() != 0.0
                    || value == 0.0 && token.starts_with('-')
                    || value.abs() > MAX_SAFE_INTEGER as f64)
            {
                return Err(ResolverError::Canonical(
                    "PREX canonical numbers must be safe integers and not negative zero".into(),
                ));
            }
            continue;
        }
        index += 1;
    }
    Ok(())
}

pub fn parse_json_as<T: DeserializeOwned>(input: &str) -> Result<T, ResolverError> {
    Ok(serde_json::from_value(parse_json(input)?)?)
}

struct StrictValue(Value);

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(StrictValueVisitor)
    }
}

struct StrictValueVisitor;

impl<'de> Visitor<'de> for StrictValueVisitor {
    type Value = StrictValue;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an I-JSON value with unique object member names")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Bool(value)))
    }

    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
        if value.unsigned_abs() > MAX_SAFE_INTEGER {
            return Err(E::custom("integer exceeds the I-JSON safe range"));
        }
        Ok(StrictValue(Value::Number(value.into())))
    }

    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
        if value > MAX_SAFE_INTEGER {
            return Err(E::custom("integer exceeds the I-JSON safe range"));
        }
        Ok(StrictValue(Value::Number(value.into())))
    }

    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
        if !value.is_finite()
            || value.fract() != 0.0
            || value == 0.0 && value.is_sign_negative()
            || value.abs() > MAX_SAFE_INTEGER as f64
        {
            return Err(E::custom(
                "PREX canonical numbers must be safe integers and not negative zero",
            ));
        }
        Ok(StrictValue(Value::Number((value as i64).into())))
    }

    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::String(value.to_owned())))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::String(value)))
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Null))
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(StrictValue(Value::Null))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = sequence.next_element::<StrictValue>()? {
            values.push(value.0);
        }
        Ok(StrictValue(Value::Array(values)))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut keys = BTreeSet::new();
        let mut values = serde_json::Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if !keys.insert(key.clone()) {
                return Err(serde::de::Error::custom(format!(
                    "duplicate object member: {key}"
                )));
            }
            values.insert(key, map.next_value::<StrictValue>()?.0);
        }
        Ok(StrictValue(Value::Object(values)))
    }
}

pub fn canonical_json<T: Serialize>(value: &T) -> Result<Vec<u8>, ResolverError> {
    let value = serde_json::to_value(value)?;
    validate_canonical_value(&value)?;
    let mut output = String::new();
    write_value(&value, &mut output)?;
    Ok(output.into_bytes())
}

fn validate_canonical_value(value: &Value) -> Result<(), ResolverError> {
    match value {
        Value::Number(number) => {
            let safe = number
                .as_i64()
                .is_some_and(|value| value.unsigned_abs() <= MAX_SAFE_INTEGER)
                || number
                    .as_u64()
                    .is_some_and(|value| value <= MAX_SAFE_INTEGER);
            if !safe {
                return Err(ResolverError::Canonical(
                    "numbers must be safe integers and not negative zero".into(),
                ));
            }
        }
        Value::Array(values) => {
            for value in values {
                validate_canonical_value(value)?;
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                validate_canonical_value(value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub fn digest_json<T: Serialize>(value: &T) -> Result<Digest, ResolverError> {
    let bytes = canonical_json(value)?;
    let hash = Sha256::digest(bytes);
    let mut value = String::with_capacity(64);
    for byte in hash {
        use std::fmt::Write as _;
        write!(&mut value, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(Digest {
        algorithm: "sha256".into(),
        value,
    })
}

pub fn digest_projection<T: Serialize>(
    value: &T,
    projection: &str,
) -> Result<Digest, ResolverError> {
    let mut value = serde_json::to_value(value)?;
    let (excluded, ordered): (&[&[&str]], &[&[&str]]) = match projection {
        "request-v1" => (
            &[&["context"]],
            &[
                &["environment", "installed"],
                &["environment", "locked"],
                &["policy", "acceptedAmendmentDigests"],
                &["policy", "requiredEvidence"],
                &["requirements"],
            ],
        ),
        "universe-v1" => (
            &[&["canonicalDigest"]],
            &[
                &["amendments"],
                &["overlays"],
                &["packages"],
                &["recipes"],
                &["sourceSnapshots"],
            ],
        ),
        "solution-v1" => (
            &[&["solutionDigest"]],
            &[
                &["dependencyEdges"],
                &["excludedCandidates"],
                &["satisfiedRequirementIds"],
                &["selectedCapabilityProviders"],
                &["selectedNodeIds"],
                &["semanticLoss"],
                &["sourceSnapshotDigests"],
            ],
        ),
        _ => {
            return Err(ResolverError::Canonical(format!(
                "unknown digest projection: {projection}"
            )));
        }
    };
    for path in excluded {
        if let Some(parent) = object_at_mut(&mut value, &path[..path.len().saturating_sub(1)])
            && let Some(key) = path.last()
        {
            parent.remove(*key);
        }
    }
    for path in ordered {
        let Some(array) = value_at_mut(&mut value, path).and_then(Value::as_array_mut) else {
            continue;
        };
        let mut sortable: Vec<(Vec<u16>, Value)> = std::mem::take(array)
            .into_iter()
            .map(|item| {
                let key = String::from_utf8(canonical_json(&item)?)
                    .map_err(|error| ResolverError::Canonical(error.to_string()))?
                    .encode_utf16()
                    .collect();
                Ok((key, item))
            })
            .collect::<Result<_, ResolverError>>()?;
        sortable.sort_by(|left, right| left.0.cmp(&right.0));
        *array = sortable.into_iter().map(|(_, item)| item).collect();
    }
    digest_json(&value)
}

fn value_at_mut<'a>(value: &'a mut Value, path: &[&str]) -> Option<&'a mut Value> {
    let mut current = value;
    for key in path {
        current = current.as_object_mut()?.get_mut(*key)?;
    }
    Some(current)
}

fn object_at_mut<'a>(
    value: &'a mut Value,
    path: &[&str],
) -> Option<&'a mut serde_json::Map<String, Value>> {
    value_at_mut(value, path)?.as_object_mut()
}

fn write_value(value: &Value, output: &mut String) -> Result<(), ResolverError> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) if value.is_i64() || value.is_u64() => {
            output.push_str(&value.to_string())
        }
        Value::Number(_) => {
            return Err(ResolverError::Canonical(
                "floating-point values are forbidden".into(),
            ));
        }
        Value::String(value) => output.push_str(&serde_json::to_string(value)?),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                write_value(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut keys: Vec<_> = values.keys().collect();
            // RFC 8785 sorts property names by UTF-16 code units, matching
            // ECMAScript rather than Rust's UTF-8/scalar-value ordering.
            keys.sort_unstable_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            for (index, key) in keys.into_iter().enumerate() {
                if index != 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key)?);
                output.push(':');
                write_value(&values[key], output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strict_json_rejects_ambiguous_numbers_and_duplicate_members() {
        assert!(parse_json(r#"{"a":1,"a":2}"#).is_err());
        assert!(parse_json("9007199254740992").is_err());
        assert!(parse_json("-0").is_err());
        assert_eq!(parse_json("1.0").unwrap(), json!(1));
    }

    #[test]
    fn object_names_are_sorted_by_utf16_code_units() {
        let value = json!({"\u{e000}": 1, "\u{10000}": 2});
        assert_eq!(
            String::from_utf8(canonical_json(&value).unwrap()).unwrap(),
            "{\"𐀀\":2,\"\":1}"
        );
    }

    #[test]
    fn named_projections_exclude_self_fields_and_sort_declared_sets() {
        let request = json!({
            "context": {"trace": "ignored"},
            "environment": {"installed": ["b", "a"], "locked": []},
            "policy": {"acceptedAmendmentDigests": [], "requiredEvidence": []},
            "requirements": [{"id": "b"}, {"id": "a"}]
        });
        let reordered = json!({
            "context": {"trace": "different"},
            "environment": {"installed": ["a", "b"], "locked": []},
            "policy": {"acceptedAmendmentDigests": [], "requiredEvidence": []},
            "requirements": [{"id": "a"}, {"id": "b"}]
        });
        assert_eq!(
            digest_projection(&request, "request-v1").unwrap(),
            digest_projection(&reordered, "request-v1").unwrap()
        );

        let universe = json!({"packages": ["b", "a"], "canonicalDigest": "old"});
        let changed = json!({"packages": ["a", "b"], "canonicalDigest": "new"});
        assert_eq!(
            digest_projection(&universe, "universe-v1").unwrap(),
            digest_projection(&changed, "universe-v1").unwrap()
        );

        let solution = json!({"selectedNodeIds": ["b", "a"], "solutionDigest": "old"});
        let changed = json!({"selectedNodeIds": ["a", "b"], "solutionDigest": "new"});
        assert_eq!(
            digest_projection(&solution, "solution-v1").unwrap(),
            digest_projection(&changed, "solution-v1").unwrap()
        );
    }
}

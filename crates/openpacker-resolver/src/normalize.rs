use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::{ResolverError, VersionConstraint};

#[derive(Debug)]
struct Purl {
    kind: String,
    namespace: Option<String>,
    name: String,
    version: Option<String>,
    qualifiers: BTreeMap<String, String>,
    subpath: Option<String>,
}

fn invalid(message: impl Into<String>) -> ResolverError {
    ResolverError::InvalidInput(message.into())
}

fn decode(value: &str) -> Result<String, ResolverError> {
    let input = value.as_bytes();
    let mut output = Vec::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if input[index] == b'%' {
            let pair = input
                .get(index + 1..index + 3)
                .ok_or_else(|| invalid("invalid PURL percent encoding"))?;
            let text = std::str::from_utf8(pair).map_err(|_| invalid("invalid PURL encoding"))?;
            output.push(
                u8::from_str_radix(text, 16)
                    .map_err(|_| invalid("invalid PURL percent encoding"))?,
            );
            index += 3;
        } else {
            output.push(input[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| invalid("PURL component is not UTF-8"))
}

fn encode(value: &str) -> String {
    let mut output = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            output.push(char::from(*byte));
        } else {
            use std::fmt::Write as _;
            write!(&mut output, "%{byte:02X}").expect("writing to String cannot fail");
        }
    }
    output
}

fn parse_purl(value: &str) -> Result<Purl, ResolverError> {
    let body = value
        .strip_prefix("pkg:")
        .ok_or_else(|| invalid("PURL must start with pkg:"))?;
    let (without_subpath, subpath) = body
        .split_once('#')
        .map_or((body, None), |(left, right)| (left, Some(right)));
    let (identity, query) = without_subpath
        .split_once('?')
        .map_or((without_subpath, ""), |(left, right)| (left, right));
    let (kind, path_and_version) = identity
        .split_once('/')
        .ok_or_else(|| invalid("PURL requires a type and name"))?;
    if kind.is_empty() {
        return Err(invalid("PURL type is empty"));
    }
    let (path, version) = path_and_version
        .rsplit_once('@')
        .map_or((path_and_version, None), |(left, right)| {
            (left, (!right.is_empty()).then_some(right))
        });
    let mut segments = path.split('/').map(decode).collect::<Result<Vec<_>, _>>()?;
    if segments.is_empty() || segments.iter().any(String::is_empty) {
        return Err(invalid("PURL path has an empty segment"));
    }
    let name = segments.pop().expect("non-empty PURL path");
    let namespace = (!segments.is_empty()).then(|| segments.join("/"));
    let mut qualifiers = BTreeMap::new();
    for pair in query.split('&').filter(|item| !item.is_empty()) {
        let (key, entry) = pair
            .split_once('=')
            .ok_or_else(|| invalid(format!("invalid PURL qualifier: {pair}")))?;
        if key.is_empty() {
            return Err(invalid("PURL qualifier key is empty"));
        }
        let key = decode(key)?.to_ascii_lowercase();
        if qualifiers.insert(key.clone(), decode(entry)?).is_some() {
            return Err(invalid(format!("duplicate PURL qualifier: {key}")));
        }
    }
    Ok(Purl {
        kind: kind.to_ascii_lowercase(),
        namespace,
        name,
        version: version.map(decode).transpose()?,
        qualifiers,
        subpath: subpath
            .filter(|item| !item.is_empty())
            .map(decode)
            .transpose()?,
    })
}

fn normalize_release(value: &str, nuget: bool) -> Result<String, ResolverError> {
    let value = value.trim();
    let value = if nuget {
        value
    } else {
        value.strip_prefix('v').unwrap_or(value)
    };
    let (without_build, build) = value
        .split_once('+')
        .map_or((value, None), |(left, right)| (left, Some(right)));
    let (release, prerelease) = without_build
        .split_once('-')
        .map_or((without_build, None), |(left, right)| (left, Some(right)));
    let maximum = if nuget { 4 } else { 3 };
    let mut parts = release.split('.').collect::<Vec<_>>();
    if parts.is_empty()
        || parts.len() > maximum
        || parts.iter().any(|part| {
            part.is_empty()
                || !part.bytes().all(|byte| byte.is_ascii_digit())
                || (!nuget && part.len() > 1 && part.starts_with('0'))
        })
    {
        return Err(invalid(format!("invalid native version: {value}")));
    }
    while parts.len() < maximum {
        parts.push("0");
    }
    let numbers = parts
        .iter()
        .map(|part| {
            part.parse::<u64>()
                .map_err(|_| invalid("version component overflow"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let rendered = if nuget && numbers[3] == 0 {
        &numbers[..3]
    } else {
        &numbers[..]
    };
    let mut output = rendered
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(".");
    if let Some(prerelease) = prerelease {
        if prerelease.is_empty()
            || prerelease.split('.').any(|part| {
                part.is_empty()
                    || !part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
        {
            return Err(invalid(format!("invalid native version: {value}")));
        }
        output.push('-');
        output.push_str(&if nuget {
            prerelease.to_ascii_lowercase()
        } else {
            prerelease.to_owned()
        });
    }
    if !nuget {
        if let Some(build) = build {
            if build.is_empty()
                || build.split('.').any(|part| {
                    part.is_empty()
                        || !part
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                })
            {
                return Err(invalid(format!("invalid native version: {value}")));
            }
            output.push('+');
            output.push_str(build);
        }
    }
    Ok(output)
}

/// How a PURL type's version string is normalized. Types whose versions are
/// not semver-shaped keep their native spelling rather than being coerced.
#[derive(Clone, Copy, PartialEq)]
enum VersionPolicy {
    /// Strip a leading `v`, require up to three numeric parts, pad to three.
    Semver,
    /// NuGet's four-part release with no `v` prefix.
    NuGet,
    /// Keep the native version verbatim.
    Preserve,
}

/// Per-type identity rules. Unknown types get the conservative policy: encode
/// canonically, fold nothing, coerce nothing. A type PREX does not know is
/// still normalizable, because normalization is about canonical encoding, not
/// about understanding an ecosystem's naming conventions.
struct PurlPolicy {
    namespace: NamespacePolicy,
    lowercase_name: bool,
    pypi_name: bool,
    version: VersionPolicy,
}

#[derive(PartialEq)]
enum NamespacePolicy {
    /// Namespaces are rejected for this type.
    Forbidden,
    /// Lowercased, with npm's `@` scope prefix preserved.
    NpmScope,
    /// Lowercased.
    Lowercase,
    /// Kept verbatim; the ecosystem's identifiers are case sensitive.
    Preserve,
}

fn purl_policy(kind: &str) -> PurlPolicy {
    match kind {
        "npm" => PurlPolicy {
            namespace: NamespacePolicy::NpmScope,
            lowercase_name: true,
            pypi_name: false,
            version: VersionPolicy::Semver,
        },
        "cargo" => PurlPolicy {
            namespace: NamespacePolicy::Forbidden,
            lowercase_name: true,
            pypi_name: false,
            version: VersionPolicy::Semver,
        },
        "nuget" => PurlPolicy {
            namespace: NamespacePolicy::Forbidden,
            lowercase_name: true,
            pypi_name: false,
            version: VersionPolicy::NuGet,
        },
        "pypi" => PurlPolicy {
            namespace: NamespacePolicy::Forbidden,
            lowercase_name: true,
            pypi_name: true,
            version: VersionPolicy::Preserve,
        },
        "golang" => PurlPolicy {
            namespace: NamespacePolicy::Lowercase,
            lowercase_name: true,
            pypi_name: false,
            version: VersionPolicy::Preserve,
        },
        // Maven coordinates and Nix store names are case sensitive, and both
        // carry versions that are not semver.
        "maven" | "nix" => PurlPolicy {
            namespace: NamespacePolicy::Preserve,
            lowercase_name: false,
            pypi_name: false,
            version: VersionPolicy::Preserve,
        },
        _ => PurlPolicy {
            namespace: NamespacePolicy::Preserve,
            lowercase_name: false,
            pypi_name: false,
            version: VersionPolicy::Preserve,
        },
    }
}

/// PEP 503 name normalization: runs of `-`, `_`, and `.` collapse to `-`.
fn normalize_pypi_name(name: &str) -> String {
    let mut output = String::with_capacity(name.len());
    let mut separator = false;
    for character in name.chars() {
        if matches!(character, '-' | '_' | '.') {
            separator = true;
            continue;
        }
        if separator && !output.is_empty() {
            output.push('-');
        }
        separator = false;
        output.push(character.to_ascii_lowercase());
    }
    output
}

pub fn normalize_purl(value: &str) -> Result<String, ResolverError> {
    let mut purl = parse_purl(value)?;
    let policy = purl_policy(purl.kind.as_str());
    match policy.namespace {
        NamespacePolicy::Forbidden => {
            if purl.namespace.is_some() {
                return Err(invalid(format!(
                    "{} PURLs do not have namespaces",
                    purl.kind
                )));
            }
        }
        NamespacePolicy::NpmScope => {
            purl.namespace = purl.namespace.map(|namespace| {
                format!(
                    "@{}",
                    namespace.trim_start_matches('@').to_ascii_lowercase()
                )
            });
        }
        NamespacePolicy::Lowercase => {
            purl.namespace = purl
                .namespace
                .map(|namespace| namespace.to_ascii_lowercase());
        }
        NamespacePolicy::Preserve => {}
    }
    if policy.pypi_name {
        purl.name = normalize_pypi_name(&purl.name);
    } else if policy.lowercase_name {
        purl.name = purl.name.to_ascii_lowercase();
    }
    if let Some(version) = &purl.version {
        purl.version = match policy.version {
            VersionPolicy::Semver => Some(normalize_release(version, false)?),
            VersionPolicy::NuGet => Some(normalize_release(version, true)?),
            VersionPolicy::Preserve => Some(version.trim().to_owned()),
        };
    }
    let mut path = purl
        .namespace
        .iter()
        .chain(std::iter::once(&purl.name))
        .flat_map(|part| part.split('/'))
        .map(encode)
        .collect::<Vec<_>>()
        .join("/");
    if let Some(version) = purl.version {
        path.push('@');
        path.push_str(&encode(&version));
    }
    if !purl.qualifiers.is_empty() {
        path.push('?');
        path.push_str(
            &purl
                .qualifiers
                .iter()
                .map(|(key, value)| format!("{}={}", encode(key), encode(value)))
                .collect::<Vec<_>>()
                .join("&"),
        );
    }
    if let Some(subpath) = purl.subpath {
        path.push('#');
        path.push_str(
            &subpath
                .split('/')
                .filter(|part| !part.is_empty())
                .map(encode)
                .collect::<Vec<_>>()
                .join("/"),
        );
    }
    Ok(format!("pkg:{}/{path}", purl.kind))
}

fn comparison(clause: &str) -> Result<(Value, String), ResolverError> {
    let clause = clause.trim();
    let (operator, version) = [">=", "<=", "!=", ">", "<", "="]
        .into_iter()
        .find_map(|operator| clause.strip_prefix(operator).map(|value| (operator, value)))
        .ok_or_else(|| invalid(format!("invalid VERS clause: {clause}")))?;
    if version.is_empty()
        || version.len() > 1024
        || version.chars().any(char::is_whitespace)
        || version.contains('|')
    {
        return Err(invalid(format!("invalid VERS clause: {clause}")));
    }
    Ok((
        json!({ "type": "comparison", "operator": operator, "version": version }),
        format!("{operator}{version}"),
    ))
}

pub fn parse_vers(value: &str) -> Result<VersionConstraint, ResolverError> {
    if value.len() > 4096 {
        return Err(invalid("VERS exceeds 4096 bytes"));
    }
    let trimmed = value.trim();
    let (scheme, expression) = trimmed
        .strip_prefix("vers:")
        .and_then(|rest| rest.split_once('/'))
        .ok_or_else(|| invalid("VERS must include a scheme and expression"))?;
    if scheme.is_empty()
        || !scheme.bytes().enumerate().all(|(index, byte)| {
            if index == 0 {
                byte.is_ascii_lowercase()
            } else {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'+' | b'-')
            }
        })
    {
        return Err(invalid("invalid VERS scheme"));
    }
    let (ast, normalized, canonical) = if expression == "*" {
        (json!({ "type": "any" }), "*".to_owned(), "*".to_owned())
    } else {
        let alternatives = expression
            .split("||")
            .map(|alternative| {
                let clauses = alternative
                    .split('|')
                    .map(comparison)
                    .collect::<Result<Vec<_>, _>>()?;
                let ast = if clauses.len() == 1 {
                    clauses[0].0.clone()
                } else {
                    json!({ "type": "and", "items": clauses.iter().map(|item| &item.0).collect::<Vec<_>>() })
                };
                let canonical = clauses
                    .iter()
                    .map(|item| item.1.as_str())
                    .collect::<Vec<_>>()
                    .join("|");
                Ok((ast, canonical.replace('|', " "), canonical))
            })
            .collect::<Result<Vec<_>, ResolverError>>()?;
        let ast = if alternatives.len() == 1 {
            alternatives[0].0.clone()
        } else {
            json!({ "type": "or", "items": alternatives.iter().map(|item| &item.0).collect::<Vec<_>>() })
        };
        (
            ast,
            alternatives
                .iter()
                .map(|item| item.1.as_str())
                .collect::<Vec<_>>()
                .join(" || "),
            alternatives
                .iter()
                .map(|item| item.2.as_str())
                .collect::<Vec<_>>()
                .join("||"),
        )
    };
    Ok(VersionConstraint {
        vers: Some(format!("vers:{scheme}/{canonical}")),
        scheme: scheme.to_owned(),
        original: value.to_owned(),
        normalized,
        ast,
        reversible: true,
        semantic_loss: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn purl_and_vers_normalization_are_idempotent() {
        let purl = normalize_purl("pkg:NPM/%40Scope/Demo@v1.0?B=two&a=one").unwrap();
        assert_eq!(purl, "pkg:npm/%40scope/demo@1.0.0?a=one&b=two");
        assert_eq!(normalize_purl(&purl).unwrap(), purl);
        let vers = parse_vers(" vers:npm/>=1.0 | <2 || =3 ").unwrap();
        assert_eq!(vers.vers.as_deref(), Some("vers:npm/>=1.0|<2||=3"));
        assert_eq!(
            parse_vers(vers.vers.as_deref().unwrap()).unwrap().vers,
            vers.vers
        );
    }
}

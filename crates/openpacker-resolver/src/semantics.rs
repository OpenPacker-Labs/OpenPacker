use std::cmp::Ordering;

use serde_json::Value;

use crate::{TargetContext, TargetPredicate, VersionConstraint};

/// The build, host, and target platforms a predicate may address, plus the
/// platform an unprefixed path resolves against.
///
/// A single-platform solve builds a view whose three platforms are the same
/// context, so `build.`, `host.`, and `target.` prefixes are accepted and
/// answer identically. Cross-compilation supplies distinct contexts.
#[derive(Clone, Copy)]
pub struct PlatformView<'a> {
    build: &'a TargetContext,
    host: &'a TargetContext,
    target: &'a TargetContext,
    default: &'a TargetContext,
}

impl<'a> PlatformView<'a> {
    /// One context answering for every platform.
    pub fn uniform(context: &'a TargetContext) -> Self {
        Self {
            build: context,
            host: context,
            target: context,
            default: context,
        }
    }

    pub fn new(
        build: &'a TargetContext,
        host: &'a TargetContext,
        target: &'a TargetContext,
    ) -> Self {
        Self {
            build,
            host,
            target,
            default: host,
        }
    }

    /// The same platforms, but unprefixed paths resolve against the build
    /// platform. Used for requirements whose kind is consumed while building.
    #[must_use]
    pub fn defaulting_to_build(self) -> Self {
        Self {
            default: self.build,
            ..self
        }
    }

    pub fn host(&self) -> &'a TargetContext {
        self.host
    }

    fn resolve(&self, path: &'a str) -> (&'a TargetContext, &'a str) {
        // No unprefixed target path begins with 'b', 'h', or 't', so this one
        // byte check skips prefix matching for every ordinary lookup.
        if matches!(path.as_bytes().first(), Some(b'b' | b'h' | b't')) {
            for (prefix, context) in [
                ("build.", self.build),
                ("host.", self.host),
                ("target.", self.target),
            ] {
                if let Some(rest) = path.strip_prefix(prefix) {
                    return (context, rest);
                }
            }
        }
        (self.default, path)
    }

    pub fn scalar(&self, path: &'a str) -> Option<Value> {
        let (context, rest) = self.resolve(path);
        target_scalar(context, rest)
    }
}

/// The platforms a solve addresses. Without `platforms`, every platform is the
/// request target, so a single-platform solve is unchanged.
pub fn request_platforms(request: &crate::SolveRequest) -> PlatformView<'_> {
    let host = request
        .platforms
        .as_ref()
        .and_then(|platforms| platforms.host.as_ref())
        .unwrap_or(&request.target);
    let build = request
        .platforms
        .as_ref()
        .and_then(|platforms| platforms.build.as_ref())
        .unwrap_or(host);
    let target = request
        .platforms
        .as_ref()
        .and_then(|platforms| platforms.target.as_ref())
        .unwrap_or(host);
    PlatformView::new(build, host, target)
}

/// The platforms a single requirement is resolved against. Build-consumed
/// kinds resolve unprefixed paths against the build platform; every other kind
/// resolves against the host.
pub fn requirement_platforms<'a>(
    request: &'a crate::SolveRequest,
    kind: Option<&str>,
) -> PlatformView<'a> {
    RequirementPlatforms::new(request).select(request, kind)
}

/// Platform views for a whole solve, computed once. The hot paths iterate
/// thousands of requirements, so rebuilding the view per requirement is
/// measurable; selecting between two precomputed views is not.
#[derive(Clone, Copy)]
pub struct RequirementPlatforms<'a> {
    host_default: PlatformView<'a>,
    build_default: PlatformView<'a>,
}

impl<'a> RequirementPlatforms<'a> {
    pub fn new(request: &'a crate::SolveRequest) -> Self {
        let host_default = request_platforms(request);
        Self {
            host_default,
            build_default: host_default.defaulting_to_build(),
        }
    }

    pub fn select(&self, request: &crate::SolveRequest, kind: Option<&str>) -> PlatformView<'a> {
        let build_consumed = request.requirement_kind_policy.as_ref().map_or_else(
            || kind.is_some_and(|kind| crate::DEFAULT_BUILD_PLATFORM_KINDS.contains(&kind)),
            |policy| policy.is_build_platform(kind),
        );
        if build_consumed {
            self.build_default
        } else {
            self.host_default
        }
    }

    pub fn host_default(&self) -> PlatformView<'a> {
        self.host_default
    }
}

/// Whether a requirement of this kind participates in the solve at all.
pub fn requirement_is_active(request: &crate::SolveRequest, kind: Option<&str>) -> bool {
    request
        .requirement_kind_policy
        .as_ref()
        .is_none_or(|policy| !policy.is_inactive(kind))
}

pub fn evaluate_target_predicate(predicate: &TargetPredicate, target: &TargetContext) -> bool {
    evaluate_target_predicate_in(predicate, PlatformView::uniform(target))
}

pub fn evaluate_target_predicate_in(predicate: &TargetPredicate, platforms: PlatformView) -> bool {
    match predicate {
        TargetPredicate::True => true,
        TargetPredicate::False => false,
        TargetPredicate::Equals { path, value } => platforms.scalar(path).as_ref() == Some(value),
        TargetPredicate::NotEquals { path, value } => {
            platforms.scalar(path).as_ref() != Some(value)
        }
        TargetPredicate::In { path, values } => {
            platforms.scalar(path).is_some_and(|v| values.contains(&v))
        }
        TargetPredicate::NotIn { path, values } => {
            platforms.scalar(path).is_none_or(|v| !values.contains(&v))
        }
        TargetPredicate::VersionSatisfies { path, constraint } => platforms
            .scalar(path)
            .and_then(|value| value.as_str().map(str::to_owned))
            .is_some_and(|version| version_constraint_satisfies(&version, constraint)),
        TargetPredicate::CapabilityPresent { name, constraint } => {
            platforms.host().capabilities.iter().any(|capability| {
                capability.name == *name
                    && constraint.as_ref().is_none_or(|constraint| {
                        capability.version.as_deref().is_some_and(|version| {
                            version_constraint_satisfies(version, constraint)
                        })
                    })
            })
        }
        TargetPredicate::AllOf { predicates } => predicates
            .iter()
            .all(|predicate| evaluate_target_predicate_in(predicate, platforms)),
        TargetPredicate::AnyOf { predicates } => predicates
            .iter()
            .any(|predicate| evaluate_target_predicate_in(predicate, platforms)),
        TargetPredicate::Not { predicate } => !evaluate_target_predicate_in(predicate, platforms),
    }
}

pub fn version_satisfies(version: &str, vers: &str) -> bool {
    let (scheme, expression) = vers
        .strip_prefix("vers:")
        .and_then(|value| value.split_once('/'))
        .unwrap_or(("generic", vers));
    if expression.trim().is_empty() {
        return false;
    }
    let mut alternatives = expression.split("||");
    if alternatives
        .clone()
        .any(|alternative| alternative.trim().is_empty())
    {
        return false;
    }
    alternatives.any(|alternative| {
        let clauses = alternative.split('|').collect::<Vec<_>>();
        !clauses.is_empty()
            && clauses.iter().all(|clause| {
                let clause = clause.trim();
                !clause.is_empty() && compare_clause(version, clause, scheme)
            })
    })
}

fn version_constraint_satisfies(version: &str, constraint: &VersionConstraint) -> bool {
    constraint.vers.as_deref().map_or_else(
        || version_satisfies(version, &constraint.normalized),
        |vers| version_satisfies(version, vers),
    )
}

pub(crate) fn target_scalar(target: &TargetContext, path: &str) -> Option<Value> {
    match path {
        "os" => target.os.clone().map(Value::String),
        "architecture" => target.architecture.clone().map(Value::String),
        "libc" => target.libc.clone().map(Value::String),
        "kernel" => target.kernel.clone().map(Value::String),
        path if path.starts_with("runtimes.") => {
            target.runtimes.get(&path[9..]).cloned().map(Value::String)
        }
        path if path.starts_with("abi.") => target.abi.get(&path[4..]).cloned().map(Value::String),
        path if path.starts_with("variables.") => target.variables.get(&path[10..]).cloned(),
        _ => None,
    }
}

fn compare_clause(version: &str, clause: &str, scheme: &str) -> bool {
    if clause.is_empty() || clause == "*" {
        return true;
    }
    let (operator, expected) = [">=", "<=", "!=", ">", "<", "="]
        .into_iter()
        .find_map(|operator| {
            clause
                .strip_prefix(operator)
                .map(|expected| (operator, expected))
        })
        .unwrap_or(("=", clause));
    let Some(ordering) = compare_versions(version, expected, scheme) else {
        return false;
    };
    match operator {
        "=" => ordering == Ordering::Equal,
        "!=" => ordering != Ordering::Equal,
        ">" => ordering == Ordering::Greater,
        ">=" => ordering != Ordering::Less,
        "<" => ordering == Ordering::Less,
        "<=" => ordering != Ordering::Greater,
        _ => false,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ParsedVersion {
    release: Vec<u64>,
    prerelease: Vec<PrereleaseIdentifier>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum PrereleaseIdentifier {
    Numeric(u64),
    Text(String),
}

fn parse_version(value: &str, scheme: &str) -> Option<ParsedVersion> {
    let nuget = scheme == "nuget";
    let (without_build, build) = value
        .split_once('+')
        .map_or((value, None), |(release, build)| (release, Some(build)));
    if build.is_some_and(|build| {
        build.is_empty()
            || build.split('.').any(|part| {
                part.is_empty()
                    || !part
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
    }) {
        return None;
    }
    let (release, prerelease) = without_build
        .split_once('-')
        .map_or((without_build, None), |(release, prerelease)| {
            (release, Some(prerelease))
        });
    let mut release = release
        .split('.')
        .map(|part| {
            (!part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
                .then(|| part.parse::<u64>().ok())
                .flatten()
        })
        .collect::<Option<Vec<_>>>()?;
    let maximum = if nuget { 4 } else { 3 };
    if release.is_empty() || release.len() > maximum {
        return None;
    }
    while release.len() < maximum {
        release.push(0);
    }
    let prerelease = match prerelease {
        Some(value) => {
            if value.is_empty() {
                return None;
            }
            value
                .split('.')
                .map(|part| {
                    if part.is_empty()
                        || !part
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                    {
                        return None;
                    }
                    if part.bytes().all(|byte| byte.is_ascii_digit()) {
                        if !nuget && part.len() > 1 && part.starts_with('0') {
                            return None;
                        }
                        part.parse().ok().map(PrereleaseIdentifier::Numeric)
                    } else {
                        Some(PrereleaseIdentifier::Text(if nuget {
                            part.to_ascii_lowercase()
                        } else {
                            part.to_owned()
                        }))
                    }
                })
                .collect::<Option<Vec<_>>>()?
        }
        None => Vec::new(),
    };
    Some(ParsedVersion {
        release,
        prerelease,
    })
}

fn compare_versions(left: &str, right: &str, scheme: &str) -> Option<Ordering> {
    let left = parse_version(left, scheme)?;
    let right = parse_version(right, scheme)?;
    let release = left.release.cmp(&right.release);
    if release != Ordering::Equal {
        return Some(release);
    }
    match (left.prerelease.is_empty(), right.prerelease.is_empty()) {
        (true, true) => Some(Ordering::Equal),
        (true, false) => Some(Ordering::Greater),
        (false, true) => Some(Ordering::Less),
        (false, false) => Some(compare_prerelease(&left.prerelease, &right.prerelease)),
    }
}

fn compare_prerelease(left: &[PrereleaseIdentifier], right: &[PrereleaseIdentifier]) -> Ordering {
    for (left, right) in left.iter().zip(right) {
        let ordering = match (left, right) {
            (PrereleaseIdentifier::Numeric(left), PrereleaseIdentifier::Numeric(right)) => {
                left.cmp(right)
            }
            (PrereleaseIdentifier::Numeric(_), PrereleaseIdentifier::Text(_)) => Ordering::Less,
            (PrereleaseIdentifier::Text(_), PrereleaseIdentifier::Numeric(_)) => Ordering::Greater,
            (PrereleaseIdentifier::Text(left), PrereleaseIdentifier::Text(right)) => {
                left.cmp(right)
            }
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    left.len().cmp(&right.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vers_conjunction_and_alternatives() {
        assert!(version_satisfies("1.5.0", "vers:npm/>=1.0.0|<2.0.0"));
        assert!(!version_satisfies("2.0.0", "vers:npm/>=1.0.0|<2.0.0"));
        assert!(version_satisfies("3.0.0", "vers:npm/<2.0.0||>=3.0.0"));
        assert!(version_satisfies("1.0.0-alpha", "vers:npm/<1.0.0"));
        assert!(version_satisfies(
            "1.0.0+build.1",
            "vers:npm/=1.0.0+build.2"
        ));
        assert!(version_satisfies("1.0.0-RC.1", "vers:nuget/=1.0.0-rc.1"));
        assert!(!version_satisfies("1.0.0-01", "vers:npm/<2.0.0"));
        for invalid in ["", "vers:npm/", "vers:npm/||>=1", "vers:npm/>=1||"] {
            assert!(!version_satisfies("1.0.0", invalid), "{invalid}");
        }
    }
}

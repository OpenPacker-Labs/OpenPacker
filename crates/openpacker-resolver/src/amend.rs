//! Amendment compilation.
//!
//! An amendment supersedes how a package's requirements are interpreted. It
//! never edits a native fact: the amended universe is a derived value, the
//! original is left intact, and every change records semantic loss naming the
//! authority that made it.

use serde_json::{Value, json};

use crate::{
    Digest, RequirementExpression, ResolverError, SolveInput, UniverseAmendment, digest_json,
    digest_projection,
};

/// One applied operation, kept so the proof and explanation can name it.
#[derive(Clone, Debug, PartialEq)]
pub struct AppliedAmendment {
    pub digest: Digest,
    pub authority: String,
    pub subject_node_id: String,
    pub operations: Vec<String>,
}

/// The universe a solve actually runs against, plus what produced it.
pub struct AmendedInput {
    pub input: SolveInput,
    pub applied: Vec<AppliedAmendment>,
}

fn loss(authority: &str, requirement_id: &str, operation: &str) -> Value {
    json!({
        "code": "NATIVE_FACT_SUPERSEDED",
        "severity": "warning",
        "sourceEcosystem": "prex",
        "sourcePath": format!("/requirements/{requirement_id}"),
        "originalMeaning": format!(
            "the package declared requirement {requirement_id} as a native fact"
        ),
        "representedMeaning": format!(
            "{operation} applied by an amendment from authority {authority}"
        ),
        "blocksProfile": ["native-validated-v1"],
    })
}

/// Rewrite every package expression matching `from` into `to`, recursively.
fn redirect(
    expression: &RequirementExpression,
    from: &RequirementExpression,
    to: &RequirementExpression,
) -> RequirementExpression {
    if expressions_match(expression, from) {
        return to.clone();
    }
    match expression {
        RequirementExpression::AllOf { expressions } => RequirementExpression::AllOf {
            expressions: expressions
                .iter()
                .map(|item| redirect(item, from, to))
                .collect(),
        },
        RequirementExpression::AnyOf { expressions } => RequirementExpression::AnyOf {
            expressions: expressions
                .iter()
                .map(|item| redirect(item, from, to))
                .collect(),
        },
        RequirementExpression::Not { expression } => RequirementExpression::Not {
            expression: Box::new(redirect(expression, from, to)),
        },
        RequirementExpression::Conditional {
            when,
            then,
            otherwise,
        } => RequirementExpression::Conditional {
            when: when.clone(),
            then: Box::new(redirect(then, from, to)),
            otherwise: otherwise
                .as_ref()
                .map(|item| Box::new(redirect(item, from, to))),
        },
        other => other.clone(),
    }
}

/// A redirect matches on package identity and, when the amendment states one,
/// on the version range. It never matches a capability expression.
fn expressions_match(candidate: &RequirementExpression, pattern: &RequirementExpression) -> bool {
    match (candidate, pattern) {
        (
            RequirementExpression::Package {
                purl: candidate_purl,
                vers: candidate_vers,
                qualifiers: candidate_qualifiers,
            },
            RequirementExpression::Package {
                purl: pattern_purl,
                vers: pattern_vers,
                qualifiers: pattern_qualifiers,
            },
        ) => {
            candidate_purl == pattern_purl
                && pattern_vers
                    .as_ref()
                    .is_none_or(|vers| candidate_vers.as_ref() == Some(vers))
                && pattern_qualifiers
                    .iter()
                    .all(|(key, value)| candidate_qualifiers.get(key) == Some(value))
        }
        _ => false,
    }
}

fn operation_field<'a>(operation: &'a Value, field: &str) -> Result<&'a str, ResolverError> {
    operation
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| ResolverError::InvalidInput(format!("amendment operation needs {field}")))
}

fn parse_expression(value: &Value) -> Result<RequirementExpression, ResolverError> {
    serde_json::from_value(value.clone()).map_err(|error| {
        ResolverError::InvalidInput(format!("amendment expression is invalid: {error}"))
    })
}

/// Apply every admitted amendment, returning the amended input. Amendments are
/// applied in canonical digest order so the result never depends on the order
/// a universe happened to list them.
pub fn apply_amendments(input: &SolveInput) -> Result<AmendedInput, ResolverError> {
    let (admitted, _ignored) = crate::engine::partition_amendments(input);
    if admitted.is_empty() {
        return Ok(AmendedInput {
            input: input.clone(),
            applied: Vec::new(),
        });
    }

    let mut amendments: Vec<(Digest, &UniverseAmendment)> = admitted
        .into_iter()
        .map(|index| {
            let amendment = &input.universe.amendments[index];
            digest_json(amendment).map(|digest| (digest, amendment))
        })
        .collect::<Result<_, _>>()?;
    amendments.sort_by(|left, right| left.0.value.cmp(&right.0.value));

    let mut amended = input.clone();
    let mut applied = Vec::new();
    for (digest, amendment) in amendments {
        let target = amended
            .universe
            .packages
            .iter_mut()
            .find(|package| {
                package.metadata_digest == amendment.applies_to_metadata_digest
                    && serde_json::from_value::<crate::PackageIdentity>(amendment.subject.clone())
                        .is_ok_and(|subject| subject == package.identity)
            })
            .ok_or_else(|| {
                ResolverError::InvalidInput(
                    "amendment subject and appliesToMetadataDigest do not match a universe package"
                        .into(),
                )
            })?;
        let mut operations = Vec::new();
        for operation in &amendment.operations {
            match operation_field(operation, "op")? {
                "supersedeRequirement" => {
                    let id = operation_field(operation, "requirementId")?.to_owned();
                    let replacement = operation.get("replacement").ok_or_else(|| {
                        ResolverError::InvalidInput(
                            "supersedeRequirement needs a replacement".into(),
                        )
                    })?;
                    let replacement: crate::Requirement =
                        serde_json::from_value(replacement.clone()).map_err(|error| {
                            ResolverError::InvalidInput(format!(
                                "amendment replacement is invalid: {error}"
                            ))
                        })?;
                    if replacement.id != id {
                        return Err(ResolverError::InvalidInput(
                            "supersedeRequirement replacement must keep the requirement id".into(),
                        ));
                    }
                    let slot = target
                        .requirements
                        .iter_mut()
                        .find(|requirement| requirement.id == id)
                        .ok_or_else(|| {
                            ResolverError::InvalidInput(format!(
                                "amendment supersedes unknown requirement {id}"
                            ))
                        })?;
                    *slot = replacement;
                    slot.semantic_loss.push(loss(
                        &amendment.authority,
                        &id,
                        "supersedeRequirement",
                    ));
                    operations.push(format!("supersedeRequirement:{id}"));
                }
                "retractRequirement" => {
                    let id = operation_field(operation, "requirementId")?.to_owned();
                    operation_field(operation, "justification")?;
                    let before = target.requirements.len();
                    target
                        .requirements
                        .retain(|requirement| requirement.id != id);
                    if target.requirements.len() == before {
                        return Err(ResolverError::InvalidInput(format!(
                            "amendment retracts unknown requirement {id}"
                        )));
                    }
                    target.semantic_loss.push(loss(
                        &amendment.authority,
                        &id,
                        "retractRequirement",
                    ));
                    operations.push(format!("retractRequirement:{id}"));
                }
                "redirectPackage" => {
                    let from = parse_expression(operation.get("match").ok_or_else(|| {
                        ResolverError::InvalidInput("redirectPackage needs match".into())
                    })?)?;
                    let to = parse_expression(operation.get("to").ok_or_else(|| {
                        ResolverError::InvalidInput("redirectPackage needs to".into())
                    })?)?;
                    let mut redirected = 0usize;
                    for requirement in &mut target.requirements {
                        let rewritten = redirect(&requirement.expression, &from, &to);
                        if rewritten != requirement.expression {
                            requirement.expression = rewritten;
                            requirement.semantic_loss.push(loss(
                                &amendment.authority,
                                &requirement.id,
                                "redirectPackage",
                            ));
                            redirected += 1;
                        }
                    }
                    if redirected == 0 {
                        return Err(ResolverError::InvalidInput(
                            "amendment redirect matched no requirement".into(),
                        ));
                    }
                    operations.push(format!("redirectPackage:{redirected}"));
                }
                unknown => {
                    return Err(ResolverError::InvalidInput(format!(
                        "unsupported amendment operation: {unknown}"
                    )));
                }
            }
        }
        applied.push(AppliedAmendment {
            digest,
            authority: amendment.authority.clone(),
            subject_node_id: target.node_id.clone(),
            operations,
        });
    }

    // The amended universe is a different universe; its digest must say so.
    amended.universe.canonical_digest = universe_digest(&amended.universe)?;
    Ok(AmendedInput {
        input: amended,
        applied,
    })
}

/// The `universe-v1` digest of a universe.
///
/// The value is derived from the struct itself rather than a hand-listed set
/// of fields: a mirror would silently produce a wrong digest the first time a
/// field is added and the copy is not updated.
fn universe_digest(universe: &crate::ResolutionUniverse) -> Result<Digest, ResolverError> {
    digest_projection(universe, "universe-v1")
}

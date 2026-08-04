use std::collections::BTreeSet;

use serde_json::{Value, json};

use crate::semantics::{
    PlatformView, RequirementPlatforms, request_platforms, requirement_is_active,
    requirement_platforms,
};
use crate::{
    Digest, PackageInstance, ProofCheckResult, RequirementExpression, ResolverError, SolveInput,
    SolveOutput, TargetPredicate, brute_force_oracle, digest_json,
    engine::{
        MAX_COMPANION_NODES, build_native_output, build_output, captured_indices,
        objectives_require_optimization, validate_solve_request,
    },
    parse_json_as, validate_universe, version_satisfies,
};

pub fn check(input: &SolveInput, output: &SolveOutput) -> Result<ProofCheckResult, ResolverError> {
    validate_universe(&input.universe)?;
    validate_solve_request(input)?;
    // The checker re-derives the amended universe from the original inputs
    // rather than trusting the solver's, so a forged amendment application
    // cannot pass: the digests it recomputes would not match.
    let amended = crate::amend::apply_amendments(input)?;
    if !amended.applied.is_empty() {
        let expected: Vec<_> = amended
            .applied
            .iter()
            .map(|item| item.digest.clone())
            .collect();
        let mut claimed = output.proof.applied_amendment_digests.clone();
        claimed.sort_by(|left, right| left.value.cmp(&right.value));
        let mut expected_sorted = expected.clone();
        expected_sorted.sort_by(|left, right| left.value.cmp(&right.value));
        if claimed != expected_sorted {
            return Ok(ProofCheckResult {
                valid: false,
                diagnostics: vec![
                    "proof appliedAmendmentDigests do not match the admitted amendments".into(),
                ],
            });
        }
        let mut nested = check_amended(&amended.input, output)?;
        if !output
            .explanation
            .nodes
            .iter()
            .any(|node| node.kind == "amendment-applied")
        {
            nested
                .diagnostics
                .push("explanation omits applied amendments".into());
            nested.valid = false;
        }
        return Ok(nested);
    }
    if !output.proof.applied_amendment_digests.is_empty() {
        return Ok(ProofCheckResult {
            valid: false,
            diagnostics: vec!["proof claims applied amendments but policy admitted none".into()],
        });
    }
    check_amended(input, output)
}

pub(crate) fn check_amended(
    input: &SolveInput,
    output: &SolveOutput,
) -> Result<ProofCheckResult, ResolverError> {
    let mut diagnostics = Vec::new();
    if output.normalized_request != input.request {
        diagnostics.push("normalizedRequest differs from checked request".into());
    }
    if output.request_digest != digest_json(&input.request)? {
        diagnostics.push("requestDigest mismatch".into());
    }
    if output.universe_digest != digest_json(&input.universe)? {
        diagnostics.push("universeDigest mismatch".into());
    }
    if output.proof.request_digest != output.request_digest {
        diagnostics.push("proof requestDigest mismatch".into());
    }
    if output.proof.universe_digest != output.universe_digest {
        diagnostics.push("proof universeDigest mismatch".into());
    }

    let selected_ids: BTreeSet<_> = output.solution.selected_node_ids.iter().cloned().collect();
    if selected_ids.len() != output.solution.selected_node_ids.len() {
        diagnostics.push("selectedNodeIds contains duplicates".into());
    }
    let selected_indices = selected_indices(input, &selected_ids, &mut diagnostics);
    let output_ids: BTreeSet<_> = output
        .selected
        .iter()
        .map(|package| package.node_id.clone())
        .collect();
    if output_ids != selected_ids {
        diagnostics.push("selected package objects do not match selectedNodeIds".into());
    }
    if output.selected.len() != output_ids.len() {
        diagnostics.push("selected package objects contain duplicate nodeIds".into());
    }

    for assignment in &output.proof.selected_assignments {
        match input
            .universe
            .packages
            .iter()
            .find(|package| package.node_id == assignment.node_id)
        {
            Some(package) => {
                if assignment.node_digest != digest_json(package)? {
                    diagnostics.push(format!("nodeDigest mismatch for {}", assignment.node_id));
                }
                if assignment.selected != selected_ids.contains(&assignment.node_id) {
                    diagnostics.push(format!(
                        "selected assignment mismatch for {}",
                        assignment.node_id
                    ));
                }
            }
            None => diagnostics.push(format!(
                "proof references unknown node {}",
                assignment.node_id
            )),
        }
    }
    if output.proof.selected_assignments.len() != input.universe.packages.len() {
        diagnostics.push("proof does not assign every universe node".into());
    }

    let profile = input.request.semantics.profile.as_str();
    if matches!(profile, "native-capture-v1" | "native-validated-v1") {
        let captured = captured_indices(input)?;
        if selected_indices != captured {
            diagnostics.push("selected assignment differs from captured native result".into());
        }
        if profile == "native-validated-v1"
            && !independent_valid_selection(input, &selected_indices, &mut diagnostics)
        {
            diagnostics.push("selected assignment violates represented PREX constraints".into());
        }
        verify_solution_digest(output, &mut diagnostics)?;
        let expected = build_native_output(input, &captured, profile == "native-validated-v1")?;
        compare_expected(output, &expected, &mut diagnostics);
        return Ok(ProofCheckResult {
            valid: diagnostics.is_empty(),
            diagnostics,
        });
    }

    if !independent_valid_selection(input, &selected_indices, &mut diagnostics) {
        diagnostics.push("selected assignment violates PREX constraints".into());
    }
    let expected_objectives = independent_objectives(input, &selected_indices);
    if output.solution.objective_tuple != expected_objectives {
        diagnostics.push("objectiveTuple mismatch".into());
    }
    if objectives_require_optimization(&input.request) {
        if input.universe.packages.len() > MAX_COMPANION_NODES {
            diagnostics.push(format!(
                "objective optimality is not independently provable above {MAX_COMPANION_NODES} nodes"
            ));
        } else {
            match brute_force_oracle(input) {
                Ok(oracle) if oracle.selected_node_ids != output.solution.selected_node_ids => {
                    diagnostics.push("selected assignment is not the bounded optimum".into());
                }
                Err(error) => diagnostics.push(format!("bounded optimum check failed: {error}")),
                _ => {}
            }
        }
    }

    verify_solution_digest(output, &mut diagnostics)?;
    for witness in &output.proof.requirement_witnesses {
        let requirement = input
            .request
            .requirements
            .iter()
            .chain(
                selected_indices
                    .iter()
                    .flat_map(|index| input.universe.packages[*index].requirements.iter()),
            )
            .find(|requirement| requirement.id == witness.requirement_id);
        match requirement {
            Some(requirement)
                if !requirement_is_active(&input.request, Some(requirement.kind.as_str())) =>
            {
                diagnostics.push(format!(
                    "proof witnesses inactive requirement {}",
                    witness.requirement_id
                ));
            }
            Some(requirement) => {
                let actual = expression_witness(
                    &requirement.expression,
                    input,
                    &selected_ids,
                    requirement_platforms(&input.request, Some(requirement.kind.as_str())),
                );
                let expected_status = if actual.is_none() && requirement.optional {
                    "optional-omitted"
                } else if actual.is_some() {
                    "satisfied"
                } else {
                    "invalid"
                };
                if witness.status != expected_status {
                    diagnostics.push(format!(
                        "requirement witness status mismatch for {}",
                        witness.requirement_id
                    ));
                }
                if actual
                    .unwrap_or_default()
                    .into_iter()
                    .any(|id| !witness.witness_node_ids.contains(&id))
                {
                    diagnostics.push(format!(
                        "requirement witness nodes incomplete for {}",
                        witness.requirement_id
                    ));
                }
            }
            None => diagnostics.push(format!(
                "proof references unknown requirement {}",
                witness.requirement_id
            )),
        }
    }
    if diagnostics.is_empty() {
        let expected = build_output(input, &selected_indices)?;
        if output.selected != expected.selected {
            diagnostics.push("selected package objects differ from the universe".into());
        }
        if output.solution != expected.solution {
            diagnostics.push("solution fields are incomplete or inconsistent".into());
        }
        if output.proof.selected_assignments != expected.proof.selected_assignments {
            diagnostics.push("selectedAssignments are incomplete or inconsistent".into());
        }
        if output.proof.requirement_witnesses != expected.proof.requirement_witnesses {
            diagnostics.push("requirementWitnesses are incomplete or inconsistent".into());
        }
        if output.proof.conflict_checks != expected.proof.conflict_checks {
            diagnostics.push("conflictChecks are incomplete or inconsistent".into());
        }
        if output.proof.cardinality_checks != expected.proof.cardinality_checks {
            diagnostics.push("cardinalityChecks are incomplete or inconsistent".into());
        }
        if output.proof.target_checks != expected.proof.target_checks {
            diagnostics.push("targetChecks are incomplete or inconsistent".into());
        }
        if output.proof.objective_evidence != expected.proof.objective_evidence {
            diagnostics.push("objectiveEvidence is incomplete or inconsistent".into());
        }
        if output.explanation != expected.explanation {
            diagnostics.push("explanation graph is incomplete or inconsistent".into());
        }
    }
    Ok(ProofCheckResult {
        valid: diagnostics.is_empty(),
        diagnostics,
    })
}

fn verify_solution_digest(
    output: &SolveOutput,
    diagnostics: &mut Vec<String>,
) -> Result<(), ResolverError> {
    let mut unsigned = output.solution.clone();
    unsigned.solution_digest = zero_digest();
    if output.solution.solution_digest != digest_json(&unsigned)? {
        diagnostics.push("solutionDigest mismatch".into());
    }
    Ok(())
}

fn compare_expected(output: &SolveOutput, expected: &SolveOutput, diagnostics: &mut Vec<String>) {
    if output.selected != expected.selected {
        diagnostics.push("selected package objects differ from the universe".into());
    }
    if output.solution != expected.solution {
        diagnostics.push("solution fields are incomplete or inconsistent".into());
    }
    if output.proof.selected_assignments != expected.proof.selected_assignments {
        diagnostics.push("selectedAssignments are incomplete or inconsistent".into());
    }
    if output.proof.requirement_witnesses != expected.proof.requirement_witnesses {
        diagnostics.push("requirementWitnesses are incomplete or inconsistent".into());
    }
    if output.proof.conflict_checks != expected.proof.conflict_checks {
        diagnostics.push("conflictChecks are incomplete or inconsistent".into());
    }
    if output.proof.cardinality_checks != expected.proof.cardinality_checks {
        diagnostics.push("cardinalityChecks are incomplete or inconsistent".into());
    }
    if output.proof.target_checks != expected.proof.target_checks {
        diagnostics.push("targetChecks are incomplete or inconsistent".into());
    }
    if output.proof.objective_evidence != expected.proof.objective_evidence {
        diagnostics.push("objectiveEvidence is incomplete or inconsistent".into());
    }
    if output.explanation != expected.explanation {
        diagnostics.push("explanation graph is incomplete or inconsistent".into());
    }
}

pub fn check_json(input: &str, output: &str) -> Result<String, ResolverError> {
    Ok(serde_json::to_string(&check(
        &parse_json_as(input)?,
        &parse_json_as(output)?,
    )?)?)
}

pub(crate) fn independent_valid_selection(
    input: &SolveInput,
    selected: &[usize],
    diagnostics: &mut Vec<String>,
) -> bool {
    let selected_ids: BTreeSet<_> = selected
        .iter()
        .map(|index| input.universe.packages[*index].node_id.clone())
        .collect();
    let mut valid = true;
    for index in selected {
        let package = &input.universe.packages[*index];
        if !lifecycle_allowed(package, input) {
            diagnostics.push(format!("lifecycle denied {}", package.node_id));
            valid = false;
        }
    }
    let platforms = RequirementPlatforms::new(&input.request);
    let host_platforms = platforms.host_default();
    for requirement in &input.request.requirements {
        if !requirement.optional
            && requirement_is_active(&input.request, Some(requirement.kind.as_str()))
            && expression_witness(
                &requirement.expression,
                input,
                &selected_ids,
                platforms.select(&input.request, Some(requirement.kind.as_str())),
            )
            .is_none()
        {
            diagnostics.push(format!(
                "root requirement {} is unsatisfied",
                requirement.id
            ));
            valid = false;
        }
    }
    for index in selected {
        let package = &input.universe.packages[*index];
        for requirement in &package.requirements {
            if !requirement.optional
                && requirement_is_active(&input.request, Some(requirement.kind.as_str()))
                && expression_witness(
                    &requirement.expression,
                    input,
                    &selected_ids,
                    platforms.select(&input.request, Some(requirement.kind.as_str())),
                )
                .is_none()
            {
                diagnostics.push(format!("requirement {} is unsatisfied", requirement.id));
                valid = false;
            }
        }
        for conflict in &package.conflicts {
            if expression_witness(&conflict.expression, input, &selected_ids, host_platforms)
                .is_some()
            {
                diagnostics.push(format!("conflict {} is violated", conflict.id));
                valid = false;
            }
        }
        for constraint in &package.cardinality_constraints {
            let count = selected_ids
                .iter()
                .filter(|node_id| {
                    expression_witness(
                        &constraint.selector,
                        input,
                        &BTreeSet::from([(*node_id).clone()]),
                        host_platforms,
                    )
                    .is_some()
                })
                .count();
            if count < constraint.minimum || count > constraint.maximum {
                diagnostics.push(format!(
                    "cardinality {} expected {}..={}, got {}",
                    constraint.id, constraint.minimum, constraint.maximum, count
                ));
                valid = false;
            }
        }
    }
    valid
}

fn expression_witness(
    expression: &RequirementExpression,
    input: &SolveInput,
    selected: &BTreeSet<String>,
    platforms: PlatformView<'_>,
) -> Option<Vec<String>> {
    match expression {
        RequirementExpression::Package {
            purl,
            vers,
            qualifiers,
        } => selected.iter().find_map(|node_id| {
            let package = input
                .universe
                .packages
                .iter()
                .find(|package| package.node_id == *node_id)?;
            ((package.identity.canonical_purl == *purl
                || package.identity.exact_purl.as_deref() == Some(purl))
                && qualifiers
                    .iter()
                    .all(|(key, value)| package.identity.qualifiers.get(key) == Some(value))
                && vers.as_deref().is_none_or(|constraint| {
                    version_satisfies(&package.normalized_version, constraint)
                }))
            .then(|| vec![node_id.clone()])
        }),
        RequirementExpression::Capability {
            name,
            vers,
            attributes,
        } => selected.iter().find_map(|node_id| {
            let package = input
                .universe
                .packages
                .iter()
                .find(|package| package.node_id == *node_id)?;
            package
                .capabilities
                .iter()
                .find(|capability| {
                    capability.name == *name
                        && capability
                            .target_predicate
                            .as_ref()
                            .is_none_or(|predicate| {
                                predicate_holds(predicate, request_platforms(&input.request))
                            })
                        && attributes
                            .iter()
                            .all(|(key, value)| capability.attributes.get(key) == Some(value))
                        && vers.as_deref().is_none_or(|constraint| {
                            capability
                                .version
                                .as_deref()
                                .is_some_and(|version| version_satisfies(version, constraint))
                        })
                })
                .map(|_| vec![node_id.clone()])
        }),
        RequirementExpression::AllOf { expressions } => {
            let mut nodes = Vec::new();
            for expression in expressions {
                nodes.extend(expression_witness(expression, input, selected, platforms)?);
            }
            nodes.sort();
            nodes.dedup();
            Some(nodes)
        }
        RequirementExpression::AnyOf { expressions } => expressions
            .iter()
            .filter_map(|expression| expression_witness(expression, input, selected, platforms))
            .min(),
        RequirementExpression::Not { expression } => {
            expression_witness(expression, input, selected, platforms)
                .is_none()
                .then(Vec::new)
        }
        RequirementExpression::Conditional {
            when,
            then,
            otherwise,
        } => {
            if predicate_holds(when, platforms) {
                expression_witness(then, input, selected, platforms)
            } else {
                otherwise.as_ref().map_or(Some(Vec::new()), |expression| {
                    expression_witness(expression, input, selected, platforms)
                })
            }
        }
    }
}

fn predicate_holds(predicate: &TargetPredicate, platforms: PlatformView<'_>) -> bool {
    use TargetPredicate::*;
    match predicate {
        True => true,
        False => false,
        Equals { path, value } => platforms.scalar(path).as_ref() == Some(value),
        NotEquals { path, value } => platforms.scalar(path).as_ref() != Some(value),
        In { path, values } => platforms
            .scalar(path)
            .is_some_and(|value| values.contains(&value)),
        NotIn { path, values } => platforms
            .scalar(path)
            .is_none_or(|value| !values.contains(&value)),
        VersionSatisfies { path, constraint } => platforms
            .scalar(path)
            .and_then(|value| value.as_str().map(str::to_owned))
            .is_some_and(|version| {
                constraint
                    .vers
                    .as_deref()
                    .is_some_and(|vers| version_satisfies(&version, vers))
            }),
        CapabilityPresent { name, constraint } => {
            platforms.host().capabilities.iter().any(|capability| {
                capability.name == *name
                    && constraint.as_ref().is_none_or(|constraint| {
                        capability.version.as_deref().is_some_and(|version| {
                            constraint
                                .vers
                                .as_deref()
                                .is_some_and(|vers| version_satisfies(version, vers))
                        })
                    })
            })
        }
        AllOf { predicates } => predicates
            .iter()
            .all(|predicate| predicate_holds(predicate, platforms)),
        AnyOf { predicates } => predicates
            .iter()
            .any(|predicate| predicate_holds(predicate, platforms)),
        Not { predicate } => !predicate_holds(predicate, platforms),
    }
}

fn lifecycle_allowed(package: &PackageInstance, input: &SolveInput) -> bool {
    match package.lifecycle.status.as_str() {
        "yanked" => input.request.policy.allow_yanked,
        "quarantined" => input.request.policy.allow_quarantined,
        "revoked" => false,
        _ => package.lifecycle.eligible,
    }
}

fn independent_objectives(input: &SolveInput, selected: &[usize]) -> Vec<Value> {
    let ids: BTreeSet<_> = selected
        .iter()
        .map(|index| input.universe.packages[*index].node_id.clone())
        .collect();
    let installed: BTreeSet<_> = input
        .request
        .environment
        .installed
        .iter()
        .cloned()
        .collect();
    let mut versions: Vec<_> = selected
        .iter()
        .map(|index| input.universe.packages[*index].version_sort_key.clone())
        .collect();
    versions.sort_by(|a, b| b.cmp(a));
    input
        .request
        .objectives
        .iter()
        .map(|objective| match objective.as_str() {
            "satisfy-hard-constraints" | "exclude-lifecycle-denied" => json!(0),
            "preserve-locks" => json!(
                input
                    .request
                    .environment
                    .locked
                    .iter()
                    .filter(|id| !ids.contains(*id))
                    .count()
            ),
            "minimize-changes" => json!(ids.symmetric_difference(&installed).count()),
            "minimize-package-count" => json!(selected.len()),
            "prefer-stable" => json!(
                selected
                    .iter()
                    .filter(|index| input.universe.packages[**index]
                        .normalized_version
                        .contains('-'))
                    .count()
            ),
            "prefer-highest-native-version" => json!(versions.join("\u{1f}")),
            "canonical-lexical-tie-break" => {
                let mut ids: Vec<_> = ids.iter().cloned().collect();
                ids.sort();
                json!(ids.join("\u{1f}"))
            }
            unknown => json!(format!("unsupported:{unknown}")),
        })
        .collect()
}

fn selected_indices(
    input: &SolveInput,
    selected: &BTreeSet<String>,
    diagnostics: &mut Vec<String>,
) -> Vec<usize> {
    let mut indices = Vec::new();
    for id in selected {
        match input
            .universe
            .packages
            .iter()
            .position(|package| package.node_id == *id)
        {
            Some(index) => indices.push(index),
            None => diagnostics.push(format!("selected unknown node {id}")),
        }
    }
    indices.sort_unstable();
    indices
}

fn zero_digest() -> Digest {
    Digest {
        algorithm: "sha256".into(),
        value: "0".repeat(64),
    }
}

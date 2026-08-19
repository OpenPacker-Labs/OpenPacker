use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
};

use serde_json::{Value, json};

use crate::semantics::{
    PlatformView, RequirementPlatforms, request_platforms, requirement_is_active,
};
use crate::{
    CapabilityProvider, DependencyEdge, Digest, ExcludedCandidate, ExplanationEdge,
    ExplanationGraph, ExplanationNode, PackageInstance, ProofCheck, RequirementExpression,
    RequirementWitness, ResolutionProof, ResolutionSolution, ResolutionUniverse, ResolverError,
    SelectedAssignment, SolveInput, SolveOutput, SolveRequest, TargetPredicate, canonical_json,
    digest_json, digest_projection, parse_json_as, version_satisfies,
};

pub const MAX_COMPANION_NODES: usize = 22;
pub const MAX_UNIVERSE_NODES: usize = 100_000;
pub const MAX_REQUIREMENTS: usize = 1_000_000;
pub const MAX_ALTERNATIVES: usize = 10_000;
pub const MAX_EXPRESSION_DEPTH: usize = 64;
pub const MAX_PREDICATE_DEPTH: usize = 64;
pub const MAX_EXHAUSTIVE_WORK: u64 = 10_000_000;

const SUPPORTED_REQUIREMENT_KINDS: [&str; 11] = [
    "runtime",
    "build",
    "development",
    "peer",
    "optional",
    "feature",
    "tool",
    "platform",
    "replacement",
    "conflict",
    "unknown-native",
];

const SUPPORTED_OBJECTIVES: [&str; 8] = [
    "satisfy-hard-constraints",
    "preserve-locks",
    "minimize-changes",
    "minimize-package-count",
    "exclude-lifecycle-denied",
    "prefer-stable",
    "prefer-highest-native-version",
    "canonical-lexical-tie-break",
];

pub fn validate_universe(universe: &ResolutionUniverse) -> Result<(), ResolverError> {
    if universe.universe_version != "1" {
        return Err(ResolverError::InvalidInput(
            "universeVersion must be 1".into(),
        ));
    }
    if universe.packages.len() > MAX_UNIVERSE_NODES {
        return Err(ResolverError::UniverseLimit {
            limit: MAX_UNIVERSE_NODES,
            actual: universe.packages.len(),
        });
    }
    validate_digest(&universe.lifecycle_root, "lifecycleRoot")?;
    validate_digest(&universe.canonical_digest, "canonicalDigest")?;
    let mut ids = BTreeSet::new();
    let mut requirement_ids = BTreeSet::new();
    let mut requirement_count = 0usize;
    for package in &universe.packages {
        crate::normalize::validate_package_identity(&package.identity)?;
        crate::normalize::validate_package_versions(
            &package.identity,
            &package.normalized_version,
            &package.version_sort_key,
        )?;
        let expected_node_id = package_node_id(package)?;
        if package.node_id != expected_node_id {
            return Err(ResolverError::InvalidInput(format!(
                "nodeId does not match package-node-v1 projection for {}",
                package.identity.exact_purl.as_deref().unwrap_or("package")
            )));
        }
        if !ids.insert(&package.node_id) {
            return Err(ResolverError::InvalidInput(format!(
                "duplicate nodeId {}",
                package.node_id
            )));
        }
        if package.identity.exact_purl.is_none() {
            return Err(ResolverError::InvalidInput(format!(
                "package {} has no exactPurl",
                package.node_id
            )));
        }
        validate_digest(&package.metadata_digest, "metadataDigest")?;
        for digest in &package.source_snapshots {
            validate_digest(digest, "source snapshot digest")?;
        }
        requirement_count = requirement_count
            .checked_add(package.requirements.len())
            .ok_or_else(|| ResolverError::InvalidInput("requirement count overflow".into()))?;
        for requirement in &package.requirements {
            if !requirement_ids.insert(&requirement.id) {
                return Err(ResolverError::InvalidInput(format!(
                    "duplicate requirement id {}",
                    requirement.id
                )));
            }
            validate_expression(&requirement.expression, 1)?;
        }
        for capability in &package.capabilities {
            if capability.provider_node_id != package.node_id {
                return Err(ResolverError::InvalidInput(format!(
                    "capability {} providerNodeId mismatch",
                    capability.name
                )));
            }
            if let Some(predicate) = &capability.target_predicate {
                validate_predicate(predicate, 1)?;
            }
        }
        for conflict in &package.conflicts {
            validate_expression(&conflict.expression, 1)?;
        }
        for constraint in &package.cardinality_constraints {
            if constraint.minimum > constraint.maximum {
                return Err(ResolverError::InvalidInput(format!(
                    "cardinality {} minimum exceeds maximum",
                    constraint.id
                )));
            }
            validate_expression(&constraint.selector, 1)?;
        }
    }
    if requirement_count > MAX_REQUIREMENTS {
        return Err(ResolverError::InvalidInput(format!(
            "requirements exceed the limit of {MAX_REQUIREMENTS}"
        )));
    }
    for package in &universe.packages {
        for requirement in &package.requirements {
            if requirement
                .depender_node_id
                .as_deref()
                .is_some_and(|id| id != package.node_id)
            {
                return Err(ResolverError::InvalidInput(format!(
                    "requirement {} dependerNodeId mismatch",
                    requirement.id
                )));
            }
        }
    }
    Ok(())
}

fn package_node_id(package: &PackageInstance) -> Result<String, ResolverError> {
    let version = package
        .native_semantics
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ResolverError::InvalidInput("nativeSemantics.version must be a string".into())
        })?;
    let projection = json!({
        "identity": {
            "exactPurl": package.identity.exact_purl,
            "qualifiers": package.identity.qualifiers,
        },
        "nativeSemantics": { "version": version },
    });
    Ok(digest_json(&projection)?.as_string())
}

pub(crate) fn validate_solve_request(input: &SolveInput) -> Result<(), ResolverError> {
    match input.request.semantics.profile.as_str() {
        "native-capture-v1" | "native-validated-v1" => {
            captured_indices(input)?;
        }
        "prex-calculus-subset-v1" => {}
        _ => {
            return Err(ResolverError::UnsupportedSemantics(
                input.request.semantics.profile.clone(),
            ));
        }
    }
    if !matches!(
        input.request.policy.semantic_loss_maximum.as_str(),
        "info" | "warning" | "error"
    ) {
        return Err(ResolverError::InvalidInput(
            "semanticLossMaximum must be info, warning, or error".into(),
        ));
    }
    let mut required_evidence = BTreeSet::new();
    for evidence in &input.request.policy.required_evidence {
        if !required_evidence.insert(evidence) {
            return Err(ResolverError::InvalidInput(
                "requiredEvidence must be unique".into(),
            ));
        }
        // Receipt signatures are established by the signing layer after the
        // pure solve. Every other evidence kind must be established before a
        // universe reaches this resolver; this input has no evidence facts.
        if evidence != "receipt-signature" {
            return Err(ResolverError::Unsatisfiable(format!(
                "required evidence is not present in the solve input: {evidence}"
            )));
        }
    }
    if input.request.objectives.is_empty() || input.request.objectives.len() > 16 {
        return Err(ResolverError::InvalidInput(
            "objectives must contain 1..=16 entries".into(),
        ));
    }
    let mut objectives = BTreeSet::new();
    for objective in &input.request.objectives {
        if !SUPPORTED_OBJECTIVES.contains(&objective.as_str()) {
            return Err(ResolverError::InvalidInput(format!(
                "unsupported objective: {objective}"
            )));
        }
        if !objectives.insert(objective) {
            return Err(ResolverError::InvalidInput(format!(
                "duplicate objective: {objective}"
            )));
        }
    }
    let mut requirement_ids: BTreeSet<_> = input
        .universe
        .packages
        .iter()
        .flat_map(|package| {
            package
                .requirements
                .iter()
                .map(|requirement| &requirement.id)
        })
        .collect();
    let universe_requirements: usize = input
        .universe
        .packages
        .iter()
        .map(|package| package.requirements.len())
        .sum();
    if universe_requirements
        .checked_add(input.request.requirements.len())
        .is_none_or(|count| count > MAX_REQUIREMENTS)
    {
        return Err(ResolverError::InvalidInput(format!(
            "requirements exceed the limit of {MAX_REQUIREMENTS}"
        )));
    }
    for requirement in &input.request.requirements {
        if !requirement_ids.insert(&requirement.id) {
            return Err(ResolverError::InvalidInput(format!(
                "duplicate requirement id {}",
                requirement.id
            )));
        }
        validate_expression(&requirement.expression, 1)?;
    }
    for amendment in &input.universe.amendments {
        if amendment.amendment_version != "1" {
            return Err(ResolverError::InvalidInput(
                "amendmentVersion must be 1".into(),
            ));
        }
        validate_digest(
            &amendment.applies_to_metadata_digest,
            "appliesToMetadataDigest",
        )?;
        if amendment.operations.is_empty() {
            return Err(ResolverError::InvalidInput(
                "amendment must declare at least one operation".into(),
            ));
        }
        let matching_subjects = input
            .universe
            .packages
            .iter()
            .filter(|package| {
                package.metadata_digest == amendment.applies_to_metadata_digest
                    && serde_json::from_value::<crate::PackageIdentity>(amendment.subject.clone())
                        .is_ok_and(|subject| subject == package.identity)
            })
            .count();
        if matching_subjects != 1 {
            return Err(ResolverError::InvalidInput(
                "amendment subject and appliesToMetadataDigest must identify exactly one universe package"
                    .into(),
            ));
        }
    }
    let mut amendment_digests = BTreeSet::new();
    for digest in &input.request.policy.accepted_amendment_digests {
        validate_digest(digest, "acceptedAmendmentDigests")?;
        if !amendment_digests.insert(digest.as_string()) {
            return Err(ResolverError::InvalidInput(
                "acceptedAmendmentDigests must be unique".into(),
            ));
        }
    }
    if let Some(platforms) = &input.request.platforms {
        if platforms
            .host
            .as_ref()
            .is_some_and(|host| *host != input.request.target)
        {
            return Err(ResolverError::InvalidInput(
                "platforms.host must equal the request target".into(),
            ));
        }
    }
    // The kind policy is consulted whether or not platforms are supplied, so
    // a misspelled kind must be rejected either way rather than silently
    // failing to match.
    if let Some(policy) = &input.request.requirement_kind_policy {
        for kinds in [&policy.build_platform_kinds, &policy.inactive_kinds]
            .into_iter()
            .flatten()
        {
            for kind in kinds {
                if !SUPPORTED_REQUIREMENT_KINDS.contains(&kind.as_str()) {
                    return Err(ResolverError::InvalidInput(format!(
                        "unsupported requirement kind: {kind}"
                    )));
                }
            }
        }
    }
    if input.request.semantics.profile == "prex-calculus-subset-v1"
        && objectives_require_optimization(&input.request)
        && input.universe.packages.len() > MAX_COMPANION_NODES
    {
        return Err(ResolverError::ObjectiveLimit {
            limit: MAX_COMPANION_NODES,
            actual: input.universe.packages.len(),
        });
    }
    if input.request.semantics.profile == "prex-calculus-subset-v1"
        && (objectives_require_optimization(&input.request)
            || !crate::resolvo_engine::supports(input))
    {
        enforce_exhaustive_work_limit(input)?;
    }
    Ok(())
}

pub(crate) fn enforce_exhaustive_work_limit(input: &SolveInput) -> Result<(), ResolverError> {
    let nodes = input.universe.packages.len();
    if nodes > MAX_COMPANION_NODES {
        return Ok(());
    }
    let node_work = u64::try_from(nodes.max(1)).unwrap_or(u64::MAX);
    let mut structure =
        node_work.saturating_add(u64::try_from(input.request.objectives.len()).unwrap_or(u64::MAX));
    for requirement in &input.request.requirements {
        structure = structure.saturating_add(expression_work(&requirement.expression));
    }
    for package in &input.universe.packages {
        for requirement in &package.requirements {
            structure = structure.saturating_add(expression_work(&requirement.expression));
        }
        for conflict in &package.conflicts {
            structure = structure.saturating_add(expression_work(&conflict.expression));
        }
        for constraint in &package.cardinality_constraints {
            structure = structure
                .saturating_add(expression_work(&constraint.selector).saturating_mul(node_work));
        }
        for capability in &package.capabilities {
            if let Some(predicate) = &capability.target_predicate {
                structure = structure.saturating_add(predicate_work(predicate));
            }
        }
    }
    let assignments = 1u64 << nodes;
    let required = assignments
        .saturating_mul(node_work)
        .saturating_mul(structure.max(1));
    let requested = input
        .request
        .resource_limits
        .as_ref()
        .and_then(|limits| limits.get("graphNodes"))
        .map(|value| {
            value.as_u64().filter(|limit| *limit > 0).ok_or_else(|| {
                ResolverError::InvalidInput(
                    "resourceLimits.graphNodes must be a positive integer".into(),
                )
            })
        })
        .transpose()?;
    let limit = requested
        .unwrap_or(MAX_EXHAUSTIVE_WORK)
        .min(MAX_EXHAUSTIVE_WORK);
    if required > limit {
        return Err(ResolverError::ExhaustiveWorkLimit { limit, required });
    }
    Ok(())
}

fn expression_work(expression: &RequirementExpression) -> u64 {
    match expression {
        RequirementExpression::AllOf { expressions }
        | RequirementExpression::AnyOf { expressions } => {
            expressions.iter().fold(1u64, |work, item| {
                work.saturating_add(expression_work(item))
            })
        }
        RequirementExpression::Not { expression } => {
            1u64.saturating_add(expression_work(expression))
        }
        RequirementExpression::Conditional {
            when,
            then,
            otherwise,
        } => 1u64
            .saturating_add(predicate_work(when))
            .saturating_add(expression_work(then))
            .saturating_add(otherwise.as_deref().map_or(0, expression_work)),
        _ => 1,
    }
}

fn predicate_work(predicate: &TargetPredicate) -> u64 {
    match predicate {
        TargetPredicate::AllOf { predicates } | TargetPredicate::AnyOf { predicates } => predicates
            .iter()
            .fold(1u64, |work, item| work.saturating_add(predicate_work(item))),
        TargetPredicate::Not { predicate } => 1u64.saturating_add(predicate_work(predicate)),
        _ => 1,
    }
}

/// Amendments the policy admits, and those present but ignored. Admitted
/// amendments are compiled into a derived universe; ignored ones contribute
/// nothing but are still recorded in the explanation.
pub fn partition_amendments(input: &SolveInput) -> (Vec<usize>, Vec<usize>) {
    let accepted = &input.request.policy.accepted_amendment_authorities;
    let accepted_digests: BTreeSet<_> = input
        .request
        .policy
        .accepted_amendment_digests
        .iter()
        .map(Digest::as_string)
        .collect();
    let (admitted, ignored): (Vec<_>, Vec<_>) = input
        .universe
        .amendments
        .iter()
        .enumerate()
        .partition(|(_, amendment)| {
            accepted.contains(&amendment.authority)
                && digest_json(amendment)
                    .is_ok_and(|digest| accepted_digests.contains(&digest.as_string()))
        });
    (
        admitted.into_iter().map(|(index, _)| index).collect(),
        ignored.into_iter().map(|(index, _)| index).collect(),
    )
}

pub(crate) fn objectives_require_optimization(request: &SolveRequest) -> bool {
    request.objectives.iter().any(|objective| {
        !matches!(
            objective.as_str(),
            "satisfy-hard-constraints" | "exclude-lifecycle-denied"
        )
    })
}

fn validate_digest(digest: &Digest, field: &str) -> Result<(), ResolverError> {
    if digest.algorithm != "sha256"
        || digest.value.len() != 64
        || !digest
            .value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ResolverError::InvalidInput(format!(
            "{field} must be a canonical sha256 digest"
        )));
    }
    Ok(())
}

fn validate_expression(
    expression: &RequirementExpression,
    depth: usize,
) -> Result<(), ResolverError> {
    if depth > MAX_EXPRESSION_DEPTH {
        return Err(ResolverError::InvalidInput(format!(
            "requirement expression exceeds depth {MAX_EXPRESSION_DEPTH}"
        )));
    }
    match expression {
        RequirementExpression::AllOf { expressions }
        | RequirementExpression::AnyOf { expressions } => {
            if expressions.is_empty() || expressions.len() > MAX_ALTERNATIVES {
                return Err(ResolverError::InvalidInput(format!(
                    "requirement alternatives must contain 1..={MAX_ALTERNATIVES} entries"
                )));
            }
            for expression in expressions {
                validate_expression(expression, depth + 1)?;
            }
        }
        RequirementExpression::Not { expression } => {
            validate_expression(expression, depth + 1)?;
        }
        RequirementExpression::Conditional {
            when,
            then,
            otherwise,
        } => {
            validate_predicate(when, 1)?;
            validate_expression(then, depth + 1)?;
            if let Some(otherwise) = otherwise {
                validate_expression(otherwise, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_predicate(predicate: &TargetPredicate, depth: usize) -> Result<(), ResolverError> {
    if depth > MAX_PREDICATE_DEPTH {
        return Err(ResolverError::InvalidInput(format!(
            "target predicate exceeds depth {MAX_PREDICATE_DEPTH}"
        )));
    }
    match predicate {
        TargetPredicate::AllOf { predicates } | TargetPredicate::AnyOf { predicates } => {
            if predicates.is_empty() || predicates.len() > MAX_ALTERNATIVES {
                return Err(ResolverError::InvalidInput(format!(
                    "target predicates must contain 1..={MAX_ALTERNATIVES} entries"
                )));
            }
            for predicate in predicates {
                validate_predicate(predicate, depth + 1)?;
            }
        }
        TargetPredicate::Not { predicate } => validate_predicate(predicate, depth + 1)?,
        _ => {}
    }
    Ok(())
}

pub fn validate_universe_json(input: &str) -> Result<(), ResolverError> {
    validate_universe(&parse_json_as(input)?)
}

pub fn solve(input: &SolveInput) -> Result<SolveOutput, ResolverError> {
    validate_universe(&input.universe)?;
    validate_solve_request(input)?;
    // Amendments produce a derived universe; everything downstream — search,
    // proof, explanation, and the independent checker — runs against it, so no
    // two of them can disagree about what was solved.
    let amended = crate::amend::apply_amendments(input)?;
    if !amended.applied.is_empty() {
        let mut output = solve_amended(&amended.input)?;
        output.proof.applied_amendment_digests = amended
            .applied
            .iter()
            .map(|item| item.digest.clone())
            .collect();
        return Ok(output);
    }
    solve_amended(input)
}

fn solve_amended(input: &SolveInput) -> Result<SolveOutput, ResolverError> {
    let output = match input.request.semantics.profile.as_str() {
        "native-capture-v1" => {
            let captured = captured_indices(input)?;
            build_native_output(input, &captured, false)?
        }
        "native-validated-v1" => {
            let captured = captured_indices(input)?;
            let mut diagnostics = Vec::new();
            if !crate::checker::independent_valid_selection(input, &captured, &mut diagnostics) {
                return Err(ResolverError::InvalidProof(format!(
                    "native selection failed represented PREX validation: {}",
                    diagnostics.join("; ")
                )));
            }
            build_native_output(input, &captured, true)?
        }
        "prex-calculus-subset-v1" => {
            let best = if crate::resolvo_engine::supports(input) {
                let selected = crate::resolvo_engine::resolve(input)?;
                if input.universe.packages.len() <= MAX_COMPANION_NODES {
                    let oracle = crate::oracle::brute_force_oracle_amended(input)?;
                    let ids = node_ids(input, &selected);
                    if ids != oracle.selected_node_ids {
                        return Err(ResolverError::InvalidProof(format!(
                            "Resolvo selection differs from bounded optimum: {:?} != {:?}",
                            ids, oracle.selected_node_ids
                        )));
                    }
                }
                selected
            } else {
                companion_resolve(input)?
            };
            build_output(input, &best)?
        }
        _ => unreachable!("semantics profile was validated"),
    };
    enforce_solution_policy(input, &output)?;
    // The already-amended universe is checked directly: re-entering the public
    // checker would apply the same amendments a second time.
    let checked = crate::checker::check_amended(input, &output)?;
    if !checked.valid {
        return Err(ResolverError::InvalidProof(checked.diagnostics.join("; ")));
    }
    Ok(output)
}

pub(crate) fn enforce_solution_policy(
    input: &SolveInput,
    output: &SolveOutput,
) -> Result<(), ResolverError> {
    let maximum = severity_rank(&input.request.policy.semantic_loss_maximum)
        .ok_or_else(|| ResolverError::InvalidInput("invalid semanticLossMaximum".into()))?;
    let losses = output
        .solution
        .semantic_loss
        .iter()
        .chain(
            input
                .request
                .requirements
                .iter()
                .flat_map(|requirement| requirement.semantic_loss.iter()),
        )
        .chain(output.selected.iter().flat_map(|package| {
            package
                .requirements
                .iter()
                .flat_map(|requirement| requirement.semantic_loss.iter())
        }));
    for loss in losses {
        let severity = loss
            .get("severity")
            .and_then(Value::as_str)
            .and_then(severity_rank)
            .ok_or_else(|| {
                ResolverError::InvalidInput("semantic loss has invalid severity".into())
            })?;
        if severity > maximum {
            return Err(ResolverError::Unsatisfiable(format!(
                "semantic loss exceeds policy maximum: {}",
                loss.get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
            )));
        }
    }
    Ok(())
}

fn severity_rank(value: &str) -> Option<u8> {
    match value {
        "info" => Some(0),
        "warning" => Some(1),
        "error" => Some(2),
        _ => None,
    }
}

pub(crate) fn captured_indices(input: &SolveInput) -> Result<Vec<usize>, ResolverError> {
    if input.request.environment.locked.is_empty() {
        return Err(ResolverError::InvalidInput(
            "native semantics profiles require at least one captured exact selection in environment.locked"
                .into(),
        ));
    }
    let mut selected = BTreeSet::new();
    for locked in &input.request.environment.locked {
        let matches: Vec<_> = input
            .universe
            .packages
            .iter()
            .enumerate()
            .filter_map(|(index, package)| {
                (package.node_id == *locked
                    || package.identity.exact_purl.as_deref() == Some(locked.as_str()))
                .then_some(index)
            })
            .collect();
        match matches.as_slice() {
            [] => {
                return Err(ResolverError::InvalidInput(format!(
                    "captured selection does not resolve to a universe node: {locked}"
                )));
            }
            [index] if selected.insert(*index) => {}
            [_] => {
                return Err(ResolverError::InvalidInput(format!(
                    "captured selection resolves to a duplicate node: {locked}"
                )));
            }
            _ => {
                return Err(ResolverError::InvalidInput(format!(
                    "captured selection is ambiguous: {locked}"
                )));
            }
        }
    }
    Ok(selected.into_iter().collect())
}

fn companion_resolve(input: &SolveInput) -> Result<Vec<usize>, ResolverError> {
    if input.universe.packages.len() > MAX_COMPANION_NODES {
        return Err(ResolverError::UniverseLimit {
            limit: MAX_COMPANION_NODES,
            actual: input.universe.packages.len(),
        });
    }
    enforce_exhaustive_work_limit(input)?;
    let mut best: Option<Vec<usize>> = None;
    let count = 1u64 << input.universe.packages.len();
    for mask in 0..count {
        let selected: Vec<_> = (0..input.universe.packages.len())
            .filter(|index| mask & (1 << index) != 0)
            .collect();
        if selection_valid(input, &selected)
            && best.as_ref().is_none_or(|current| {
                compare_selection(input, &selected, current) == Ordering::Less
            })
        {
            best = Some(selected);
        }
    }
    best.ok_or_else(|| ResolverError::Unsatisfiable(unsat_summary(input)))
}

pub fn solve_json(input: &str) -> Result<String, ResolverError> {
    Ok(
        String::from_utf8(canonical_json(&solve(&parse_json_as(input)?)?)?)
            .expect("canonical JSON is UTF-8"),
    )
}

pub(crate) fn selection_valid(input: &SolveInput, selected: &[usize]) -> bool {
    let selected: BTreeSet<_> = selected.iter().copied().collect();
    if selected
        .iter()
        .any(|index| !lifecycle_allowed(&input.universe.packages[*index], &input.request))
    {
        return false;
    }
    let platforms = RequirementPlatforms::new(&input.request);
    let host_platforms = platforms.host_default();
    if input.request.requirements.iter().any(|requirement| {
        !requirement.optional
            && requirement_is_active(&input.request, Some(requirement.kind.as_str()))
            && expression_witness(
                &requirement.expression,
                input,
                &selected,
                platforms.select(&input.request, Some(requirement.kind.as_str())),
            )
            .is_none()
    }) {
        return false;
    }
    for index in &selected {
        let package = &input.universe.packages[*index];
        if package.requirements.iter().any(|requirement| {
            !requirement.optional
                && requirement_is_active(&input.request, Some(requirement.kind.as_str()))
                && expression_witness(
                    &requirement.expression,
                    input,
                    &selected,
                    platforms.select(&input.request, Some(requirement.kind.as_str())),
                )
                .is_none()
        }) {
            return false;
        }
        if package.conflicts.iter().any(|conflict| {
            expression_witness(&conflict.expression, input, &selected, host_platforms).is_some()
        }) {
            return false;
        }
        for constraint in &package.cardinality_constraints {
            let count = selected
                .iter()
                .filter(|candidate| {
                    expression_witness(
                        &constraint.selector,
                        input,
                        &BTreeSet::from([**candidate]),
                        host_platforms,
                    )
                    .is_some()
                })
                .count();
            if count < constraint.minimum || count > constraint.maximum {
                return false;
            }
        }
    }
    true
}

pub(crate) fn compare_selection(input: &SolveInput, left: &[usize], right: &[usize]) -> Ordering {
    for objective in &input.request.objectives {
        let ordering = match objective.as_str() {
            "preserve-locks" => missing_locks(input, left).cmp(&missing_locks(input, right)),
            "minimize-changes" => changes(input, left).cmp(&changes(input, right)),
            "minimize-package-count" => left.len().cmp(&right.len()),
            "prefer-stable" => prereleases(input, left).cmp(&prereleases(input, right)),
            "prefer-highest-native-version" => {
                version_keys(input, right).cmp(&version_keys(input, left))
            }
            "canonical-lexical-tie-break" => node_ids(input, left).cmp(&node_ids(input, right)),
            _ => Ordering::Equal,
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    node_ids(input, left).cmp(&node_ids(input, right))
}

pub(crate) fn objective_tuple(input: &SolveInput, selected: &[usize]) -> Vec<Value> {
    input
        .request
        .objectives
        .iter()
        .map(|objective| match objective.as_str() {
            "satisfy-hard-constraints" | "exclude-lifecycle-denied" => json!(0),
            "preserve-locks" => json!(missing_locks(input, selected)),
            "minimize-changes" => json!(changes(input, selected)),
            "minimize-package-count" => json!(selected.len()),
            "prefer-stable" => json!(prereleases(input, selected)),
            "prefer-highest-native-version" => json!(version_keys(input, selected).join("\u{1f}")),
            "canonical-lexical-tie-break" => json!(node_ids(input, selected).join("\u{1f}")),
            unknown => json!(format!("unsupported:{unknown}")),
        })
        .collect()
}

pub(crate) fn build_output(
    input: &SolveInput,
    selected_indices: &[usize],
) -> Result<SolveOutput, ResolverError> {
    let selected_set: BTreeSet<_> = selected_indices.iter().copied().collect();
    let selected: Vec<_> = selected_indices
        .iter()
        .map(|index| input.universe.packages[*index].clone())
        .collect();
    let request_digest = digest_projection(&input.request, "request-v1")?;
    let universe_digest = digest_projection(&input.universe, "universe-v1")?;
    let witness_platforms = RequirementPlatforms::new(&input.request);
    let mut witnesses = Vec::new();
    let mut satisfied = Vec::new();
    let mut edges = Vec::new();
    for requirement in input.request.requirements.iter().chain(
        selected
            .iter()
            .flat_map(|package| package.requirements.iter()),
    ) {
        // An inactive kind is not compiled, so it contributes no witness and
        // no edge. Emitting one would make the proof describe a requirement
        // the solve never considered.
        if !requirement_is_active(&input.request, Some(requirement.kind.as_str())) {
            continue;
        }
        let resolved = expression_witness(
            &requirement.expression,
            input,
            &selected_set,
            witness_platforms.select(&input.request, Some(requirement.kind.as_str())),
        );
        let status = if resolved.is_none() && requirement.optional {
            "optional-omitted"
        } else {
            "satisfied"
        };
        let witness = resolved.unwrap_or_default();
        if status == "satisfied" {
            satisfied.push(requirement.id.clone());
        }
        for node in &witness {
            edges.push(DependencyEdge {
                requirement_id: requirement.id.clone(),
                from_node_id: requirement
                    .depender_node_id
                    .clone()
                    .unwrap_or_else(|| "root".into()),
                to_node_id: node.clone(),
                witness_type: witness_type(&requirement.expression).into(),
            });
        }
        witnesses.push(RequirementWitness {
            requirement_id: requirement.id.clone(),
            status: status.into(),
            witness_node_ids: witness,
        });
    }
    satisfied.sort();
    satisfied.dedup();
    edges.sort_by(|a, b| {
        (&a.requirement_id, &a.to_node_id).cmp(&(&b.requirement_id, &b.to_node_id))
    });
    let mut selected_node_ids = node_ids(input, selected_indices);
    let capability_providers = selected
        .iter()
        .flat_map(|package| {
            package
                .capabilities
                .iter()
                .filter(|capability| {
                    capability
                        .target_predicate
                        .as_ref()
                        .is_none_or(|predicate| {
                            evaluate_target_predicate_fixed(
                                predicate,
                                request_platforms(&input.request),
                            )
                        })
                })
                .map(|capability| CapabilityProvider {
                    capability: capability.name.clone(),
                    provider_node_id: package.node_id.clone(),
                })
        })
        .collect();
    let excluded_candidates = input
        .universe
        .packages
        .iter()
        .filter(|package| !selected_node_ids.contains(&package.node_id))
        .map(|package| ExcludedCandidate {
            node_id: package.node_id.clone(),
            reason_refs: vec![
                if lifecycle_allowed(package, &input.request) {
                    "objective-not-selected"
                } else {
                    "lifecycle-denied"
                }
                .into(),
            ],
        })
        .collect();
    let mut solution = ResolutionSolution {
        selected_node_ids: selected_node_ids.clone(),
        selected_capability_providers: capability_providers,
        satisfied_requirement_ids: satisfied,
        dependency_edges: edges,
        excluded_candidates,
        objective_tuple: objective_tuple(input, selected_indices),
        semantic_loss: selected
            .iter()
            .flat_map(|package| package.semantic_loss.clone())
            .collect(),
        source_snapshot_digests: selected
            .iter()
            .flat_map(|package| package.source_snapshots.clone())
            .collect(),
        solution_digest: zero_digest(),
    };
    solution
        .source_snapshot_digests
        .sort_by(|a, b| a.value.cmp(&b.value));
    solution.solution_digest = digest_projection(&solution, "solution-v1")?;
    let proof = ResolutionProof {
        applied_amendment_digests: Vec::new(),
        proof_version: "1".into(),
        universe_digest: universe_digest.clone(),
        request_digest: request_digest.clone(),
        selected_assignments: input
            .universe
            .packages
            .iter()
            .map(|package| {
                Ok(SelectedAssignment {
                    node_id: package.node_id.clone(),
                    selected: selected_node_ids.binary_search(&package.node_id).is_ok(),
                    node_digest: digest_json(package)?,
                })
            })
            .collect::<Result<_, ResolverError>>()?,
        requirement_witnesses: witnesses,
        conflict_checks: selected
            .iter()
            .flat_map(|package| {
                package.conflicts.iter().map(|conflict| ProofCheck {
                    id: conflict.id.clone(),
                    valid: true,
                    evidence: BTreeMap::from([
                        ("selectedNodeId".into(), json!(package.node_id)),
                        ("scope".into(), json!(conflict.scope)),
                    ]),
                })
            })
            .collect(),
        cardinality_checks: selected
            .iter()
            .flat_map(|package| {
                package.cardinality_constraints.iter().map(|constraint| {
                    let count = selected_set
                        .iter()
                        .filter(|candidate| {
                            expression_witness(
                                &constraint.selector,
                                input,
                                &BTreeSet::from([**candidate]),
                                request_platforms(&input.request),
                            )
                            .is_some()
                        })
                        .count();
                    ProofCheck {
                        id: constraint.id.clone(),
                        valid: count >= constraint.minimum && count <= constraint.maximum,
                        evidence: BTreeMap::from([
                            ("minimum".into(), json!(constraint.minimum)),
                            ("maximum".into(), json!(constraint.maximum)),
                            ("actual".into(), json!(count)),
                            ("scope".into(), json!(constraint.scope)),
                        ]),
                    }
                })
            })
            .collect(),
        target_checks: target_checks(input, &selected),
        objective_evidence: input
            .request
            .objectives
            .iter()
            .enumerate()
            .map(|(index, objective)| ProofCheck {
                id: objective.clone(),
                valid: true,
                evidence: BTreeMap::from([(
                    "value".into(),
                    solution.objective_tuple[index].clone(),
                )]),
            })
            .collect(),
    };
    let explanation = explanation(input, &solution, &proof);
    selected_node_ids.sort();
    Ok(SolveOutput {
        normalized_request: input.request.clone(),
        request_digest,
        universe_digest,
        selected,
        solution,
        proof,
        explanation,
    })
}

pub(crate) fn build_native_output(
    input: &SolveInput,
    selected_indices: &[usize],
    validated: bool,
) -> Result<SolveOutput, ResolverError> {
    let mut output = build_output(input, selected_indices)?;
    output
        .solution
        .excluded_candidates
        .iter_mut()
        .for_each(|candidate| {
            candidate.reason_refs = vec!["not-in-native-result".into()];
        });
    output.solution.objective_tuple = input
        .request
        .objectives
        .iter()
        .map(|_| json!("not-evaluated"))
        .collect();
    output.proof.objective_evidence.clear();

    for package in &output.selected {
        output.solution.semantic_loss.push(native_semantics_loss(
            &package.identity.purl_type,
            &format!("/packages/{}/nativeSemantics", package.node_id),
            &package.native_semantics,
            validated,
        )?);
        for requirement in &package.requirements {
            if let Some(native_semantics) = &requirement.native_semantics {
                output.solution.semantic_loss.push(native_semantics_loss(
                    &package.identity.purl_type,
                    &format!(
                        "/packages/{}/requirements/{}/nativeSemantics",
                        package.node_id, requirement.id
                    ),
                    native_semantics,
                    validated,
                )?);
            }
        }
    }
    for requirement in &input.request.requirements {
        if let Some(native_semantics) = &requirement.native_semantics {
            output.solution.semantic_loss.push(native_semantics_loss(
                "generic",
                &format!("/request/requirements/{}/nativeSemantics", requirement.id),
                native_semantics,
                validated,
            )?);
        }
    }

    if !validated {
        output.solution.satisfied_requirement_ids.clear();
        output.solution.dependency_edges.clear();
        for witness in &mut output.proof.requirement_witnesses {
            witness.status = "inactive".into();
            witness.witness_node_ids.clear();
        }
        output.proof.conflict_checks.clear();
        output.proof.cardinality_checks.clear();
        output.proof.target_checks.clear();
        output.solution.semantic_loss.push(json!({
            "code": "NATIVE_RESULT_CAPTURE_ONLY",
            "severity": "warning",
            "sourceEcosystem": "generic",
            "sourcePath": "/request/environment/locked",
            "originalMeaning": "The locked exact selections were produced by an external native resolver",
            "representedMeaning": "OpenPacker resolved every lock entry to one immutable universe node and preserved the captured selection",
            "omittedMeaning": "OpenPacker did not independently establish dependency satisfiability, conflict freedom, target eligibility, cardinality, lifecycle eligibility, or objective optimality",
            "mitigation": "Use native-validated-v1 to independently validate the representable PREX subset",
            "blocksProfile": ["native-validated-v1", "prex-calculus-subset-v1"]
        }));
    }

    output.solution.solution_digest = zero_digest();
    output.solution.solution_digest = digest_projection(&output.solution, "solution-v1")?;
    output.explanation = explanation(input, &output.solution, &output.proof);
    Ok(output)
}

fn native_semantics_loss(
    ecosystem: &str,
    source_path: &str,
    native_semantics: &Value,
    validated: bool,
) -> Result<Value, ResolverError> {
    let native_semantics_digest = digest_json(native_semantics)?;
    Ok(json!({
        "code": "NATIVE_SEMANTICS_NOT_VALIDATED",
        "severity": "warning",
        "sourceEcosystem": ecosystem,
        "sourcePath": source_path,
        "originalMeaning": format!(
            "Opaque versioned nativeSemantics object sha256:{}",
            native_semantics_digest.value
        ),
        "representedMeaning": if validated {
            "PREX requirements, conflicts, cardinality, target predicates, and lifecycle policy were independently validated"
        } else {
            "The exact native package selection was normalized without independently validating PREX constraints"
        },
        "omittedMeaning": "The versioned nativeSemantics extension remains opaque to the PREX proof checker",
        "mitigation": "Use ecosystem-specific native tooling to validate semantics not represented in the PREX IR",
        "blocksProfile": ["prex-calculus-subset-v1"]
    }))
}

fn expression_witness(
    expression: &RequirementExpression,
    input: &SolveInput,
    selected: &BTreeSet<usize>,
    platforms: PlatformView<'_>,
) -> Option<Vec<String>> {
    match expression {
        RequirementExpression::Package {
            purl,
            vers,
            qualifiers,
        } => selected.iter().find_map(|index| {
            let package = &input.universe.packages[*index];
            let identity_matches = package.identity.canonical_purl == *purl
                || package.identity.exact_purl.as_deref() == Some(purl);
            let qualifiers_match = qualifiers
                .iter()
                .all(|(key, value)| package.identity.qualifiers.get(key) == Some(value));
            (identity_matches
                && qualifiers_match
                && vers
                    .as_deref()
                    .is_none_or(|vers| version_satisfies(&package.normalized_version, vers)))
            .then(|| vec![package.node_id.clone()])
        }),
        RequirementExpression::Capability {
            name,
            vers,
            attributes,
        } => selected.iter().find_map(|index| {
            let package = &input.universe.packages[*index];
            package
                .capabilities
                .iter()
                .find(|capability| {
                    capability.name == *name
                        && capability
                            .target_predicate
                            .as_ref()
                            .is_none_or(|predicate| {
                                evaluate_target_predicate_fixed(
                                    predicate,
                                    request_platforms(&input.request),
                                )
                            })
                        && attributes
                            .iter()
                            .all(|(key, value)| capability.attributes.get(key) == Some(value))
                        && vers.as_deref().is_none_or(|vers| {
                            capability
                                .version
                                .as_deref()
                                .is_some_and(|version| version_satisfies(version, vers))
                        })
                })
                .map(|_| vec![package.node_id.clone()])
        }),
        RequirementExpression::AllOf { expressions } => {
            let mut witnesses = Vec::new();
            for expression in expressions {
                witnesses.extend(expression_witness(expression, input, selected, platforms)?);
            }
            witnesses.sort();
            witnesses.dedup();
            Some(witnesses)
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
            if evaluate_target_predicate_fixed(when, platforms) {
                expression_witness(then, input, selected, platforms)
            } else {
                otherwise.as_ref().map_or(Some(Vec::new()), |expression| {
                    expression_witness(expression, input, selected, platforms)
                })
            }
        }
    }
}

fn evaluate_target_predicate_fixed(
    predicate: &crate::TargetPredicate,
    platforms: PlatformView<'_>,
) -> bool {
    use crate::TargetPredicate::*;
    match predicate {
        Equals { path, value } => platforms.scalar(path).as_ref() == Some(value),
        NotEquals { path, value } => platforms.scalar(path).as_ref() != Some(value),
        In { path, values } => platforms.scalar(path).is_some_and(|v| values.contains(&v)),
        NotIn { path, values } => platforms.scalar(path).is_none_or(|v| !values.contains(&v)),
        AllOf { predicates } => predicates
            .iter()
            .all(|p| evaluate_target_predicate_fixed(p, platforms)),
        AnyOf { predicates } => predicates
            .iter()
            .any(|p| evaluate_target_predicate_fixed(p, platforms)),
        Not { predicate } => !evaluate_target_predicate_fixed(predicate, platforms),
        _ => crate::semantics::evaluate_target_predicate_in(predicate, platforms),
    }
}

fn lifecycle_allowed(package: &PackageInstance, request: &SolveRequest) -> bool {
    match package.lifecycle.status.as_str() {
        "yanked" => request.policy.allow_yanked,
        "quarantined" => request.policy.allow_quarantined,
        "revoked" => false,
        _ => package.lifecycle.eligible,
    }
}

fn missing_locks(input: &SolveInput, selected: &[usize]) -> usize {
    let ids = node_ids(input, selected);
    input
        .request
        .environment
        .locked
        .iter()
        .filter(|id| !ids.contains(id))
        .count()
}
fn changes(input: &SolveInput, selected: &[usize]) -> usize {
    let ids: BTreeSet<_> = node_ids(input, selected).into_iter().collect();
    let installed: BTreeSet<_> = input
        .request
        .environment
        .installed
        .iter()
        .cloned()
        .collect();
    ids.symmetric_difference(&installed).count()
}
fn prereleases(input: &SolveInput, selected: &[usize]) -> usize {
    selected
        .iter()
        .filter(|index| {
            input.universe.packages[**index]
                .normalized_version
                .contains('-')
        })
        .count()
}
fn version_keys(input: &SolveInput, selected: &[usize]) -> Vec<String> {
    let mut keys: Vec<_> = selected
        .iter()
        .map(|index| input.universe.packages[*index].version_sort_key.clone())
        .collect();
    keys.sort_by(|a, b| b.cmp(a));
    keys
}
fn node_ids(input: &SolveInput, selected: &[usize]) -> Vec<String> {
    let mut ids: Vec<_> = selected
        .iter()
        .map(|index| input.universe.packages[*index].node_id.clone())
        .collect();
    ids.sort();
    ids
}
fn zero_digest() -> Digest {
    Digest {
        algorithm: "sha256".into(),
        value: "0".repeat(64),
    }
}
fn witness_type(expression: &RequirementExpression) -> &'static str {
    match expression {
        RequirementExpression::Capability { .. } => "capability",
        _ => "package",
    }
}
pub(crate) fn unsat_summary(input: &SolveInput) -> String {
    let mut ids: Vec<_> = input
        .request
        .requirements
        .iter()
        .filter(|r| !r.optional)
        .map(|r| r.id.clone())
        .collect();
    ids.sort();
    json!({
        "code": "UNSATISFIABLE",
        "message": "no assignment satisfies all hard requirements",
        "unsatCore": ids,
        "universeDigest": input.universe.canonical_digest,
    })
    .to_string()
}

fn target_checks(input: &SolveInput, selected: &[PackageInstance]) -> Vec<ProofCheck> {
    let mut checks = Vec::new();
    for package in selected {
        for capability in &package.capabilities {
            if let Some(predicate) = &capability.target_predicate {
                checks.push(ProofCheck {
                    id: format!("target:{}:capability:{}", package.node_id, capability.name),
                    valid: evaluate_target_predicate_fixed(
                        predicate,
                        request_platforms(&input.request),
                    ),
                    evidence: BTreeMap::from([("source".into(), capability.source.clone())]),
                });
            }
        }
    }
    let platforms = RequirementPlatforms::new(&input.request);
    for requirement in input.request.requirements.iter().chain(
        selected
            .iter()
            .flat_map(|package| package.requirements.iter()),
    ) {
        if !requirement_is_active(&input.request, Some(requirement.kind.as_str())) {
            continue;
        }
        let mut sequence = 0;
        collect_expression_target_checks(
            &requirement.id,
            &requirement.expression,
            platforms.select(&input.request, Some(requirement.kind.as_str())),
            &mut checks,
            &mut sequence,
        );
    }
    checks.sort_by(|left, right| left.id.cmp(&right.id));
    checks
}

fn collect_expression_target_checks(
    requirement_id: &str,
    expression: &RequirementExpression,
    platforms: PlatformView<'_>,
    checks: &mut Vec<ProofCheck>,
    sequence: &mut usize,
) {
    match expression {
        RequirementExpression::Conditional {
            when,
            then,
            otherwise,
        } => {
            let id = *sequence;
            *sequence += 1;
            checks.push(ProofCheck {
                id: format!("target:{requirement_id}:{id}"),
                valid: true,
                evidence: BTreeMap::from([
                    (
                        "predicateResult".into(),
                        json!(evaluate_target_predicate_fixed(when, platforms)),
                    ),
                    (
                        "branch".into(),
                        json!(if evaluate_target_predicate_fixed(when, platforms) {
                            "then"
                        } else {
                            "else"
                        }),
                    ),
                ]),
            });
            collect_expression_target_checks(requirement_id, then, platforms, checks, sequence);
            if let Some(otherwise) = otherwise {
                collect_expression_target_checks(
                    requirement_id,
                    otherwise,
                    platforms,
                    checks,
                    sequence,
                );
            }
        }
        RequirementExpression::AllOf { expressions }
        | RequirementExpression::AnyOf { expressions } => {
            for expression in expressions {
                collect_expression_target_checks(
                    requirement_id,
                    expression,
                    platforms,
                    checks,
                    sequence,
                );
            }
        }
        RequirementExpression::Not { expression } => collect_expression_target_checks(
            requirement_id,
            expression,
            platforms,
            checks,
            sequence,
        ),
        _ => {}
    }
}

fn explanation(
    input: &SolveInput,
    solution: &ResolutionSolution,
    proof: &ResolutionProof,
) -> ExplanationGraph {
    let mut nodes: Vec<_> = input
        .universe
        .packages
        .iter()
        .map(|package| ExplanationNode {
            id: package.node_id.clone(),
            kind: "candidate".into(),
            label: package
                .identity
                .exact_purl
                .clone()
                .unwrap_or_else(|| package.identity.canonical_purl.clone()),
            data: BTreeMap::from([
                (
                    "selected".into(),
                    json!(solution.selected_node_ids.contains(&package.node_id)),
                ),
                ("lifecycle".into(), json!(package.lifecycle.status)),
                (
                    "rejectionReasons".into(),
                    json!(
                        solution
                            .excluded_candidates
                            .iter()
                            .find(|candidate| candidate.node_id == package.node_id)
                            .map_or(&[][..], |candidate| candidate.reason_refs.as_slice())
                    ),
                ),
            ]),
        })
        .collect();
    nodes.extend(
        proof
            .requirement_witnesses
            .iter()
            .map(|witness| ExplanationNode {
                id: format!("requirement:{}", witness.requirement_id),
                kind: "requirement".into(),
                label: witness.requirement_id.clone(),
                data: BTreeMap::from([("status".into(), json!(witness.status))]),
            }),
    );
    nodes.extend(
        proof
            .objective_evidence
            .iter()
            .map(|check| ExplanationNode {
                id: format!("objective:{}", check.id),
                kind: "objective".into(),
                label: check.id.clone(),
                data: BTreeMap::from([
                    ("valid".into(), json!(check.valid)),
                    ("evidence".into(), json!(check.evidence)),
                ]),
            }),
    );
    for (kind, checks) in [
        ("conflict", &proof.conflict_checks),
        ("cardinality", &proof.cardinality_checks),
        ("target", &proof.target_checks),
    ] {
        nodes.extend(checks.iter().map(|check| ExplanationNode {
            id: format!("{kind}:{}", check.id),
            kind: kind.into(),
            label: check.id.clone(),
            data: BTreeMap::from([
                ("valid".into(), json!(check.valid)),
                ("evidence".into(), json!(check.evidence)),
            ]),
        }));
    }
    // A requirement suppressed by policy left the solve; say so, for the same
    // reason an ignored amendment does. A consumer reading only the solution
    // would otherwise see a hard requirement silently absent.
    nodes.extend(
        input
            .request
            .requirements
            .iter()
            .chain(
                input
                    .universe
                    .packages
                    .iter()
                    .filter(|package| solution.selected_node_ids.contains(&package.node_id))
                    .flat_map(|package| package.requirements.iter()),
            )
            .filter(|requirement| {
                !requirement_is_active(&input.request, Some(requirement.kind.as_str()))
            })
            .map(|requirement| ExplanationNode {
                id: format!("requirement-suppressed:{}", requirement.id),
                kind: "requirement-suppressed".into(),
                label: format!(
                    "requirement {} was suppressed: kind {} is inactive for this solve",
                    requirement.id, requirement.kind
                ),
                data: BTreeMap::from([
                    ("requirementId".into(), json!(requirement.id)),
                    ("kind".into(), json!(requirement.kind)),
                    ("optional".into(), json!(requirement.optional)),
                ]),
            }),
    );
    let (admitted, ignored) = partition_amendments(input);
    nodes.extend(admitted.into_iter().filter_map(|index| {
        let amendment = &input.universe.amendments[index];
        let digest = digest_json(amendment).ok()?;
        Some(ExplanationNode {
            id: format!("amendment-applied:{}", digest.value),
            kind: "amendment-applied".into(),
            label: format!(
                "amendment from {} superseded interpretation for this solve",
                amendment.authority
            ),
            data: BTreeMap::from([
                ("authority".into(), json!(amendment.authority)),
                (
                    "appliesToMetadataDigest".into(),
                    json!(amendment.applies_to_metadata_digest.as_string()),
                ),
                ("operationCount".into(), json!(amendment.operations.len())),
            ]),
        })
    }));
    nodes.extend(ignored.into_iter().map(|index| {
        let amendment = &input.universe.amendments[index];
        ExplanationNode {
            id: format!("amendment-ignored:{index}"),
            kind: "amendment-ignored".into(),
            label: format!(
                "amendment from {} was not admitted by policy",
                amendment.authority
            ),
            data: BTreeMap::from([
                ("authority".into(), json!(amendment.authority)),
                (
                    "appliesToMetadataDigest".into(),
                    json!(amendment.applies_to_metadata_digest.as_string()),
                ),
                ("operationCount".into(), json!(amendment.operations.len())),
            ]),
        }
    }));
    nodes.extend(
        solution
            .semantic_loss
            .iter()
            .enumerate()
            .map(|(index, loss)| ExplanationNode {
                id: format!("semantic-loss:{index}"),
                kind: "semantic-loss".into(),
                label: loss
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("semantic loss")
                    .into(),
                data: BTreeMap::from([("record".into(), loss.clone())]),
            }),
    );
    let (proof_label, proof_data) = match input.request.semantics.profile.as_str() {
        "native-capture-v1" => (
            "native result capture integrity check",
            BTreeMap::from([
                ("validationStatus".into(), json!("not-performed")),
                ("selectionSource".into(), json!("environment.locked")),
            ]),
        ),
        "native-validated-v1" => (
            "independent represented-PREX validation",
            BTreeMap::from([
                ("valid".into(), json!(true)),
                ("validationScope".into(), json!("represented-prex-ir")),
            ]),
        ),
        _ => (
            "independent proof check",
            BTreeMap::from([("valid".into(), json!(true))]),
        ),
    };
    nodes.push(ExplanationNode {
        id: "proof-check".into(),
        kind: "proof".into(),
        label: proof_label.into(),
        data: proof_data,
    });
    let mut edges: Vec<_> = proof
        .requirement_witnesses
        .iter()
        .flat_map(|witness| {
            witness
                .witness_node_ids
                .iter()
                .map(move |node| ExplanationEdge {
                    from: format!("requirement:{}", witness.requirement_id),
                    to: node.clone(),
                    kind: "satisfied-by".into(),
                })
        })
        .collect();
    edges.extend(
        solution
            .selected_node_ids
            .iter()
            .map(|node| ExplanationEdge {
                from: node.clone(),
                to: "proof-check".into(),
                kind: "checked-by".into(),
            }),
    );
    edges.extend(
        proof
            .objective_evidence
            .iter()
            .map(|check| ExplanationEdge {
                from: format!("objective:{}", check.id),
                to: "proof-check".into(),
                kind: "checked-by".into(),
            }),
    );
    edges.extend(
        solution
            .semantic_loss
            .iter()
            .enumerate()
            .map(|(index, _)| ExplanationEdge {
                from: format!("semantic-loss:{index}"),
                to: "proof-check".into(),
                kind: "derived-from".into(),
            }),
    );
    ExplanationGraph {
        nodes,
        edges,
        roots: input
            .request
            .requirements
            .iter()
            .map(|r| format!("requirement:{}", r.id))
            .collect(),
        unsat_core: Vec::new(),
        render_hints: None,
    }
}

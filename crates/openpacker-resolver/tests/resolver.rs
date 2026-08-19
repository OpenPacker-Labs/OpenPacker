use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

use openpacker_resolver::*;
use serde_json::{Value, json};

fn digest(byte: char) -> Digest {
    Digest {
        algorithm: "sha256".into(),
        value: byte.to_string().repeat(64),
    }
}

fn source() -> Value {
    json!({"type":"metadata","uri":"https://fixtures.openpacker.dev/catalog"})
}

fn requirement(id: &str, expression: RequirementExpression, optional: bool) -> Requirement {
    Requirement {
        id: id.into(),
        depender_node_id: None,
        expression,
        kind: if optional { "optional" } else { "runtime" }.into(),
        optional,
        source: source(),
        authority: "test-fixture".into(),
        raw: None,
        native_semantics: None,
        semantic_loss: Vec::new(),
    }
}

fn package(seed: char, name: &str, version: &str) -> PackageInstance {
    let canonical_purl = format!("pkg:npm/{name}");
    let exact_purl = normalize_purl(&format!("{canonical_purl}@{version}")).unwrap();
    let identity_version = exact_purl.rsplit_once('@').unwrap().1.to_owned();
    let mut package = PackageInstance {
        node_id: String::new(),
        identity: PackageIdentity {
            canonical_purl: canonical_purl.clone(),
            exact_purl: Some(exact_purl.clone()),
            purl_type: "npm".into(),
            namespace: None,
            name: name.into(),
            version: Some(identity_version.clone()),
            qualifiers: BTreeMap::new(),
            subpath: None,
            native_coordinates: Vec::new(),
            aliases: Vec::new(),
            source_refs: Vec::new(),
            publisher_refs: Vec::new(),
            external_refs: Vec::new(),
            extensions: BTreeMap::new(),
        },
        native_version: version.into(),
        normalized_version: identity_version.clone(),
        version_sort_key: identity_version,
        requirements: Vec::new(),
        capabilities: Vec::new(),
        conflicts: Vec::new(),
        cardinality_constraints: Vec::new(),
        artifacts: Vec::new(),
        lifecycle: LifecycleState {
            status: LifecycleStatus::Published,
            eligible: true,
            warnings: Vec::new(),
            derivation_event_ids: Vec::new(),
        },
        source_snapshots: vec![digest('c')],
        metadata_digest: digest(seed),
        raw_metadata_ref: None,
        native_semantics: json!({"version":"1","data":{}}),
        semantic_loss: Vec::new(),
        extensions: BTreeMap::new(),
    };
    package.node_id = digest_json(&json!({
        "identity": { "exactPurl": exact_purl, "qualifiers": {} },
        "nativeSemantics": { "version": "1" },
    }))
    .unwrap()
    .as_string();
    package
}

fn set_identity(package: &mut PackageInstance, kind: &str, name: &str, version: &str) {
    let exact_purl = normalize_purl(&format!("pkg:{kind}/{name}@{version}")).unwrap();
    package.identity.canonical_purl = normalize_purl(&format!("pkg:{kind}/{name}")).unwrap();
    package.identity.exact_purl = Some(exact_purl.clone());
    package.identity.purl_type = kind.into();
    package.identity.namespace = None;
    package.identity.name = name.into();
    package.identity.version = Some(exact_purl.rsplit_once('@').unwrap().1.to_owned());
    package.identity.qualifiers.clear();
    package.identity.subpath = None;
    package.normalized_version = package.identity.version.clone().unwrap();
    package.version_sort_key = package.normalized_version.clone();
    package.node_id = digest_json(&json!({
        "identity": { "exactPurl": exact_purl, "qualifiers": {} },
        "nativeSemantics": { "version": "1" },
    }))
    .unwrap()
    .as_string();
}

fn input(packages: Vec<PackageInstance>, requirements: Vec<Requirement>) -> SolveInput {
    let mut input = SolveInput {
        request: SolveRequest {
            platforms: None,
            requirement_kind_policy: None,
            requirements,
            target: TargetContext {
                os: Some("linux".into()),
                architecture: Some("arm64".into()),
                ..TargetContext::default()
            },
            environment: Environment::default(),
            policy: PolicyInput {
                allow_yanked: false,
                allow_quarantined: false,
                semantic_loss_maximum: "warning".into(),
                required_evidence: Vec::new(),
                accepted_overlay_authorities: vec!["test-fixture".into()],
                accepted_amendment_authorities: Vec::new(),
                accepted_amendment_digests: Vec::new(),
                extensions: BTreeMap::new(),
            },
            semantics: SemanticsInput {
                profile: "prex-calculus-subset-v1".into(),
                native_compatibility: vec!["npm".into(), "cargo".into(), "nuget".into()],
                extensions: BTreeMap::new(),
            },
            objectives: vec![
                "satisfy-hard-constraints".into(),
                "minimize-package-count".into(),
                "exclude-lifecycle-denied".into(),
                "prefer-stable".into(),
                "prefer-highest-native-version".into(),
                "canonical-lexical-tie-break".into(),
            ],
            mode: "closure".into(),
            evaluation_time: "2026-08-02T00:00:00Z".into(),
            provider_policy: None,
            timeout_milliseconds: None,
            resource_limits: None,
            context: None,
            extensions: BTreeMap::new(),
        },
        universe: ResolutionUniverse {
            universe_version: "1".into(),
            packages,
            overlays: Vec::new(),
            source_snapshots: Vec::new(),
            recipes: Vec::new(),
            amendments: Vec::new(),
            lifecycle_root: digest('d'),
            target_vocabulary_version: "1".into(),
            canonical_digest: digest('e'),
            extensions: BTreeMap::new(),
        },
    };
    input.universe.canonical_digest = digest_projection(&input.universe, "universe-v1").unwrap();
    input
}

fn pin_amendments(input: &mut SolveInput) {
    input.request.policy.accepted_amendment_digests = input
        .universe
        .amendments
        .iter()
        .map(|amendment| digest_json(amendment).unwrap())
        .collect();
    refresh_universe_digest(input);
}

fn refresh_universe_digest(input: &mut SolveInput) {
    input.universe.canonical_digest = digest_projection(&input.universe, "universe-v1").unwrap();
}

#[test]
fn resolvo_default_matches_oracle_and_is_deterministic() {
    let one = package('1', "demo", "1.0.0");
    let two = package('2', "demo", "2.0.0");
    let mut input = input(
        vec![one, two.clone()],
        vec![requirement(
            "root",
            RequirementExpression::Package {
                purl: "pkg:npm/demo".into(),
                vers: Some("vers:npm/>=1.0.0".into()),
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    input.request.context = Some(json!({ "idempotencyKey": "solve-nonce" }));
    input.request.resource_limits = Some(json!({ "graphNodes": 1000 }));
    let first = solve(&input).unwrap();
    let second = solve(&input).unwrap();
    assert_eq!(first, second);
    assert_eq!(first.normalized_request.context, input.request.context);
    assert_eq!(
        first.normalized_request.resource_limits,
        input.request.resource_limits
    );
    assert_eq!(first.solution.selected_node_ids, vec![two.node_id]);
    assert_eq!(
        brute_force_oracle(&input).unwrap().selected_node_ids,
        first.solution.selected_node_ids
    );
    assert!(check(&input, &first).unwrap().valid);
}

#[test]
fn companion_enforces_capability_target_conflict_cardinality_and_optional() {
    let mut app = package('3', "app", "1.0.0");
    app.requirements.push(requirement(
        "compression",
        RequirementExpression::Capability {
            name: "compression/zstd".into(),
            vers: Some("vers:generic/>=1".into()),
            attributes: BTreeMap::new(),
        },
        false,
    ));
    app.requirements.push(requirement(
        "optional-missing",
        RequirementExpression::Package {
            purl: "pkg:npm/missing".into(),
            vers: None,
            qualifiers: BTreeMap::new(),
        },
        true,
    ));
    app.conflicts.push(Conflict {
        id: "no-bad".into(),
        expression: RequirementExpression::Package {
            purl: "pkg:npm/bad".into(),
            vers: None,
            qualifiers: BTreeMap::new(),
        },
        scope: "solution".into(),
        source: source(),
    });
    app.cardinality_constraints.push(CardinalityConstraint {
        id: "one-zstd".into(),
        selector: RequirementExpression::Capability {
            name: "compression/zstd".into(),
            vers: None,
            attributes: BTreeMap::new(),
        },
        minimum: 1,
        maximum: 1,
        scope: "solution".into(),
        source: source(),
    });
    let mut cargo = package('4', "cargo-zstd", "1.0.0");
    set_identity(&mut cargo, "cargo", "zstd-wasm", "1.0.0");
    cargo.capabilities.push(Capability {
        name: "compression/zstd".into(),
        version: Some("1".into()),
        attributes: BTreeMap::new(),
        provider_node_id: cargo.node_id.clone(),
        target_predicate: Some(TargetPredicate::Equals {
            path: "architecture".into(),
            value: json!("arm64"),
        }),
        source: source(),
    });
    let mut nuget = package('5', "nuget-zstd", "2.0.0");
    nuget.capabilities.push(Capability {
        name: "compression/zstd".into(),
        version: Some("2".into()),
        attributes: BTreeMap::new(),
        provider_node_id: nuget.node_id.clone(),
        target_predicate: Some(TargetPredicate::Equals {
            path: "os".into(),
            value: json!("windows"),
        }),
        source: source(),
    });
    let bad = package('6', "bad", "9.0.0");
    let app_id = app.node_id.clone();
    let cargo_id = cargo.node_id.clone();
    let input = input(
        vec![app, cargo, nuget, bad],
        vec![requirement(
            "root",
            RequirementExpression::Package {
                purl: "pkg:npm/app".into(),
                vers: None,
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    let output = solve(&input).unwrap();
    let mut expected = vec![app_id, cargo_id];
    expected.sort();
    assert_eq!(output.solution.selected_node_ids, expected);
    let selected = serde_json::to_value(&output.selected[0]).unwrap();
    for pointer in [
        "/requirements/1/expression",
        "/conflicts/0/expression",
        "/cardinalityConstraints/0/selector",
    ] {
        assert!(selected.pointer(pointer).unwrap().get("vers").is_none());
    }
    assert!(
        output
            .proof
            .requirement_witnesses
            .iter()
            .any(|witness| witness.requirement_id == "optional-missing"
                && witness.status == "optional-omitted")
    );
    assert!(check(&input, &output).unwrap().valid);
}

#[test]
fn checker_rejects_mutated_proof_and_solution() {
    let package = package('7', "demo", "1.0.0");
    let input = input(
        vec![package],
        vec![requirement(
            "root",
            RequirementExpression::Package {
                purl: "pkg:npm/demo".into(),
                vers: None,
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    let mut output = solve(&input).unwrap();
    output.proof.selected_assignments[0].node_digest = digest('f');
    output.solution.objective_tuple[1] = json!(99);
    let result = check(&input, &output).unwrap();
    assert!(!result.valid);
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("nodeDigest"))
    );
    assert!(
        result
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("objectiveTuple"))
    );

    let original = solve(&input).unwrap();
    let mut missing_witnesses = original.clone();
    missing_witnesses.proof.requirement_witnesses.clear();
    assert!(!check(&input, &missing_witnesses).unwrap().valid);

    let mut missing_objective_evidence = original.clone();
    missing_objective_evidence.proof.objective_evidence.clear();
    assert!(!check(&input, &missing_objective_evidence).unwrap().valid);

    let mut changed_selected_object = original;
    changed_selected_object.selected[0].native_version = "999.0.0".into();
    assert!(!check(&input, &changed_selected_object).unwrap().valid);
}

#[test]
fn unknown_objectives_and_unprovable_large_optima_fail_closed() {
    let candidate = package('9', "demo", "1.0.0");
    let mut invalid_objective = input(
        vec![candidate.clone()],
        vec![requirement(
            "root",
            RequirementExpression::Package {
                purl: "pkg:npm/demo".into(),
                vers: None,
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    invalid_objective.request.objectives = vec!["solver-magic".into()];
    assert!(matches!(
        solve(&invalid_objective),
        Err(ResolverError::InvalidInput(message)) if message.contains("unsupported objective")
    ));

    let mut packages = Vec::new();
    for index in 1..=23 {
        let mut candidate = candidate.clone();
        let version = format!("{index}.0.0");
        set_identity(&mut candidate, "npm", "demo", &version);
        candidate.native_version = version.clone();
        candidate.normalized_version = version.clone();
        candidate.version_sort_key = version;
        candidate.metadata_digest = Digest {
            algorithm: "sha256".into(),
            value: format!("{index:064x}"),
        };
        packages.push(candidate);
    }
    let mut large = input(
        packages,
        vec![requirement(
            "root",
            RequirementExpression::Package {
                purl: "pkg:npm/demo".into(),
                vers: None,
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    large.request.objectives = vec!["canonical-lexical-tie-break".into()];
    assert!(matches!(
        solve(&large),
        Err(ResolverError::ObjectiveLimit {
            limit: 22,
            actual: 23
        })
    ));
}

#[test]
fn exhaustive_proof_work_fails_before_enumeration() {
    let candidate = package('9', "demo", "1.0.0");
    let mut packages = Vec::new();
    for index in 1..=22 {
        let mut candidate = candidate.clone();
        let version = format!("{index}.0.0");
        set_identity(&mut candidate, "npm", "demo", &version);
        candidate.metadata_digest = Digest {
            algorithm: "sha256".into(),
            value: format!("{index:064x}"),
        };
        packages.push(candidate);
    }
    let mut bounded = input(
        packages,
        vec![requirement(
            "root",
            RequirementExpression::Package {
                purl: "pkg:npm/demo".into(),
                vers: None,
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    bounded.request.resource_limits = Some(json!({ "graphNodes": 1_000 }));

    let started = Instant::now();
    assert!(matches!(
        solve(&bounded),
        Err(ResolverError::ExhaustiveWorkLimit {
            limit: 1_000,
            required
        }) if required > 1_000
    ));
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn lifecycle_denial_makes_exact_root_unsatisfiable() {
    let mut yanked = package('8', "demo", "1.0.0");
    yanked.lifecycle.status = LifecycleStatus::Yanked;
    yanked.lifecycle.eligible = false;
    let input = input(
        vec![yanked],
        vec![requirement(
            "root",
            RequirementExpression::Package {
                purl: "pkg:npm/demo".into(),
                vers: None,
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    assert!(matches!(
        solve(&input),
        Err(ResolverError::Unsatisfiable(_))
    ));
}

#[test]
fn terminal_unknown_and_inconsistent_lifecycle_states_fail_closed() {
    let root = requirement(
        "root",
        RequirementExpression::Package {
            purl: "pkg:npm/demo".into(),
            vers: None,
            qualifiers: BTreeMap::new(),
        },
        false,
    );
    for status in [
        LifecycleStatus::Delisted,
        LifecycleStatus::RemovedFromChannel,
        LifecycleStatus::Unknown,
    ] {
        let mut candidate = package('8', "demo", "1.0.0");
        candidate.lifecycle.status = status;
        candidate.lifecycle.eligible = false;
        assert!(matches!(
            solve(&input(vec![candidate], vec![root.clone()])),
            Err(ResolverError::Unsatisfiable(_))
        ));
    }

    let mut inconsistent = package('8', "demo", "1.0.0");
    inconsistent.lifecycle.status = LifecycleStatus::Delisted;
    assert!(matches!(
        solve(&input(vec![inconsistent], vec![root.clone()])),
        Err(ResolverError::InvalidInput(message)) if message.contains("cannot be eligible")
    ));

    let published = input(vec![package('8', "demo", "1.0.0")], vec![root]);
    let mut output = solve(&published).unwrap();
    let mut delisted = published;
    delisted.universe.packages[0].lifecycle.status = LifecycleStatus::Delisted;
    delisted.universe.packages[0].lifecycle.eligible = false;
    refresh_universe_digest(&mut delisted);
    output.universe_digest = delisted.universe.canonical_digest.clone();
    output.proof.universe_digest = output.universe_digest.clone();
    let checked = check(&delisted, &output).unwrap();
    assert!(!checked.valid);
    assert!(
        checked
            .diagnostics
            .iter()
            .any(|message| message.contains("lifecycle denied"))
    );

    assert!(
        serde_json::from_value::<LifecycleState>(json!({
            "status": "attacker-defined",
            "eligible": true,
            "warnings": []
        }))
        .is_err()
    );
}

#[test]
fn solve_and_checker_enforce_evidence_and_semantic_loss_policy() {
    let mut candidate = package('8', "demo", "1.0.0");
    candidate.semantic_loss.push(json!({
        "code": "TEST_WARNING",
        "severity": "warning"
    }));
    let mut solve_input = input(
        vec![candidate],
        vec![requirement(
            "root",
            RequirementExpression::Package {
                purl: "pkg:npm/demo".into(),
                vers: None,
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    solve_input.request.policy.semantic_loss_maximum = "info".into();
    assert!(matches!(
        solve(&solve_input),
        Err(ResolverError::Unsatisfiable(message)) if message.contains("semantic loss")
    ));

    solve_input.request.policy.semantic_loss_maximum = "warning".into();
    let output = solve(&solve_input).unwrap();
    let mut stricter = solve_input.clone();
    stricter.request.policy.semantic_loss_maximum = "info".into();
    assert!(
        check(&stricter, &output)
            .unwrap()
            .diagnostics
            .iter()
            .any(|message| message.contains("semantic loss"))
    );

    solve_input.request.policy.required_evidence = vec!["sigstore".into()];
    assert!(matches!(
        solve(&solve_input),
        Err(ResolverError::Unsatisfiable(message)) if message.contains("sigstore")
    ));
}

#[test]
fn canonical_json_is_stable_and_integer_only() {
    assert_eq!(
        canonical_json(&json!({"z":1,"a":[true,"x"]})).unwrap(),
        br#"{"a":[true,"x"],"z":1}"#
    );
    assert!(canonical_json(&json!({"notAllowed":1.5})).is_err());
}

#[test]
fn native_capture_preserves_exact_selection_without_claiming_validation() {
    let captured = package('a', "captured", "1.0.0");
    let exact_purl = captured.identity.exact_purl.clone().unwrap();
    let captured_id = captured.node_id.clone();
    let mut input = input(
        vec![captured],
        vec![requirement(
            "unrepresented-native-root",
            RequirementExpression::Package {
                purl: "pkg:npm/not-selected".into(),
                vers: None,
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    input.request.semantics.profile = "native-capture-v1".into();
    input.request.environment.locked = vec![exact_purl];

    let output = solve(&input).unwrap();
    assert_eq!(output.solution.selected_node_ids, vec![captured_id]);
    assert!(output.solution.satisfied_requirement_ids.is_empty());
    assert!(output.solution.dependency_edges.is_empty());
    assert!(
        output
            .solution
            .objective_tuple
            .iter()
            .all(|value| value == "not-evaluated")
    );
    assert!(output.proof.objective_evidence.is_empty());
    assert!(
        output
            .proof
            .requirement_witnesses
            .iter()
            .all(|witness| witness.status == "inactive" && witness.witness_node_ids.is_empty())
    );
    assert!(
        output
            .solution
            .semantic_loss
            .iter()
            .any(|loss| { loss.get("code") == Some(&json!("NATIVE_RESULT_CAPTURE_ONLY")) })
    );
    let proof_node = output
        .explanation
        .nodes
        .iter()
        .find(|node| node.id == "proof-check")
        .unwrap();
    assert_eq!(
        proof_node.data.get("validationStatus"),
        Some(&json!("not-performed"))
    );
    assert!(check(&input, &output).unwrap().valid);
}

#[test]
fn native_capture_requires_unique_resolvable_exact_locks() {
    let candidate = package('b', "captured", "1.0.0");
    let node_id = candidate.node_id.clone();
    let exact_purl = candidate.identity.exact_purl.clone().unwrap();
    let mut native = input(vec![candidate.clone()], Vec::new());
    native.request.semantics.profile = "native-capture-v1".into();

    assert!(matches!(
        solve(&native),
        Err(ResolverError::InvalidInput(message)) if message.contains("at least one")
    ));
    native.request.environment.locked = vec!["pkg:npm/missing@1.0.0".into()];
    assert!(matches!(
        solve(&native),
        Err(ResolverError::InvalidInput(message)) if message.contains("does not resolve")
    ));
    native.request.environment.locked = vec![node_id, exact_purl.clone()];
    assert!(matches!(
        solve(&native),
        Err(ResolverError::InvalidInput(message)) if message.contains("duplicate node")
    ));

    let duplicate_identity = package('c', "captured", "1.0.0");
    native.universe.packages.push(duplicate_identity);
    native.request.environment.locked = vec![exact_purl];
    assert!(matches!(
        solve(&native),
        Err(ResolverError::InvalidInput(message)) if message.contains("duplicate nodeId")
    ));
}

#[test]
fn universe_rejects_asserted_node_ids_and_contradictory_identity_fields() {
    let mut forged_node = package('1', "victim", "1.0.0");
    forged_node.node_id = format!("sha256:{}", "a".repeat(64));
    assert!(matches!(
        validate_universe(&input(vec![forged_node], Vec::new()).universe),
        Err(ResolverError::InvalidInput(message)) if message.contains("package-node-v1")
    ));

    let mut contradictory = package('2', "victim", "1.0.0");
    contradictory.identity.name = "attacker".into();
    assert!(matches!(
        validate_universe(&input(vec![contradictory], Vec::new()).universe),
        Err(ResolverError::InvalidInput(message)) if message.contains("name contradicts")
    ));

    let mut forged_version = package('3', "victim", "1.0.0");
    forged_version.normalized_version = "9.9.9".into();
    assert!(matches!(
        validate_universe(&input(vec![forged_version], Vec::new()).universe),
        Err(ResolverError::InvalidInput(message)) if message.contains("normalizedVersion contradicts")
    ));

    let mut forged_sort = package('4', "victim", "1.0.0");
    forged_sort.version_sort_key = "999999999999".into();
    assert!(matches!(
        validate_universe(&input(vec![forged_sort], Vec::new()).universe),
        Err(ResolverError::InvalidInput(message)) if message.contains("versionSortKey contradicts")
    ));
}

#[test]
fn universe_rejects_non_canonical_or_versionless_exact_purls() {
    // A version-less exactPurl is not exact identity at all.
    let mut versionless = package('5', "victim", "1.0.0");
    versionless.identity.exact_purl = Some("pkg:npm/victim".into());
    assert!(matches!(
        validate_universe(&input(vec![versionless], Vec::new()).universe),
        Err(ResolverError::InvalidInput(message)) if message.contains("canonical and versioned")
    ));

    // A non-canonical exactPurl (uppercase name canonicalizes to lowercase)
    // must not be silently normalized into an accepted identity.
    let mut non_canonical = package('6', "victim", "1.0.0");
    non_canonical.identity.exact_purl = Some("pkg:npm/Victim@1.0.0".into());
    assert!(matches!(
        validate_universe(&input(vec![non_canonical], Vec::new()).universe),
        Err(ResolverError::InvalidInput(message)) if message.contains("canonical and versioned")
    ));
}

#[test]
fn universe_rejects_a_canonical_digest_unrelated_to_its_contents() {
    let mut universe = input(vec![package('5', "victim", "1.0.0")], Vec::new()).universe;
    universe.target_vocabulary_version = "attacker".into();
    assert!(matches!(
        validate_universe(&universe),
        Err(ResolverError::InvalidInput(message)) if message.contains("universe-v1")
    ));
}

#[test]
fn native_validated_checks_represented_constraints_without_optimizing() {
    let selected = package('d', "captured", "1.0.0");
    let selected_id = selected.node_id.clone();
    let mut valid = input(
        vec![selected],
        vec![requirement(
            "root",
            RequirementExpression::Package {
                purl: "pkg:npm/captured".into(),
                vers: Some("vers:npm/>=1.0.0".into()),
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    valid.request.semantics.profile = "native-validated-v1".into();
    valid.request.environment.locked = vec![selected_id];
    valid.request.requirements[0].native_semantics =
        Some(json!({"version":"npm-v1","peerOptional":false}));

    let output = solve(&valid).unwrap();
    assert_eq!(
        output.solution.satisfied_requirement_ids,
        vec!["root".to_string()]
    );
    assert!(output.proof.objective_evidence.is_empty());
    assert!(
        output
            .solution
            .objective_tuple
            .iter()
            .all(|value| value == "not-evaluated")
    );
    assert!(
        output
            .solution
            .semantic_loss
            .iter()
            .any(|loss| { loss.get("code") == Some(&json!("NATIVE_SEMANTICS_NOT_VALIDATED")) })
    );
    assert!(output.solution.semantic_loss.iter().any(|loss| {
        loss.get("sourcePath") == Some(&json!("/request/requirements/root/nativeSemantics"))
    }));
    assert!(
        !output
            .solution
            .semantic_loss
            .iter()
            .any(|loss| { loss.get("code") == Some(&json!("NATIVE_RESULT_CAPTURE_ONLY")) })
    );
    assert!(check(&valid, &output).unwrap().valid);

    let mut invalid = valid;
    invalid.request.requirements[0].expression = RequirementExpression::Package {
        purl: "pkg:npm/missing".into(),
        vers: None,
        qualifiers: BTreeMap::new(),
    };
    assert!(matches!(
        solve(&invalid),
        Err(ResolverError::InvalidProof(message))
            if message.contains("failed represented PREX validation")
                && message.contains("root requirement root is unsatisfied")
    ));
}

#[test]
fn native_validated_rejects_dependency_conflict_cardinality_target_and_lifecycle_failures() {
    let mut app = package('e', "app", "1.0.0");
    app.requirements.push(requirement(
        "needs-compression",
        RequirementExpression::Capability {
            name: "compression/zstd".into(),
            vers: None,
            attributes: BTreeMap::new(),
        },
        false,
    ));
    app.conflicts.push(Conflict {
        id: "reject-bad".into(),
        expression: RequirementExpression::Package {
            purl: "pkg:npm/bad".into(),
            vers: None,
            qualifiers: BTreeMap::new(),
        },
        scope: "solution".into(),
        source: source(),
    });
    app.cardinality_constraints.push(CardinalityConstraint {
        id: "exactly-one-compressor".into(),
        selector: RequirementExpression::Capability {
            name: "compression/zstd".into(),
            vers: None,
            attributes: BTreeMap::new(),
        },
        minimum: 1,
        maximum: 1,
        scope: "solution".into(),
        source: source(),
    });
    let mut provider = package('f', "provider", "1.0.0");
    provider.capabilities.push(Capability {
        name: "compression/zstd".into(),
        version: Some("1".into()),
        attributes: BTreeMap::new(),
        provider_node_id: provider.node_id.clone(),
        target_predicate: Some(TargetPredicate::Equals {
            path: "architecture".into(),
            value: json!("arm64"),
        }),
        source: source(),
    });
    let bad = package('0', "bad", "1.0.0");
    let app_id = app.node_id.clone();
    let provider_id = provider.node_id.clone();
    let bad_id = bad.node_id.clone();
    let mut base = input(vec![app, provider, bad], Vec::new());
    base.request.semantics.profile = "native-validated-v1".into();
    base.request.environment.locked = vec![app_id.clone(), provider_id.clone()];
    assert!(solve(&base).is_ok());

    let mut missing_dependency = base.clone();
    missing_dependency.request.environment.locked = vec![app_id.clone()];
    assert!(matches!(
        solve(&missing_dependency),
        Err(ResolverError::InvalidProof(message))
            if message.contains("needs-compression")
                && message.contains("exactly-one-compressor")
    ));

    let mut conflict = base.clone();
    conflict.request.environment.locked.push(bad_id);
    assert!(matches!(
        solve(&conflict),
        Err(ResolverError::InvalidProof(message)) if message.contains("reject-bad")
    ));

    let mut wrong_target = base.clone();
    wrong_target.request.target.architecture = Some("x86_64".into());
    assert!(matches!(
        solve(&wrong_target),
        Err(ResolverError::InvalidProof(message)) if message.contains("needs-compression")
    ));

    let mut denied_lifecycle = base;
    let provider = denied_lifecycle
        .universe
        .packages
        .iter_mut()
        .find(|package| package.node_id == provider_id)
        .unwrap();
    provider.lifecycle.status = LifecycleStatus::Yanked;
    provider.lifecycle.eligible = false;
    refresh_universe_digest(&mut denied_lifecycle);
    assert!(matches!(
        solve(&denied_lifecycle),
        Err(ResolverError::InvalidProof(message)) if message.contains("lifecycle denied")
    ));
}

#[test]
fn unaccepted_amendments_do_not_change_the_solution() {
    let one = package('1', "demo", "1.0.0");
    let two = package('2', "demo", "2.0.0");
    let requirements = vec![requirement(
        "root",
        RequirementExpression::Package {
            purl: "pkg:npm/demo".into(),
            vers: Some("vers:npm/>=1.0.0".into()),
            qualifiers: BTreeMap::new(),
        },
        false,
    )];
    let plain = input(vec![one.clone(), two.clone()], requirements.clone());
    let mut amended = input(vec![one.clone(), two.clone()], requirements);
    amended.universe.amendments.push(UniverseAmendment {
        amendment_version: "1".into(),
        subject: serde_json::to_value(&one.identity).unwrap(),
        applies_to_metadata_digest: one.metadata_digest.clone(),
        operations: vec![
            json!({"op":"retractRequirement","requirementId":"root","justification":"test"}),
        ],
        authority: "organization".into(),
        rest: BTreeMap::new(),
    });
    amended
        .request
        .policy
        .accepted_amendment_authorities
        .push("organization".into());
    refresh_universe_digest(&mut amended);

    let plain_output = solve(&plain).unwrap();
    let amended_output = solve(&amended).unwrap();

    // A matching asserted authority without an independently pinned digest
    // grants no power: the solution and its digest are byte-identical.
    assert_eq!(
        amended_output.solution.solution_digest,
        plain_output.solution.solution_digest
    );
    assert_eq!(
        amended_output.solution.selected_node_ids,
        plain_output.solution.selected_node_ids
    );
    // The fact that an amendment was present and ignored is still recorded.
    assert!(
        amended_output
            .explanation
            .nodes
            .iter()
            .any(|node| node.kind == "amendment-ignored")
    );
    assert!(
        !plain_output
            .explanation
            .nodes
            .iter()
            .any(|node| node.kind == "amendment-ignored")
    );
    assert!(check(&amended, &amended_output).unwrap().valid);
}

#[test]
fn an_admitted_authority_with_a_wrong_pinned_digest_changes_nothing() {
    let one = package('1', "demo", "1.0.0");
    let two = package('2', "demo", "2.0.0");
    let requirements = vec![requirement(
        "root",
        RequirementExpression::Package {
            purl: "pkg:npm/demo".into(),
            vers: Some("vers:npm/>=1.0.0".into()),
            qualifiers: BTreeMap::new(),
        },
        false,
    )];
    let plain = input(vec![one.clone(), two.clone()], requirements.clone());
    let mut amended = input(vec![one.clone(), two.clone()], requirements);
    amended.universe.amendments.push(UniverseAmendment {
        amendment_version: "1".into(),
        subject: json!({}),
        applies_to_metadata_digest: one.metadata_digest.clone(),
        operations: vec![
            json!({"op":"retractRequirement","requirementId":"root","justification":"test"}),
        ],
        authority: "organization".into(),
        rest: BTreeMap::new(),
    });
    amended
        .request
        .policy
        .accepted_amendment_authorities
        .push("organization".into());
    // The authority is admitted, but the pin names a digest that is not this
    // amendment's canonical digest.
    amended
        .request
        .policy
        .accepted_amendment_digests
        .push(digest('9'));

    let plain_output = solve(&plain).unwrap();
    let amended_output = solve(&amended).unwrap();

    // Authority admission without a matching digest pin grants no power: the
    // solution and its digest are byte-identical to the unamended universe.
    assert_eq!(
        amended_output.solution.solution_digest,
        plain_output.solution.solution_digest
    );
    assert_eq!(
        amended_output.solution.selected_node_ids,
        plain_output.solution.selected_node_ids
    );
    // The amendment is recorded as present and ignored, never applied.
    assert!(
        amended_output
            .explanation
            .nodes
            .iter()
            .any(|node| node.kind == "amendment-ignored")
    );
    assert!(
        !amended_output
            .explanation
            .nodes
            .iter()
            .any(|node| node.kind == "amendment-applied")
    );
    assert!(amended_output.proof.applied_amendment_digests.is_empty());
    assert!(check(&amended, &amended_output).unwrap().valid);
}

#[test]
fn an_accepted_amendment_redirects_and_retracts_requirements() {
    let mut app = package('3', "app", "1.0.0");
    app.requirements.push(requirement(
        "needs-old-libc",
        RequirementExpression::Package {
            purl: "pkg:npm/libc".into(),
            vers: Some("vers:npm/2.39".into()),
            qualifiers: BTreeMap::new(),
        },
        false,
    ));
    let old_libc = package('4', "libc", "2.39");
    let patched = package('5', "libc", "2.40");

    let root = vec![requirement(
        "root",
        RequirementExpression::Package {
            purl: "pkg:npm/app".into(),
            vers: None,
            qualifiers: BTreeMap::new(),
        },
        false,
    )];
    let plain = input(
        vec![app.clone(), old_libc.clone(), patched.clone()],
        root.clone(),
    );
    let plain_output = solve(&plain).unwrap();
    assert!(
        plain_output
            .solution
            .selected_node_ids
            .contains(&old_libc.node_id),
        "without an amendment the declared 2.39 requirement stands"
    );

    // The organization pins its patched libc for this package.
    let mut amended = input(vec![app.clone(), old_libc.clone(), patched.clone()], root);
    amended
        .request
        .policy
        .accepted_amendment_authorities
        .push("organization".into());
    amended.universe.amendments.push(UniverseAmendment {
        amendment_version: "1".into(),
        subject: serde_json::to_value(&app.identity).unwrap(),
        applies_to_metadata_digest: app.metadata_digest.clone(),
        operations: vec![json!({
            "op": "redirectPackage",
            "match": {"type": "package", "purl": "pkg:npm/libc", "vers": "vers:npm/2.39"},
            "to": {"type": "package", "purl": "pkg:npm/libc", "vers": "vers:npm/2.40"},
        })],
        authority: "organization".into(),
        rest: BTreeMap::new(),
    });
    pin_amendments(&mut amended);
    let output = solve(&amended).unwrap();

    assert!(
        output.solution.selected_node_ids.contains(&patched.node_id),
        "the redirect must move the selection to the patched libc"
    );
    assert!(
        !output
            .solution
            .selected_node_ids
            .contains(&old_libc.node_id)
    );
    assert_ne!(
        output.solution.solution_digest,
        plain_output.solution.solution_digest
    );

    // The change is recorded, not silent.
    assert_eq!(output.proof.applied_amendment_digests.len(), 1);
    assert!(
        output
            .explanation
            .nodes
            .iter()
            .any(|node| node.kind == "amendment-applied")
    );
    let superseded = output.selected.iter().any(|package| {
        package.requirements.iter().any(|requirement| {
            requirement.semantic_loss.iter().any(|loss| {
                loss.get("code").and_then(|value| value.as_str()) == Some("NATIVE_FACT_SUPERSEDED")
            })
        })
    });
    assert!(superseded, "an applied amendment must record semantic loss");

    // The independent checker re-derives the amendment and agrees.
    assert!(check(&amended, &output).unwrap().valid);
}

#[test]
fn a_retraction_removes_an_unsatisfiable_requirement() {
    let mut app = package('3', "app", "1.0.0");
    app.requirements.push(requirement(
        "needs-absent",
        RequirementExpression::Package {
            purl: "pkg:npm/absent".into(),
            vers: None,
            qualifiers: BTreeMap::new(),
        },
        false,
    ));
    let root = vec![requirement(
        "root",
        RequirementExpression::Package {
            purl: "pkg:npm/app".into(),
            vers: None,
            qualifiers: BTreeMap::new(),
        },
        false,
    )];
    assert!(solve(&input(vec![app.clone()], root.clone())).is_err());

    let mut amended = input(vec![app.clone()], root);
    amended
        .request
        .policy
        .accepted_amendment_authorities
        .push("organization".into());
    amended.universe.amendments.push(UniverseAmendment {
        amendment_version: "1".into(),
        subject: serde_json::to_value(&app.identity).unwrap(),
        applies_to_metadata_digest: app.metadata_digest.clone(),
        operations: vec![json!({
            "op": "retractRequirement",
            "requirementId": "needs-absent",
            "justification": "not applicable to this deployment",
        })],
        authority: "organization".into(),
        rest: BTreeMap::new(),
    });
    pin_amendments(&mut amended);
    let output = solve(&amended).unwrap();
    let checked = check(&amended, &output).unwrap();
    assert!(checked.valid, "{:?}", checked.diagnostics);
    assert_eq!(output.proof.applied_amendment_digests.len(), 1);
}

#[test]
fn the_amended_universe_digest_is_universe_v1_over_the_whole_struct() {
    // Guards the field set: a universe field added without updating the digest
    // computation would leave this equal to the hand-derived value below.
    let mut one = package('1', "demo", "1.0.0");
    // Amendments act on the subject package's own requirements.
    one.requirements.push(requirement(
        "demo-optional-extra",
        RequirementExpression::Package {
            purl: "pkg:npm/absent".into(),
            vers: None,
            qualifiers: BTreeMap::new(),
        },
        true,
    ));
    let mut amended = input(
        vec![one.clone()],
        vec![requirement(
            "root",
            RequirementExpression::Package {
                purl: "pkg:npm/demo".into(),
                vers: None,
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    amended
        .request
        .policy
        .accepted_amendment_authorities
        .push("organization".into());
    amended.universe.amendments.push(UniverseAmendment {
        amendment_version: "1".into(),
        subject: serde_json::to_value(&one.identity).unwrap(),
        applies_to_metadata_digest: one.metadata_digest.clone(),
        operations: vec![json!({
            "op": "retractRequirement",
            "requirementId": "demo-optional-extra",
            "justification": "not applicable",
        })],
        authority: "organization".into(),
        rest: BTreeMap::new(),
    });
    pin_amendments(&mut amended);

    let applied = apply_amendments(&amended).unwrap();
    // Recompute independently: serialize the amended universe, drop the
    // self-referential digest, canonicalize the declared set paths.
    let mut expected = serde_json::to_value(&applied.input.universe).unwrap();
    let object = expected.as_object_mut().unwrap();
    object.remove("canonicalDigest");
    for path in [
        "amendments",
        "overlays",
        "packages",
        "recipes",
        "sourceSnapshots",
    ] {
        if let Some(Value::Array(items)) = object.get_mut(path) {
            // Sorted the way the specification says — canonical JSON, UTF-16
            // code units — rather than by `to_string`, which is a third
            // serialization that agrees with neither.
            items.sort_by_key(|item| {
                String::from_utf8(canonical_json(item).unwrap())
                    .unwrap()
                    .encode_utf16()
                    .collect::<Vec<u16>>()
            });
        }
    }
    let recomputed = digest_json(&expected).unwrap();
    assert_eq!(applied.input.universe.canonical_digest, recomputed);
    // And it must differ from the universe it was derived from.
    assert_ne!(
        applied.input.universe.canonical_digest,
        amended.universe.canonical_digest
    );
}

#[test]
fn amended_universe_ordered_sets_sort_by_utf16_code_units() {
    // The sibling test above has one element per ordered set, so it pins the
    // field set but never the sort. This pins the sort, and specifically its
    // collation: `canonical.rs` already sorts object *names* by UTF-16 code
    // units to match ECMAScript, and array ordered sets must agree or this
    // crate's universe digest disagrees with every other implementation.
    //
    // U+10000 is above the BMP. As UTF-8 it is F0 90 80 80 and so follows
    // U+E000 (EE 80 80); as UTF-16 it is the surrogate pair D800 DC00 and so
    // precedes it. The two collations put these two overlays in opposite
    // orders, which is exactly the disagreement being pinned.
    let mut one = package('1', "demo", "1.0.0");
    one.requirements.push(requirement(
        "demo-optional-extra",
        RequirementExpression::Package {
            purl: "pkg:npm/absent".into(),
            vers: None,
            qualifiers: BTreeMap::new(),
        },
        true,
    ));
    let mut amended = input(
        vec![one.clone()],
        vec![requirement(
            "root",
            RequirementExpression::Package {
                purl: "pkg:npm/demo".into(),
                vers: None,
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    let astral = json!({ "id": "\u{10000}" });
    let private_use = json!({ "id": "\u{E000}" });
    // Inserted in the order a byte sort would already consider correct, so a
    // byte-sorting implementation leaves them alone and lands on the wrong
    // order rather than accidentally on the right one.
    amended.universe.overlays = vec![private_use.clone(), astral.clone()];
    amended
        .request
        .policy
        .accepted_amendment_authorities
        .push("organization".into());
    amended.universe.amendments.push(UniverseAmendment {
        amendment_version: "1".into(),
        subject: serde_json::to_value(&one.identity).unwrap(),
        applies_to_metadata_digest: one.metadata_digest.clone(),
        operations: vec![json!({
            "op": "retractRequirement",
            "requirementId": "demo-optional-extra",
            "justification": "not applicable",
        })],
        authority: "organization".into(),
        rest: BTreeMap::new(),
    });
    pin_amendments(&mut amended);

    let applied = apply_amendments(&amended).unwrap();

    // Build both candidate orderings and require the UTF-16 one.
    let digest_with = |overlays: Vec<Value>| {
        let mut value = serde_json::to_value(&applied.input.universe).unwrap();
        let object = value.as_object_mut().unwrap();
        object.remove("canonicalDigest");
        object.insert("overlays".into(), Value::Array(overlays));
        digest_json(&value).unwrap()
    };
    let utf16_order = digest_with(vec![astral.clone(), private_use.clone()]);
    let utf8_order = digest_with(vec![private_use, astral]);
    assert_ne!(
        utf16_order, utf8_order,
        "the two collations must disagree, or this test proves nothing"
    );
    assert_eq!(applied.input.universe.canonical_digest, utf16_order);
}

#[test]
fn a_forged_amendment_claim_is_rejected() {
    let one = package('1', "demo", "1.0.0");
    let solve_input = input(
        vec![one],
        vec![requirement(
            "root",
            RequirementExpression::Package {
                purl: "pkg:npm/demo".into(),
                vers: None,
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    let mut output = solve(&solve_input).unwrap();
    // Claiming an amendment was applied when the policy admitted none must not
    // pass the checker.
    output.proof.applied_amendment_digests.push(digest('9'));
    assert!(!check(&solve_input, &output).unwrap().valid);
}

#[test]
fn amendments_must_bind_to_a_real_package() {
    let one = package('1', "demo", "1.0.0");
    let mut amended = input(
        vec![one],
        vec![requirement(
            "root",
            RequirementExpression::Package {
                purl: "pkg:npm/demo".into(),
                vers: None,
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    amended.universe.amendments.push(UniverseAmendment {
        amendment_version: "1".into(),
        subject: serde_json::to_value(&amended.universe.packages[0].identity).unwrap(),
        applies_to_metadata_digest: digest('9'),
        operations: vec![
            json!({"op":"retractRequirement","requirementId":"root","justification":"test"}),
        ],
        authority: "organization".into(),
        rest: BTreeMap::new(),
    });
    assert!(solve(&amended).is_err());
}

#[test]
fn amendment_subject_disambiguates_a_shared_metadata_digest() {
    let first = package('1', "first", "1.0.0");
    let mut second = package('2', "second", "1.0.0");
    second.metadata_digest = first.metadata_digest.clone();
    let mut amended = input(
        vec![first.clone(), second.clone()],
        vec![requirement(
            "root",
            RequirementExpression::Package {
                purl: "pkg:npm/first".into(),
                vers: None,
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    amended.universe.amendments.push(UniverseAmendment {
        amendment_version: "1".into(),
        subject: serde_json::to_value(&second.identity).unwrap(),
        applies_to_metadata_digest: first.metadata_digest.clone(),
        operations: vec![
            json!({"op":"retractRequirement","requirementId":"root","justification":"test"}),
        ],
        authority: "organization".into(),
        rest: BTreeMap::new(),
    });
    amended.universe.amendments[0].subject =
        serde_json::to_value(&package('3', "other", "1.0.0").identity).unwrap();
    refresh_universe_digest(&mut amended);
    assert!(matches!(
        solve(&amended),
        Err(ResolverError::InvalidInput(message)) if message.contains("subject")
    ));
}

/// Requirements consumed while building resolve against the build platform,
/// and unprefixed paths follow the requirement's kind. Without these the
/// platform plumbing could be removed and every other test would still pass.
#[test]
fn build_requirements_resolve_against_the_build_platform() {
    let mut app = package('3', "app", "1.0.0");
    // A build-kind requirement whose condition names no platform: it must be
    // read against the build platform because of its kind.
    app.requirements.push(Requirement {
        kind: "build".into(),
        ..requirement(
            "needs-x86-compiler",
            RequirementExpression::Conditional {
                when: TargetPredicate::Equals {
                    path: "architecture".into(),
                    value: json!("x86_64"),
                },
                then: Box::new(RequirementExpression::Package {
                    purl: "pkg:npm/compiler".into(),
                    vers: None,
                    qualifiers: BTreeMap::new(),
                }),
                otherwise: None,
            },
            false,
        )
    });
    let compiler = package('4', "compiler", "1.0.0");

    let mut cross = input(vec![app.clone(), compiler.clone()], Vec::new());
    cross.request.target = TargetContext {
        os: Some("linux".into()),
        architecture: Some("aarch64".into()),
        ..TargetContext::default()
    };
    cross.request.platforms = Some(PlatformContexts {
        build: Some(TargetContext {
            os: Some("linux".into()),
            architecture: Some("x86_64".into()),
            ..TargetContext::default()
        }),
        host: Some(cross.request.target.clone()),
        target: None,
    });
    cross.request.requirements.push(requirement(
        "root",
        RequirementExpression::Package {
            purl: "pkg:npm/app".into(),
            vers: None,
            qualifiers: BTreeMap::new(),
        },
        false,
    ));

    // Build platform is x86_64, so the conditional is active and the compiler
    // must be selected even though the host is aarch64.
    let output = solve(&cross).unwrap();
    assert!(
        output
            .solution
            .selected_node_ids
            .contains(&compiler.node_id),
        "build-kind requirement must resolve against the build platform"
    );
    assert!(check(&cross, &output).unwrap().valid);

    // Same universe, single platform aarch64: the conditional is inactive, so
    // the compiler is not pulled in.
    let mut host_only = input(vec![app, compiler.clone()], Vec::new());
    host_only.request.target = TargetContext {
        os: Some("linux".into()),
        architecture: Some("aarch64".into()),
        ..TargetContext::default()
    };
    host_only.request.requirements.push(requirement(
        "root",
        RequirementExpression::Package {
            purl: "pkg:npm/app".into(),
            vers: None,
            qualifiers: BTreeMap::new(),
        },
        false,
    ));
    let host_output = solve(&host_only).unwrap();
    assert!(
        !host_output
            .solution
            .selected_node_ids
            .contains(&compiler.node_id)
    );
}

/// Explicit platform prefixes override the requirement's kind default, and
/// each prefix reaches its own context.
#[test]
fn platform_prefixed_predicates_select_their_context() {
    let build = TargetContext {
        os: Some("linux".into()),
        architecture: Some("x86_64".into()),
        ..TargetContext::default()
    };
    let host = TargetContext {
        os: Some("darwin".into()),
        architecture: Some("aarch64".into()),
        ..TargetContext::default()
    };
    let emit = TargetContext {
        os: Some("windows".into()),
        architecture: Some("aarch64".into()),
        ..TargetContext::default()
    };
    let platforms = PlatformView::new(&build, &host, &emit);

    for (path, expected) in [
        ("build.os", "linux"),
        ("host.os", "darwin"),
        ("target.os", "windows"),
        // Unprefixed resolves against the view's default, which is the host.
        ("os", "darwin"),
    ] {
        assert!(
            evaluate_target_predicate_in(
                &TargetPredicate::Equals {
                    path: path.into(),
                    value: json!(expected),
                },
                platforms,
            ),
            "{path} must resolve to {expected}"
        );
    }

    // Defaulting to build moves only unprefixed paths.
    let build_default = platforms.defaulting_to_build();
    assert!(evaluate_target_predicate_in(
        &TargetPredicate::Equals {
            path: "os".into(),
            value: json!("linux"),
        },
        build_default,
    ));
    assert!(evaluate_target_predicate_in(
        &TargetPredicate::Equals {
            path: "host.os".into(),
            value: json!("darwin"),
        },
        build_default,
    ));
}

#[test]
fn platform_host_must_equal_the_request_target() {
    let one = package('1', "demo", "1.0.0");
    let mut mismatched = input(
        vec![one],
        vec![requirement(
            "root",
            RequirementExpression::Package {
                purl: "pkg:npm/demo".into(),
                vers: None,
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    mismatched.request.platforms = Some(PlatformContexts {
        build: None,
        host: Some(TargetContext {
            os: Some("windows".into()),
            ..TargetContext::default()
        }),
        target: None,
    });
    assert!(solve(&mismatched).is_err());
}

#[test]
fn inactive_requirement_kinds_are_dropped_from_the_solve() {
    let mut app = package('3', "app", "1.0.0");
    app.requirements.push(Requirement {
        kind: "development".into(),
        ..requirement(
            "dev-only",
            RequirementExpression::Package {
                purl: "pkg:npm/absent".into(),
                vers: None,
                qualifiers: BTreeMap::new(),
            },
            false,
        )
    });
    let mut solve_input = input(
        vec![app],
        vec![requirement(
            "root",
            RequirementExpression::Package {
                purl: "pkg:npm/app".into(),
                vers: None,
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    // The development requirement cannot be satisfied by this universe.
    assert!(solve(&solve_input).is_err());

    // Marking the kind inactive removes it from consideration entirely.
    solve_input.request.requirement_kind_policy = Some(RequirementKindPolicy {
        build_platform_kinds: None,
        inactive_kinds: Some(vec!["development".into()]),
    });
    let output = solve(&solve_input).unwrap();
    assert!(check(&solve_input, &output).unwrap().valid);
    // Suppression must be visible: a consumer reading the solution alone would
    // otherwise never learn a hard requirement was dropped.
    let suppressed: Vec<_> = output
        .explanation
        .nodes
        .iter()
        .filter(|node| node.kind == "requirement-suppressed")
        .collect();
    assert_eq!(suppressed.len(), 1);
    assert_eq!(
        suppressed[0].data.get("requirementId"),
        Some(&json!("dev-only"))
    );
}

#[test]
fn misspelled_requirement_kinds_are_rejected_without_platforms() {
    let one = package('1', "demo", "1.0.0");
    let mut solve_input = input(
        vec![one],
        vec![requirement(
            "root",
            RequirementExpression::Package {
                purl: "pkg:npm/demo".into(),
                vers: None,
                qualifiers: BTreeMap::new(),
            },
            false,
        )],
    );
    // No platforms supplied, but the policy is still consulted, so a typo must
    // not quietly no-op.
    solve_input.request.requirement_kind_policy = Some(RequirementKindPolicy {
        build_platform_kinds: None,
        inactive_kinds: Some(vec!["runtim".into()]),
    });
    assert!(solve(&solve_input).is_err());
}

/// Normalization must work for every PURL type, not only the three that used
/// to be hard-coded, and must not coerce versions it does not understand.
#[test]
fn normalization_covers_every_purl_type() {
    // Unchanged behaviour for the originally supported types.
    assert_eq!(
        normalize_purl("pkg:NPM/%40OpenPacker/Demo-Tool@v1.0").unwrap(),
        "pkg:npm/%40openpacker/demo-tool@1.0.0"
    );
    assert_eq!(
        normalize_purl("pkg:cargo/Demo-Zstd@1.0").unwrap(),
        "pkg:cargo/demo-zstd@1.0.0"
    );
    assert_eq!(
        normalize_purl("pkg:nuget/Demo.Tool@1.2.3").unwrap(),
        "pkg:nuget/demo.tool@1.2.3"
    );

    // PEP 503 name folding; PEP 440 versions are preserved, not coerced.
    assert_eq!(
        normalize_purl("pkg:pypi/Demo_Tool.Extra@2024.1rc1").unwrap(),
        "pkg:pypi/demo-tool-extra@2024.1rc1"
    );

    // Go module paths are lowercased; pseudo-versions survive intact.
    assert_eq!(
        normalize_purl("pkg:golang/GitHub.com/Example/Mod@v0.0.0-20260101120000-abcdefabcdef")
            .unwrap(),
        "pkg:golang/github.com/example/mod@v0.0.0-20260101120000-abcdefabcdef"
    );

    // Maven coordinates are case sensitive.
    assert_eq!(
        normalize_purl("pkg:maven/org.Example/DemoTool@1.0.0-RC1").unwrap(),
        "pkg:maven/org.Example/DemoTool@1.0.0-RC1"
    );

    // A Nix store output keeps its qualifiers and its non-semver version.
    let nix = normalize_purl("pkg:nix/libGreet@2405?output=dev&outhash=b3f2q8xr").unwrap();
    assert!(nix.starts_with("pkg:nix/libGreet@2405"), "{nix}");
    assert!(nix.contains("outhash=b3f2q8xr"), "{nix}");
    assert!(nix.contains("output=dev"), "{nix}");

    // An unknown type normalizes rather than erroring: canonical encoding does
    // not require knowing the ecosystem.
    assert_eq!(
        normalize_purl("pkg:deb/Debian/OpenSSL@3.0.11").unwrap(),
        "pkg:deb/Debian/OpenSSL@3.0.11"
    );

    // PEP 503 collapses runs of separators; it does not delete them at the
    // edges, and a name that normalizes to nothing is an error rather than a
    // PURL that cannot be re-parsed.
    assert_eq!(
        normalize_purl("pkg:pypi/_Demo__Tool_@1.0").unwrap(),
        "pkg:pypi/-demo-tool-@1.0"
    );
    assert!(normalize_purl("pkg:pypi/___@1.0").is_err());
    // Normalization is idempotent for every type it accepts.
    for purl in [
        "pkg:npm/%40openpacker/demo-tool@1.0.0",
        "pkg:pypi/demo-tool@2024.1rc1",
        "pkg:maven/org.Example/DemoTool@1.0.0-RC1",
        "pkg:deb/Debian/OpenSSL@3.0.11",
    ] {
        let once = normalize_purl(purl).unwrap();
        assert_eq!(normalize_purl(&once).unwrap(), once, "{purl}");
    }

    // A malformed type is rejected here, not merely downstream: the library,
    // the daemon, and the schema pattern must agree on what a PURL type is.
    for purl in ["pkg:DEB!/x@1", "pkg:  /x@1", "pkg:%41%42/x@1"] {
        assert!(normalize_purl(purl).is_err(), "{purl}");
    }
    // Types the spec does allow still work, and the type is case insensitive.
    assert_eq!(
        normalize_purl("pkg:my-eco.v2+ext/x@1").unwrap(),
        "pkg:my-eco.v2+ext/x@1"
    );
    assert_eq!(normalize_purl("pkg:DEB/x@1").unwrap(), "pkg:deb/x@1");

    // Namespace rules still hold where the ecosystem has none.
    assert!(normalize_purl("pkg:cargo/scope/demo@1.0.0").is_err());
    assert!(normalize_purl("pkg:npm/demo@not-a-version").is_err());
}

use openpacker_resolver::{
    SolveInput, brute_force_oracle, canonical_json, check, digest_json, digest_projection,
    normalize_purl, solve, version_satisfies,
};
use proptest::prelude::*;
use serde_json::{Value, json};

fn generated_input(versions: u8) -> SolveInput {
    let mut value: Value =
        serde_json::from_str(include_str!("../../fixtures/bounded-solve.json")).unwrap();
    let template = value["universe"]["packages"][0].clone();
    value["universe"]["packages"] = Value::Array(
        (1..=versions)
            .map(|version| {
                let mut package = template.clone();
                let exact_purl = format!("pkg:npm/demo@{version}.0.0");
                package["identity"]["exactPurl"] = json!(exact_purl);
                package["identity"]["version"] = json!(format!("{version}.0.0"));
                package["nativeVersion"] = json!(format!("{version}.0.0"));
                package["normalizedVersion"] = json!(format!("{version}.0.0"));
                package["versionSortKey"] = json!(format!("{version}.0.0"));
                package["nodeId"] = json!(
                    digest_json(&json!({
                        "identity": {
                            "exactPurl": exact_purl,
                            "qualifiers": package["identity"]["qualifiers"],
                        },
                        "nativeSemantics": {
                            "version": package["nativeSemantics"]["version"],
                        },
                    }))
                    .unwrap()
                    .as_string()
                );
                package
            })
            .collect(),
    );
    value["universe"]["canonicalDigest"] =
        serde_json::to_value(digest_projection(&value["universe"], "universe-v1").unwrap())
            .unwrap();
    serde_json::from_value(value).unwrap()
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 128,
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    #[test]
    fn purl_normalization_is_idempotent(
        scope in "[a-z][a-z0-9]{0,12}",
        name in "[a-z][a-z0-9-]{0,20}",
        major in 0_u16..100,
        minor in 0_u16..100,
        patch in 0_u16..100,
    ) {
        let input = format!("pkg:NPM/%40{scope}%2F{name}@{major}.{minor}.{patch}?B=two&a=one");
        let first = normalize_purl(&input).unwrap();
        prop_assert_eq!(normalize_purl(&first).unwrap(), first);
    }

    #[test]
    fn canonical_json_is_stable(keys in prop::collection::btree_map("[a-z]{1,8}", any::<i32>(), 0..32)) {
        let value = serde_json::to_value(keys).unwrap();
        let first = canonical_json(&value).unwrap();
        let parsed: Value = serde_json::from_slice(&first).unwrap();
        prop_assert_eq!(canonical_json(&parsed).unwrap(), first);
    }

    #[test]
    fn vers_membership_is_deterministic(
        major in 0_u16..100,
        minor in 0_u16..100,
        patch in 0_u16..100,
        lower in 0_u16..100,
    ) {
        let version = format!("{major}.{minor}.{patch}");
        let vers = format!("vers:npm/>={lower}.0.0|<100.0.0");
        prop_assert_eq!(version_satisfies(&version, &vers), version_satisfies(&version, &vers));
    }

    #[test]
    fn generated_solver_results_pass_checker_and_oracle(versions in 1_u8..8) {
        let input = generated_input(versions);
        let output = solve(&input).unwrap();
        prop_assert!(check(&input, &output).unwrap().valid);
        prop_assert_eq!(
            brute_force_oracle(&input).unwrap().selected_node_ids,
            output.solution.selected_node_ids,
        );
    }

    #[test]
    fn proof_mutations_fail_closed(versions in 1_u8..8, mutation in 0_u8..3) {
        let input = generated_input(versions);
        let mut output = solve(&input).unwrap();
        match mutation {
            0 => {
                output.proof.selected_assignments[0].selected =
                    !output.proof.selected_assignments[0].selected;
            }
            1 => output.proof.universe_digest.value = "f".repeat(64),
            _ => output.solution.objective_tuple[0] = json!(999),
        }
        prop_assert!(!check(&input, &output).unwrap().valid);
    }
}

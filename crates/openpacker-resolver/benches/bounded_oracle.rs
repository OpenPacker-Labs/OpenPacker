use std::{hint::black_box, time::Instant};

use openpacker_resolver::{SolveInput, solve};
use serde_json::json;

fn main() {
    let zero = json!({"algorithm":"sha256","value":"0".repeat(64)});
    let input: SolveInput = serde_json::from_value(json!({
        "request": {
            "requirements": [{
                "id":"root","expression":{"type":"package","purl":"pkg:npm/demo"},"kind":"runtime","optional":false,
                "source":{"type":"metadata","uri":"https://fixtures.openpacker.dev"},"authority":"test-fixture","semanticLoss":[]
            }],
            "target":{},"environment":{"installed":[],"locked":[]},
            "policy":{"allowYanked":false,"allowQuarantined":false,"semanticLossMaximum":"warning","requiredEvidence":[]},
            "semantics":{"profile":"prex-calculus-subset-v1","nativeCompatibility":["npm"]},
            "objectives":["minimize-package-count","prefer-highest-native-version","canonical-lexical-tie-break"],
            "mode":"closure","evaluationTime":"2026-08-02T00:00:00Z"
        },
        "universe": {
            "universeVersion":"1","overlays":[],"sourceSnapshots":[],"lifecycleRoot":zero,
            "targetVocabularyVersion":"1","canonicalDigest":zero,"packages":[{
                "nodeId":format!("sha256:{}", "1".repeat(64)),
                "identity":{"canonicalPurl":"pkg:npm/demo","exactPurl":"pkg:npm/demo@1.0.0","purlType":"npm","name":"demo","qualifiers":{},"nativeCoordinates":[],"aliases":[],"sourceRefs":[],"publisherRefs":[],"externalRefs":[]},
                "nativeVersion":"1.0.0","normalizedVersion":"1.0.0","versionSortKey":"0001.0000.0000",
                "requirements":[],"capabilities":[],"conflicts":[],"cardinalityConstraints":[],"artifacts":[],
                "lifecycle":{"status":"published","eligible":true,"warnings":[]},"sourceSnapshots":[],"metadataDigest":zero,
                "nativeSemantics":{"version":"1","data":{}},"semanticLoss":[]
            }]
        }
    })).expect("benchmark fixture is valid");
    let started = Instant::now();
    for _ in 0..1_000 {
        black_box(solve(black_box(&input)).expect("benchmark solve succeeds"));
    }
    println!(
        "resolvo_solve_and_oracle_1k_ns={}",
        started.elapsed().as_nanos()
    );
}

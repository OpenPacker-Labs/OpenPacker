use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type Extensions = BTreeMap<String, Value>;
pub type Scalar = Value;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Digest {
    pub algorithm: String,
    pub value: String,
}

impl Digest {
    pub fn as_string(&self) -> String {
        format!("{}:{}", self.algorithm, self.value)
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetContext {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub architecture: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub libc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kernel: Option<String>,
    #[serde(default)]
    pub runtimes: BTreeMap<String, String>,
    #[serde(default)]
    pub abi: BTreeMap<String, String>,
    #[serde(default)]
    pub capabilities: Vec<TargetCapability>,
    #[serde(default)]
    pub variables: BTreeMap<String, Scalar>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetCapability {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default)]
    pub attributes: BTreeMap<String, Scalar>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum TargetPredicate {
    True,
    False,
    Equals {
        path: String,
        value: Scalar,
    },
    NotEquals {
        path: String,
        value: Scalar,
    },
    In {
        path: String,
        values: Vec<Scalar>,
    },
    NotIn {
        path: String,
        values: Vec<Scalar>,
    },
    VersionSatisfies {
        path: String,
        constraint: VersionConstraint,
    },
    CapabilityPresent {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        constraint: Option<VersionConstraint>,
    },
    AllOf {
        predicates: Vec<TargetPredicate>,
    },
    AnyOf {
        predicates: Vec<TargetPredicate>,
    },
    Not {
        predicate: Box<TargetPredicate>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VersionConstraint {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vers: Option<String>,
    pub scheme: String,
    pub original: String,
    pub normalized: String,
    pub ast: Value,
    pub reversible: bool,
    #[serde(default)]
    pub semantic_loss: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum RequirementExpression {
    Package {
        purl: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vers: Option<String>,
        #[serde(default)]
        qualifiers: BTreeMap<String, String>,
    },
    Capability {
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vers: Option<String>,
        #[serde(default)]
        attributes: BTreeMap<String, Scalar>,
    },
    AllOf {
        expressions: Vec<RequirementExpression>,
    },
    AnyOf {
        expressions: Vec<RequirementExpression>,
    },
    Not {
        expression: Box<RequirementExpression>,
    },
    Conditional {
        when: TargetPredicate,
        then: Box<RequirementExpression>,
        #[serde(rename = "else", default, skip_serializing_if = "Option::is_none")]
        otherwise: Option<Box<RequirementExpression>>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Requirement {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depender_node_id: Option<String>,
    pub expression: RequirementExpression,
    pub kind: String,
    pub optional: bool,
    pub source: Value,
    pub authority: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_semantics: Option<Value>,
    #[serde(default)]
    pub semantic_loss: Vec<Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capability {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default)]
    pub attributes: BTreeMap<String, Scalar>,
    pub provider_node_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_predicate: Option<TargetPredicate>,
    pub source: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Conflict {
    pub id: String,
    pub expression: RequirementExpression,
    pub scope: String,
    pub source: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardinalityConstraint {
    pub id: String,
    pub selector: RequirementExpression,
    pub minimum: usize,
    pub maximum: usize,
    pub scope: String,
    pub source: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageIdentity {
    pub canonical_purl: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exact_purl: Option<String>,
    pub purl_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default)]
    pub qualifiers: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subpath: Option<String>,
    #[serde(default)]
    pub native_coordinates: Vec<Value>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub source_refs: Vec<Value>,
    #[serde(default)]
    pub publisher_refs: Vec<Value>,
    #[serde(default)]
    pub external_refs: Vec<Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleState {
    pub status: String,
    pub eligible: bool,
    #[serde(default)]
    pub warnings: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub derivation_event_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageInstance {
    pub node_id: String,
    pub identity: PackageIdentity,
    pub native_version: String,
    pub normalized_version: String,
    pub version_sort_key: String,
    #[serde(default)]
    pub requirements: Vec<Requirement>,
    #[serde(default)]
    pub capabilities: Vec<Capability>,
    #[serde(default)]
    pub conflicts: Vec<Conflict>,
    #[serde(default)]
    pub cardinality_constraints: Vec<CardinalityConstraint>,
    #[serde(default)]
    pub artifacts: Vec<Value>,
    pub lifecycle: LifecycleState,
    #[serde(default)]
    pub source_snapshots: Vec<Digest>,
    pub metadata_digest: Digest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_metadata_ref: Option<Value>,
    pub native_semantics: Value,
    #[serde(default)]
    pub semantic_loss: Vec<Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolutionUniverse {
    pub universe_version: String,
    pub packages: Vec<PackageInstance>,
    #[serde(default)]
    pub overlays: Vec<Value>,
    #[serde(default)]
    pub source_snapshots: Vec<Value>,
    /// Captured build plans. The pure resolver treats realisation facts as
    /// opaque: they carry no selection semantics.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recipes: Vec<Value>,
    /// Authority-gated supersessions of interpretation. They never mutate the
    /// native facts in `packages`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub amendments: Vec<UniverseAmendment>,
    pub lifecycle_root: Digest,
    pub target_vocabulary_version: String,
    pub canonical_digest: Digest,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SolveRequest {
    pub requirements: Vec<Requirement>,
    pub target: TargetContext,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<PlatformContexts>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requirement_kind_policy: Option<RequirementKindPolicy>,
    pub environment: Environment,
    pub policy: PolicyInput,
    pub semantics: SemanticsInput,
    pub objectives: Vec<String>,
    pub mode: String,
    pub evaluation_time: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_milliseconds: Option<u64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: Extensions,
}

/// Build, host, and target platforms for a cross-compiling solve. Absent
/// members fall back to the host platform, which itself defaults to
/// `SolveRequest.target`.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformContexts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<TargetContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<TargetContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<TargetContext>,
}

/// Which requirement kinds are consumed on the build platform, and which are
/// inactive for this solve.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequirementKindPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_platform_kinds: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inactive_kinds: Option<Vec<String>>,
}

/// A supersession of interpretation, bound to an exact native metadata state.
/// The resolver reads only what it needs to gate and account for amendments;
/// operation bodies stay opaque until amendment compilation lands.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UniverseAmendment {
    pub amendment_version: String,
    pub subject: Value,
    pub applies_to_metadata_digest: Digest,
    pub operations: Vec<Value>,
    pub authority: String,
    #[serde(flatten)]
    pub rest: BTreeMap<String, Value>,
}

/// Requirement kinds consumed while building rather than while running.
pub const DEFAULT_BUILD_PLATFORM_KINDS: [&str; 2] = ["build", "tool"];

impl RequirementKindPolicy {
    pub fn is_build_platform(&self, kind: Option<&str>) -> bool {
        let Some(kind) = kind else { return false };
        self.build_platform_kinds.as_ref().map_or_else(
            || DEFAULT_BUILD_PLATFORM_KINDS.contains(&kind),
            |kinds| kinds.iter().any(|item| item == kind),
        )
    }

    pub fn is_inactive(&self, kind: Option<&str>) -> bool {
        let Some(kind) = kind else { return false };
        self.inactive_kinds
            .as_ref()
            .is_some_and(|kinds| kinds.iter().any(|item| item == kind))
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Environment {
    #[serde(default)]
    pub installed: Vec<String>,
    #[serde(default)]
    pub locked: Vec<String>,
    /// Binds installed/locked state to an environment generation record. The
    /// pure resolver does not interpret the ledger; it preserves the binding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_digest: Option<Digest>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyInput {
    pub allow_yanked: bool,
    pub allow_quarantined: bool,
    pub semantic_loss_maximum: String,
    #[serde(default)]
    pub required_evidence: Vec<String>,
    #[serde(default)]
    pub accepted_overlay_authorities: Vec<String>,
    /// Skipped when empty so that adding amendment support does not alter the
    /// request digest of any existing solve.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accepted_amendment_authorities: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SemanticsInput {
    pub profile: String,
    #[serde(default)]
    pub native_compatibility: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extensions: Extensions,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SolveInput {
    pub request: SolveRequest,
    pub universe: ResolutionUniverse,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolutionSolution {
    pub selected_node_ids: Vec<String>,
    pub selected_capability_providers: Vec<CapabilityProvider>,
    pub satisfied_requirement_ids: Vec<String>,
    pub dependency_edges: Vec<DependencyEdge>,
    pub excluded_candidates: Vec<ExcludedCandidate>,
    pub objective_tuple: Vec<Value>,
    pub semantic_loss: Vec<Value>,
    pub source_snapshot_digests: Vec<Digest>,
    pub solution_digest: Digest,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityProvider {
    pub capability: String,
    pub provider_node_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DependencyEdge {
    pub requirement_id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub witness_type: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExcludedCandidate {
    pub node_id: String,
    pub reason_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolutionProof {
    pub proof_version: String,
    pub universe_digest: Digest,
    pub request_digest: Digest,
    pub selected_assignments: Vec<SelectedAssignment>,
    pub requirement_witnesses: Vec<RequirementWitness>,
    pub conflict_checks: Vec<ProofCheck>,
    pub cardinality_checks: Vec<ProofCheck>,
    pub target_checks: Vec<ProofCheck>,
    pub objective_evidence: Vec<ProofCheck>,
    /// Digests of the amendments that produced the universe this proof is
    /// about. Empty for an unamended solve, so existing proofs are unchanged.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub applied_amendment_digests: Vec<Digest>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectedAssignment {
    pub node_id: String,
    pub selected: bool,
    pub node_digest: Digest,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequirementWitness {
    pub requirement_id: String,
    pub status: String,
    pub witness_node_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProofCheck {
    pub id: String,
    pub valid: bool,
    pub evidence: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExplanationGraph {
    pub nodes: Vec<ExplanationNode>,
    pub edges: Vec<ExplanationEdge>,
    pub roots: Vec<String>,
    pub unsat_core: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub render_hints: Option<BTreeMap<String, String>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExplanationNode {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub data: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExplanationEdge {
    pub from: String,
    pub to: String,
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SolveOutput {
    pub normalized_request: SolveRequest,
    pub request_digest: Digest,
    pub universe_digest: Digest,
    pub selected: Vec<PackageInstance>,
    pub solution: ResolutionSolution,
    pub proof: ResolutionProof,
    pub explanation: ExplanationGraph,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProofCheckResult {
    pub valid: bool,
    pub diagnostics: Vec<String>,
}

//! Pure deterministic PREX resolver and independent proof checker.

mod canonical;
mod checker;
mod engine;
mod error;
mod model;
mod normalize;
mod oracle;
mod resolvo_engine;
mod semantics;

pub use canonical::{canonical_json, digest_json, parse_json, parse_json_as};
pub use checker::{check, check_json};
pub use engine::{solve, solve_json, validate_universe, validate_universe_json};
pub use error::ResolverError;
pub use model::*;
pub use normalize::{normalize_purl, parse_vers};
pub use oracle::{OracleResult, brute_force_oracle};
pub use semantics::{
    PlatformView, RequirementPlatforms, evaluate_target_predicate, evaluate_target_predicate_in,
    request_platforms, requirement_platforms, version_satisfies,
};

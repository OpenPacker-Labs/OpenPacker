use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ResolverError {
    #[error("invalid PREX input: {0}")]
    InvalidInput(String),
    #[error("unsupported semantics profile: {0}")]
    UnsupportedSemantics(String),
    #[error("resolution universe exceeds the deterministic limit of {limit} nodes ({actual})")]
    UniverseLimit { limit: usize, actual: usize },
    #[error("objective optimality cannot be independently proven above {limit} nodes ({actual})")]
    ObjectiveLimit { limit: usize, actual: usize },
    #[error(
        "RESOURCE_LIMIT: exhaustive resolution proof requires {required} work units (limit {limit})"
    )]
    ExhaustiveWorkLimit { limit: u64, required: u64 },
    #[error("UNSATISFIABLE: {0}")]
    Unsatisfiable(String),
    #[error("INTERNAL_ERROR: proof check failed: {0}")]
    InvalidProof(String),
    #[error("canonical JSON error: {0}")]
    Canonical(String),
    #[error("JSON error: {0}")]
    Json(String),
}

impl From<serde_json::Error> for ResolverError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value.to_string())
    }
}

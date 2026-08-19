use serde::{Deserialize, Serialize};

use crate::{
    ResolverError, SolveInput,
    checker::independent_valid_selection,
    engine::{MAX_COMPANION_NODES, compare_selection, enforce_exhaustive_work_limit},
};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OracleResult {
    pub selected_node_ids: Vec<String>,
    pub assignments_checked: u64,
}

/// The bounded optimum for a solve.
///
/// Amendments are applied first, so an external caller gets the optimum for
/// the universe that is actually solved rather than the pre-amendment one.
pub fn brute_force_oracle(input: &SolveInput) -> Result<OracleResult, ResolverError> {
    let amended = crate::amend::apply_amendments(input)?;
    if !amended.applied.is_empty() {
        return brute_force_oracle_amended(&amended.input);
    }
    brute_force_oracle_amended(input)
}

pub(crate) fn brute_force_oracle_amended(
    input: &SolveInput,
) -> Result<OracleResult, ResolverError> {
    let nodes = input.universe.packages.len();
    if nodes > MAX_COMPANION_NODES {
        return Err(ResolverError::UniverseLimit {
            limit: MAX_COMPANION_NODES,
            actual: nodes,
        });
    }
    enforce_exhaustive_work_limit(input)?;
    let mut best: Option<Vec<usize>> = None;
    let assignments_checked = 1u64 << nodes;
    for mask in 0..assignments_checked {
        let selection: Vec<_> = (0..nodes)
            .filter(|index| mask & (1 << index) != 0)
            .collect();
        if independent_valid_selection(input, &selection, &mut Vec::new())
            && best
                .as_ref()
                .is_none_or(|current| compare_selection(input, &selection, current).is_lt())
        {
            best = Some(selection);
        }
    }
    let selected = best.ok_or_else(|| {
        ResolverError::Unsatisfiable("bounded oracle found no satisfying assignment".into())
    })?;
    let mut selected_node_ids: Vec<_> = selected
        .iter()
        .map(|index| input.universe.packages[*index].node_id.clone())
        .collect();
    selected_node_ids.sort();
    Ok(OracleResult {
        selected_node_ids,
        assignments_checked,
    })
}

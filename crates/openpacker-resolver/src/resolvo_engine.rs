//! Resolvo is an internal search engine. PREX types remain the only public boundary.

use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::{self, Display},
};

use resolvo::{
    Candidates, Condition, ConditionId, ConditionalRequirement, Dependencies, DependencyProvider,
    HintDependenciesAvailable, Interner, KnownDependencies, NameId, Problem, SolvableId, Solver,
    SolverCache, StringId, VersionSetId, VersionSetUnionId,
    utils::{Pool, VersionSet},
};

use crate::semantics::{
    PlatformView, evaluate_target_predicate_in, requirement_is_active, requirement_platforms,
};
use crate::{LifecycleStatus, RequirementExpression, ResolverError, SolveInput};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct NodeSet(BTreeSet<usize>);

impl Display for NodeSet {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}", self.0)
    }
}

impl VersionSet for NodeSet {
    type V = usize;
}

struct PrexProvider<'a> {
    input: &'a SolveInput,
    pool: Pool<NodeSet>,
    candidates: BTreeMap<NameId, Vec<SolvableId>>,
    excluded: BTreeMap<NameId, Vec<(SolvableId, StringId)>>,
    dependencies: Vec<Vec<ConditionalRequirement>>,
}

impl<'a> PrexProvider<'a> {
    fn new(input: &'a SolveInput) -> Result<Self, ResolverError> {
        let pool = Pool::new();
        let mut candidates: BTreeMap<NameId, Vec<SolvableId>> = BTreeMap::new();
        let mut excluded: BTreeMap<NameId, Vec<(SolvableId, StringId)>> = BTreeMap::new();
        for (index, package) in input.universe.packages.iter().enumerate() {
            let name = pool.intern_package_name(package.identity.canonical_purl.clone());
            let solvable = pool.intern_solvable(name, index);
            if lifecycle_allowed(input, index) {
                candidates.entry(name).or_default().push(solvable);
            } else {
                let reason =
                    pool.intern_string(format!("lifecycle denied: {}", package.lifecycle.status));
                excluded.entry(name).or_default().push((solvable, reason));
            }
        }
        let mut provider = Self {
            input,
            pool,
            candidates,
            excluded,
            dependencies: vec![Vec::new(); input.universe.packages.len()],
        };
        for (index, package) in input.universe.packages.iter().enumerate() {
            let mut requirements = Vec::new();
            for requirement in &package.requirements {
                if !requirement.optional
                    && requirement_is_active(&input.request, Some(requirement.kind.as_str()))
                {
                    requirements.extend(provider.compile_expression(
                        &requirement.expression,
                        requirement_platforms(&input.request, Some(requirement.kind.as_str())),
                    )?);
                }
            }
            provider.dependencies[index] = requirements;
        }
        Ok(provider)
    }

    fn compile_expression(
        &self,
        expression: &RequirementExpression,
        platforms: PlatformView<'_>,
    ) -> Result<Vec<ConditionalRequirement>, ResolverError> {
        match expression {
            RequirementExpression::Package { .. } => Ok(vec![self.version_set(expression)?.into()]),
            RequirementExpression::AllOf { expressions } => {
                expressions
                    .iter()
                    .try_fold(Vec::new(), |mut all, expression| {
                        all.extend(self.compile_expression(expression, platforms)?);
                        Ok(all)
                    })
            }
            RequirementExpression::AnyOf { expressions } => {
                let sets: Vec<_> = expressions
                    .iter()
                    .map(|expression| self.version_set(expression))
                    .collect::<Result<_, _>>()?;
                let Some((&first, rest)) = sets.split_first() else {
                    return Err(ResolverError::InvalidInput(
                        "anyOf must not be empty".into(),
                    ));
                };
                if rest.is_empty() {
                    Ok(vec![first.into()])
                } else {
                    Ok(vec![
                        self.pool
                            .intern_version_set_union(first, rest.iter().copied())
                            .into(),
                    ])
                }
            }
            RequirementExpression::Conditional {
                when,
                then,
                otherwise,
            } => {
                if evaluate_target_predicate_in(when, platforms) {
                    self.compile_expression(then, platforms)
                } else {
                    otherwise.as_ref().map_or(Ok(Vec::new()), |expression| {
                        self.compile_expression(expression, platforms)
                    })
                }
            }
            _ => Err(ResolverError::InvalidInput(
                "expression is outside Resolvo's faithful subset".into(),
            )),
        }
    }

    fn version_set(
        &self,
        expression: &RequirementExpression,
    ) -> Result<VersionSetId, ResolverError> {
        let RequirementExpression::Package {
            purl,
            vers,
            qualifiers,
        } = expression
        else {
            return Err(ResolverError::InvalidInput(
                "Resolvo union members must be package expressions".into(),
            ));
        };
        let matches: BTreeSet<_> = self
            .input
            .universe
            .packages
            .iter()
            .enumerate()
            .filter_map(|(index, package)| {
                ((package.identity.canonical_purl == *purl
                    || package.identity.exact_purl.as_deref() == Some(purl))
                    && qualifiers
                        .iter()
                        .all(|(key, value)| package.identity.qualifiers.get(key) == Some(value))
                    && vers.as_deref().is_none_or(|vers| {
                        crate::version_satisfies(&package.normalized_version, vers)
                    }))
                .then_some(index)
            })
            .collect();
        let name = matches
            .iter()
            .next()
            .map(|index| {
                self.pool.intern_package_name(
                    self.input.universe.packages[*index]
                        .identity
                        .canonical_purl
                        .clone(),
                )
            })
            .unwrap_or_else(|| self.pool.intern_package_name(purl.clone()));
        Ok(self.pool.intern_version_set(name, NodeSet(matches)))
    }
}

impl Interner for PrexProvider<'_> {
    type NameId = NameId;
    type SolvableId = SolvableId;
    fn display_solvable(&self, solvable: SolvableId) -> impl Display + '_ {
        self.input.universe.packages[self.pool.resolve_solvable(solvable).record]
            .identity
            .exact_purl
            .as_deref()
            .unwrap_or("unknown")
    }
    fn display_name(&self, name: NameId) -> impl Display + '_ {
        self.pool.resolve_package_name(name).as_str()
    }
    fn display_version_set(&self, version_set: VersionSetId) -> impl Display + '_ {
        self.pool.resolve_version_set(version_set).to_string()
    }
    fn display_string(&self, string_id: StringId) -> impl Display + '_ {
        self.pool.resolve_string(string_id)
    }
    fn version_set_name(&self, version_set: VersionSetId) -> NameId {
        self.pool.resolve_version_set_package_name(version_set)
    }
    fn solvable_name(&self, solvable: SolvableId) -> NameId {
        self.pool.resolve_solvable(solvable).name
    }
    fn version_sets_in_union(
        &self,
        union: VersionSetUnionId,
    ) -> impl Iterator<Item = VersionSetId> {
        self.pool.resolve_version_set_union(union)
    }
    fn resolve_condition(&self, condition: ConditionId) -> Condition {
        self.pool.resolve_condition(condition).clone()
    }
}

impl DependencyProvider for PrexProvider<'_> {
    async fn filter_candidates(
        &self,
        candidates: &[SolvableId],
        version_set: VersionSetId,
        inverse: bool,
    ) -> Vec<SolvableId> {
        let allowed = &self.pool.resolve_version_set(version_set).0;
        candidates
            .iter()
            .copied()
            .filter(|candidate| {
                allowed.contains(&self.pool.resolve_solvable(*candidate).record) != inverse
            })
            .collect()
    }
    async fn get_candidates(&self, name: NameId) -> Option<Candidates> {
        let mut candidates = self.candidates.get(&name).cloned().unwrap_or_default();
        candidates.sort_by_key(|candidate| self.pool.resolve_solvable(*candidate).record);
        Some(Candidates {
            candidates,
            excluded: self.excluded.get(&name).cloned().unwrap_or_default(),
            hint_dependencies_available: HintDependenciesAvailable::All,
            allow_multiple: true,
            ..Candidates::default()
        })
    }
    async fn sort_candidates(&self, _solver: &SolverCache<Self>, solvables: &mut [SolvableId]) {
        solvables.sort_by(|left, right| {
            let left = &self.input.universe.packages[self.pool.resolve_solvable(*left).record];
            let right = &self.input.universe.packages[self.pool.resolve_solvable(*right).record];
            (
                &right.version_sort_key,
                right.identity.exact_purl.as_deref(),
            )
                .cmp(&(&left.version_sort_key, left.identity.exact_purl.as_deref()))
        });
    }
    async fn get_dependencies(&self, solvable: SolvableId) -> Dependencies {
        Dependencies::Known(KnownDependencies {
            requirements: self.dependencies[self.pool.resolve_solvable(solvable).record].clone(),
            constrains: Vec::new(),
        })
    }
}

pub(crate) fn supports(input: &SolveInput) -> bool {
    input.request.environment.installed.is_empty()
        && input.request.environment.locked.is_empty()
        && input.universe.packages.iter().all(|package| {
            package.conflicts.is_empty()
                && package.cardinality_constraints.is_empty()
                && package
                    .requirements
                    .iter()
                    .all(|requirement| supported_expression(&requirement.expression))
        })
        && input
            .request
            .requirements
            .iter()
            .all(|requirement| supported_expression(&requirement.expression))
}

fn supported_expression(expression: &RequirementExpression) -> bool {
    match expression {
        RequirementExpression::Package { .. } => true,
        RequirementExpression::AllOf { expressions }
        | RequirementExpression::AnyOf { expressions } => {
            !expressions.is_empty() && expressions.iter().all(supported_expression)
        }
        RequirementExpression::Conditional {
            then, otherwise, ..
        } => {
            supported_expression(then)
                && otherwise
                    .as_ref()
                    .is_none_or(|expression| supported_expression(expression))
        }
        _ => false,
    }
}

pub(crate) fn resolve(input: &SolveInput) -> Result<Vec<usize>, ResolverError> {
    let provider = PrexProvider::new(input)?;
    let mut requirements = Vec::new();
    for requirement in &input.request.requirements {
        if !requirement.optional
            && requirement_is_active(&input.request, Some(requirement.kind.as_str()))
        {
            requirements.extend(provider.compile_expression(
                &requirement.expression,
                requirement_platforms(&input.request, Some(requirement.kind.as_str())),
            )?);
        }
    }
    let problem = Problem::new().requirements(requirements);
    let mut solver = Solver::new(provider);
    let solution = solver
        .solve(problem)
        .map_err(|_| ResolverError::Unsatisfiable(crate::engine::unsat_summary(input)))?;
    let mut selected: Vec<_> = solution
        .into_iter()
        .map(|solvable| solver.provider().pool.resolve_solvable(solvable).record)
        .collect();
    selected.sort_unstable();
    selected.dedup();
    Ok(selected)
}

fn lifecycle_allowed(input: &SolveInput, index: usize) -> bool {
    let package = &input.universe.packages[index];
    match package.lifecycle.status {
        LifecycleStatus::Yanked => input.request.policy.allow_yanked,
        LifecycleStatus::Quarantined => input.request.policy.allow_quarantined,
        LifecycleStatus::Revoked
        | LifecycleStatus::Delisted
        | LifecycleStatus::RemovedFromChannel
        | LifecycleStatus::Unknown => false,
        _ => package.lifecycle.eligible,
    }
}

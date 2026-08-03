# Formal foundations and limitations

PREX's shared IR is informed by three bodies of work:

- Gibb, _Package managers à la carte: A Formal Model of Dependency Resolution_
  ([primary publication](https://ryan.freumh.org/talks/2026-fosdem-pac.html),
  [DOI record](https://doi.org/10.59350/kw89k-2gn46));
- Gibb et al., _Solving Package Management via Hypergraph Dependency Resolution_
  ([arXiv:2506.10803](https://arxiv.org/abs/2506.10803)); and
- Abate et al., _Dependency Solving Is Still Hard, but We Are Getting Better at
  It_
  ([DOI:10.1109/SANER48275.2020.9054837](https://doi.org/10.1109/SANER48275.2020.9054837)).

The search implementation is internal. The maintained
[Resolvo project](https://github.com/prefix-dev/resolvo) supplies CDCL search
where its constraint model is faithful; PREX contracts and proof objects never
expose engine-specific IDs or errors.

## Implemented mapping

| PREX construct                 | Hypergraph / calculus interpretation                        | Checked obligation                                                                    |
| ------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Exact `PackageInstance`        | Vertex/package term                                         | Node exists, identity/variant digest matches, coexistence is explicit                 |
| `Capability`                   | Provider-labelled projection from a package vertex          | Selected offer belongs to a selected provider and satisfies version/attributes/target |
| Package/capability requirement | Directed hyperedge from depender to satisfying alternatives | Every active hard edge has a witness set                                              |
| `allOf`                        | Union of required heads                                     | Every conjunct is witnessed                                                           |
| `anyOf`                        | Alternative heads                                           | At least one bounded alternative is witnessed                                         |
| Conditional                    | Hyperedge activation predicate                              | Target predicate is independently re-evaluated                                        |
| `not` / `Conflict`             | Negative clause                                             | No prohibited selected witness exists in scope                                        |
| `CardinalityConstraint`        | Lower/upper bound over selector matches                     | Selected count lies within the declared scope bounds                                  |
| Optional requirement           | Soft activation with explicit omission state                | Proof records selected, omitted, or inactive accurately                               |
| Replacement                    | Sourced alternative satisfaction relation                   | Replacement witness and authority/source are preserved                                |
| Ordered objectives             | Lexicographic order over valid selected sets                | Objective tuple is recomputed; bounded fixtures compare the optimum exhaustively      |

The explanation graph preserves the source mapping from compiled relations back
to native metadata or overlay facts. The proof checker receives the universe,
normalized request, claimed solution, and proof; it does not invoke the search
decision procedure.

## Deliberate limits

`prex-calculus-subset-v1` claims only package/capability requirements,
conjunction, alternatives, negation/conflict, optional edges, target conditions,
replacements, and cardinality/coexistence. PREX does not claim the complete
Package Calculus or HyperRes model.

Native npm peer negotiation, Cargo feature unification and target/build
behavior, NuGet target-framework reduction, workspace semantics, build scripts,
compiler/linker/runtime loading, installer filesystem ownership, and service
registration are not silently flattened. Faithful portions may be checked by
`native-validated-v1`; all unvalidated meaning remains versioned under
`nativeSemantics` with structured `SemanticLoss`. `native-capture-v1` records a
native result without claiming independent solving.

The practical consequence is fail-closed translation: a relation that cannot be
represented exactly is preserved and may block a formal profile. Adding a new
formal correspondence requires schema-first semantics, compiler source mapping,
independent proof checks, negative vectors, and bounded oracle agreement—not
only a solver clause that happens to accept one fixture.

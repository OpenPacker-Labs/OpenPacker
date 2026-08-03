# PREX conformance

Conformance is capability-scoped. A provider may claim any subset of PREX-N,
PREX-I, PREX-E, PREX-D, PREX-S, PREX-M, PREX-V, PREX-X, PREX-R, and PREX-C, but
must advertise only levels for which all assigned positive and negative vectors
pass.

Every claimed level requires:

- validation against the versioned JSON Schemas;
- stable canonical bytes and SHA-256 digests;
- positive and negative vector behavior;
- advertised limit enforcement;
- equivalent semantics across advertised transports/runtimes; and
- round-trip preservation only for declared extension containers.

Additional obligations:

| Level  | Extra evidence                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------ |
| PREX-N | PURL, VERS, native-coordinate, target, and digest normalization vectors                                |
| PREX-I | Ambiguity is returned rather than silently resolved                                                    |
| PREX-E | Codec-native ordering, lifecycle filtering, and stable pagination                                      |
| PREX-D | Exact, provenance-bound, loss-aware package instances                                                  |
| PREX-S | Deterministic output, accepted independent proof, and exhaustive optimum agreement for bounded vectors |
| PREX-M | Immutable descriptor and safe materialization restrictions                                             |
| PREX-V | Six-state evidence facts separated from aggregate policy decision                                      |
| PREX-X | Stable graph, source mapping, and bounded unsatisfiable core behavior                                  |
| PREX-R | Signature exclusion from receipt digest and signature binding to that digest                           |
| PREX-C | CloudEvents schema/digest agreement, event identity, cursor semantics, replay, and deduplication       |

Executable vectors live under [`fixtures/protocol`](../../fixtures/protocol);
`@openpacker/conformance` loads them. `npm run test:conformance` is the local
capability gate. Mandatory checks are offline and must not disappear because a
public registry or optional tool is unavailable.

The reference daemon advertises all three initial solve profiles. Native capture
and validation conformance uses uniquely resolvable exact selections in
`environment.locked`; capture must not claim independent validation, and
validation must report opaque native semantics it could not check. Evidence
types are verified only when the daemon has a matching configured verifier; an
advertised type without supplied evidence yields `not-provided`, never synthetic
success.

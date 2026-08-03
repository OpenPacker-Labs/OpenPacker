# PREX conformance

Providers advertise independent `PREX-N`, `PREX-I`, `PREX-E`, `PREX-D`,
`PREX-S`, `PREX-M`, `PREX-V`, `PREX-X`, `PREX-R`, and `PREX-C` levels. Passing a
level requires schema validation, all positive/negative vectors assigned to that
level, stable canonical bytes/digests, limit enforcement, and
transport-independent semantic equivalence.

`PREX-S` additionally requires deterministic solution output, an independently
accepted proof, and exhaustive optimum agreement for bounded vectors. `PREX-R`
requires signature exclusion from receipt digest and signature binding to that
digest. `PREX-C` requires CloudEvents schema validation, data digest agreement,
replay identity, and declared cursor semantics. No mandatory check may be
skipped based on ambient tools or network availability.

Every advertised level MUST have at least one positive and one negative
normative vector. Schema-only acceptance is insufficient: level harnesses MUST
invoke the corresponding operation and compare canonical outputs. PREX-S MUST
also run proof checking and the bounded oracle; PREX-R MUST verify projection
and signature binding; PREX-C MUST reject event type/data/dataschema mismatches.

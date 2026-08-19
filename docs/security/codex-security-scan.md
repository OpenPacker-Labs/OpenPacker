# Codex Security scan instructions

Assess this PREX reference implementation for exploitable security defects,
especially at schema, adapter/plugin, sandbox, filesystem, package-byte,
lock-import, OCI, and delegated-provider trust boundaries.

Honor the repository's safety constraints while validating findings:

- stay offline and fail closed wherever the tested boundary requires it;
- never execute host package managers, package lifecycle scripts, or mutable
  native-manager images;
- use only the repository's existing isolated or simulated native-manager
  fixtures;
- do not enable or dispatch GitHub Actions; and
- preserve canonical native package bytes and the production Epoch/ATProto
  independence boundary.

Prioritize concrete, reachable vulnerabilities over speculative hardening. Treat
intentionally dormant native-runtime lanes as missing external evidence, not
vulnerabilities, unless their fail-closed isolation can be bypassed.

Use deep mode to review every tracked production source file. The prohibited
live host-manager and mutable-image executions are explicit scope exclusions,
not deferred repository coverage; assess those boundaries through their static
implementation and existing isolated fixtures. Report complete coverage only
after the tracked production inventory has been reviewed, otherwise fail closed
with the exact uncovered paths.

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

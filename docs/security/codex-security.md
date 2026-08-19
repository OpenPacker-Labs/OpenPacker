# Codex Security

OpenPacker keeps Codex Security outside the workspace dependency graph. It
requires Python 3.10 or newer and Node.js 22.13.x, 24.x, or 26.x. Python 3.10
also requires `tomli`.

Release 0.1.14 directly depends on an unpatched `extract-zip`. Build the
reviewed source commit with ZIP plugin installation disabled, audit the packed
graph, then install it into a user-owned global prefix:

```bash
git clone https://github.com/openai/codex-security.git
cd codex-security
git checkout 5d1afcd312933121e36dc892dcb12e8d2e3e1de3
git apply /path/to/openpacker/docs/security/codex-security-0.1.14-no-zip.patch
cd sdk/typescript
npm install --ignore-scripts --no-audit --no-fund
npm run build
npm audit --audit-level=low
npm pack --ignore-scripts
npm install -g ./openai-codex-security-0.1.14.tgz --ignore-scripts --no-audit --no-fund
codex-security login status
```

The CLI can reuse an authenticated Codex session. Run a configuration-only
preflight or the severity-gated repository scan with:

```bash
npm run security:codex:dry-run
npm run security:codex
```

The scan uses [`codex-security-scan.md`](codex-security-scan.md) for
repository-specific safety constraints. The wrapper pins the reviewed CLI, SDK,
bundled plugin, and Codex runtime versions, rejects custom plugins and Codex
overrides, selects stored ChatGPT authentication, uses deep mode, and accepts no
runtime option except `--dry-run`.

Codex Security keeps credentials, working state, and reports outside the
repository by default. Set `CODEX_SECURITY_STATE_DIR` to an owned private
directory outside the checkout when the default Codex state directory is
unsuitable.

Scan subprocesses inherit the invoking environment. Run from a clean shell and
remove unrelated registry, cloud, signing, and package-manager credentials
before scanning.

The global CLI is outside OpenPacker's audit, license, and SBOM gates, and npm
does not support `npm audit --global`. Audit it separately before packing each
upgrade. Version 0.1.14 otherwise reports the upstream
[`extract-zip` path-traversal advisory](https://github.com/advisories/GHSA-jmr9-qjv8-65gv);
the reviewed patch removes that dependency and disables ZIP plugins. The
repository wrapper refuses to start a scanner that declares or can resolve
`extract-zip`, while keeping scanner dependencies outside OpenPacker's graph.

The scan fails closed at low severity. Codex Security also refuses to evaluate
that policy when coverage is partial; treat either exit as a failed security
gate and inspect the external report before changing code. The wrapper pins
`approval_policy="never"`, so the scanner runs maximally contained: headless
approval requests are denied, and any bundled preflight helper that would need
approval simply does not run.

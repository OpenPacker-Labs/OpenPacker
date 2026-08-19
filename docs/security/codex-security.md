# Codex Security

OpenPacker keeps Codex Security outside the workspace dependency graph. It
requires Python 3.10 or newer and Node.js 22.13.x, 24.x, or 26.x. Python 3.10
also requires `tomli`.

Confirm that `npm prefix -g` is owned by your user, then install the reviewed
CLI version there:

```bash
npm install -g @openai/codex-security@0.1.14 --ignore-scripts --no-audit --no-fund
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
overrides, selects stored ChatGPT authentication, forces
`approval_policy="never"`, and accepts no runtime option except `--dry-run`.

Codex Security keeps credentials, working state, and reports outside the
repository by default. Set `CODEX_SECURITY_STATE_DIR` to an owned private
directory outside the checkout when the default Codex state directory is
unsuitable.

Scan subprocesses inherit the invoking environment. Run from a clean shell and
remove unrelated registry, cloud, signing, and package-manager credentials
before scanning.

The global CLI is outside OpenPacker's audit, license, and SBOM gates, and npm
does not support `npm audit --global`. Audit it separately in a disposable npm
prefix before upgrades. Version 0.1.14 currently reports the upstream
[`extract-zip` path-traversal advisory](https://github.com/advisories/GHSA-jmr9-qjv8-65gv);
the repository wrapper blocks the affected custom plugin ZIP path while keeping
the advisory out of OpenPacker's production and development dependency graph.

The scan fails closed at high severity. Codex Security also refuses to evaluate
that policy when coverage is partial; treat either exit as a failed security
gate and inspect the external report before changing code.

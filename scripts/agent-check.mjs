#!/usr/bin/env node
/**
 * Impact-scoped agent gate for OpenPacker.
 *
 * Usage:
 *   node scripts/agent-check.mjs              # diff vs HEAD~1 (or origin/main if set)
 *   node scripts/agent-check.mjs --staged     # only staged changes
 *   node scripts/agent-check.mjs --base=origin/main
 *
 * Opt out of individual classes with OPENPACKER_AGENT_CHECK_SKIP=comma,list
 * (e.g. rust,docs,full). Never skips secrets/hygiene checks.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const staged = args.includes('--staged');
const baseArg = args.find((a) => a.startsWith('--base='));
const base = baseArg?.slice('--base='.length);
const skip = new Set(
  (process.env.OPENPACKER_AGENT_CHECK_SKIP ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

function run(cmd, cmdArgs, label) {
  console.log(`\n→ ${label}\n  $ ${cmd} ${cmdArgs.join(' ')}`);
  const result = spawnSync(cmd, cmdArgs, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: false,
  });
  if (result.error) {
    console.error(`fail  ${label}: ${result.error.message}`);
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) {
    console.error(`fail  ${label} (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
  console.log(`ok   ${label}`);
}

function git(argsList) {
  const result = spawnSync('git', argsList, {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(result.stderr || `git ${argsList.join(' ')} failed`);
  return result.stdout;
}

function changedFiles() {
  if (staged) {
    const out = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }
  const ref = base || 'HEAD~1';
  // Fall back to empty if ref missing (root commit).
  const probe = spawnSync('git', ['rev-parse', '--verify', ref], {
    cwd: root,
    encoding: 'utf8',
  });
  if (probe.status !== 0) {
    const out = git(['ls-files']);
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }
  const out = git([
    'diff',
    '--name-only',
    '--diff-filter=ACMR',
    `${ref}...HEAD`,
  ]);
  const unstaged = git(['diff', '--name-only', '--diff-filter=ACMR']);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  return [
    ...new Set(
      [...out.split('\n'), ...unstaged.split('\n'), ...untracked.split('\n')]
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
}

function workspaceFor(file) {
  if (file.startsWith('packages/')) {
    const name = file.split('/')[1];
    return name ? `packages/${name}` : null;
  }
  if (file.startsWith('apps/')) {
    const name = file.split('/')[1];
    return name ? `apps/${name}` : null;
  }
  if (file.startsWith('examples/')) {
    const name = file.split('/')[1];
    return name ? `examples/${name}` : null;
  }
  return null;
}

import { readFileSync } from 'node:fs';

function pkgName(workspacePath) {
  const pkgJson = join(root, workspacePath, 'package.json');
  if (!existsSync(pkgJson)) return null;
  try {
    return JSON.parse(readFileSync(pkgJson, 'utf8')).name;
  } catch {
    return null;
  }
}

const files = changedFiles();
console.log(
  `agent:check scope=${staged ? 'staged' : base ? `base=${base}` : 'HEAD~1+worktree'} files=${files.length}`,
);

if (files.length === 0) {
  console.log('ok  agent:check — nothing to validate for this scope.');
  process.exit(0);
}

// Hygiene: never allow secrets
const secretLike = files.filter((f) =>
  /(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key)|credentials\.json|id_rsa)/iu.test(
    f,
  ),
);
if (secretLike.length) {
  console.error(
    'fail  secret-like paths staged/changed:\n  ' + secretLike.join('\n  '),
  );
  process.exit(1);
}

const workspaces = [...new Set(files.map(workspaceFor).filter(Boolean))];

const touch = {
  skills: files.some(
    (f) => f.startsWith('.agents/skills/') || f.startsWith('.claude/skills/'),
  ),
  docs: files.some(
    (f) =>
      f.startsWith('docs/') ||
      f === 'README.md' ||
      f === 'CONTRIBUTING.md' ||
      f === 'SECURITY.md' ||
      f.startsWith('examples/README'),
  ),
  contracts: files.some(
    (f) =>
      f.startsWith('spec/prex/') ||
      f.startsWith('packages/contracts/') ||
      f.startsWith('packages/conformance/') ||
      f.startsWith('fixtures/protocol/'),
  ),
  rust: files.some(
    (f) =>
      f.startsWith('crates/') ||
      f === 'Cargo.toml' ||
      f === 'Cargo.lock' ||
      f === 'rustfmt.toml',
  ),
  ci: files.some((f) => f.startsWith('.github/')),
  root: files.some((f) =>
    [
      'package.json',
      'package-lock.json',
      'turbo.json',
      'tsconfig.base.json',
    ].includes(f),
  ),
};

const checks = [];

if (
  !skip.has('prettier') &&
  files.some((f) => /\.(md|json|ya?ml|ts|mjs|js|css)$/u.test(f))
) {
  const pretty = files.filter(
    (f) =>
      /\.(md|json|ya?ml|ts|mjs|js|css)$/u.test(f) &&
      !f.startsWith('.agents/skills/') &&
      !f.startsWith('.claude/skills/') &&
      !f.startsWith('.claude/agents/'),
  );
  if (pretty.length)
    checks.push({
      label: 'prettier (changed)',
      cmd: 'npx',
      args: ['prettier', '--check', ...pretty],
    });
}

if (touch.skills && !skip.has('skills')) {
  checks.push({
    label: 'skills:mirror-check',
    cmd: 'npm',
    args: ['run', 'skills:mirror-check'],
  });
}

if (touch.docs && !skip.has('docs')) {
  checks.push({
    label: 'test:docs',
    cmd: 'npm',
    args: ['run', 'test:docs'],
  });
}

if (touch.contracts && !skip.has('contracts')) {
  checks.push({
    label: 'check:contracts',
    cmd: 'npm',
    args: ['run', 'check:contracts'],
  });
}

if (touch.rust && !skip.has('rust')) {
  checks.push({
    label: 'cargo fmt --check',
    cmd: 'cargo',
    args: ['fmt', '--all', '--', '--check'],
  });
  checks.push({
    label: 'cargo test (workspace)',
    cmd: 'cargo',
    args: ['test', '--workspace', '--all-features', '--locked'],
  });
}

const maxPackages = Number(
  process.env.OPENPACKER_AGENT_CHECK_MAX_PACKAGES ?? '12',
);
let packageRuns = 0;
for (const ws of workspaces) {
  if (skip.has('packages')) break;
  if (packageRuns >= maxPackages) {
    console.log(
      `agent:check: package gate cap ${maxPackages} reached (set OPENPACKER_AGENT_CHECK_MAX_PACKAGES to raise)`,
    );
    break;
  }
  packageRuns += 1;
  const name = pkgName(ws);
  if (!name) continue;
  const pkgJson = join(root, ws, 'package.json');
  const scripts = JSON.parse(readFileSync(pkgJson, 'utf8')).scripts ?? {};
  if (scripts.test) {
    checks.push({
      label: `test ${name}`,
      cmd: 'npm',
      args: ['run', 'test', `--workspace`, name],
    });
  }
  if (scripts.typecheck) {
    checks.push({
      label: `typecheck ${name}`,
      cmd: 'npm',
      args: ['run', 'typecheck', `--workspace`, name],
    });
  }
}

// Root tooling changes: skill mirrors + docs smoke as a minimum
if (touch.root && !skip.has('root')) {
  checks.push({
    label: 'skills:mirror-check (root)',
    cmd: 'npm',
    args: ['run', 'skills:mirror-check'],
  });
}

if (checks.length === 0) {
  console.log(
    'ok  agent:check — changes present but no mapped gates; run npm run verify before merge.',
  );
  process.exit(0);
}

console.log(`agent:check running ${checks.length} gate(s)`);
for (const check of checks) run(check.cmd, check.args, check.label);

console.log(
  `\nok  agent:check — ${checks.length} relevant check(s) passed` +
    (staged ? ' (staged scope)' : ''),
);

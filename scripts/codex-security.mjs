#!/usr/bin/env node

import {
  accessSync,
  constants,
  existsSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const expected = {
  cliVersion: '0.1.14',
  sdkVersion: '0.1.14',
  bundledPluginVersion: '0.1.20',
  codexVersion: '0.148.0-alpha.8',
};

function fail(message) {
  console.error(`codex-security: ${message}`);
  process.exit(1);
}

function executable() {
  const configured = process.env.CODEX_SECURITY_BIN;
  if (configured) {
    if (!isAbsolute(configured)) fail('CODEX_SECURITY_BIN must be absolute.');
    return realpathSync(configured);
  }

  const names =
    process.platform === 'win32'
      ? ['codex-security.cmd', 'codex-security.exe', 'codex-security']
      : ['codex-security'];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (!existsSync(candidate)) continue;
      if (extname(candidate).toLowerCase() === '.cmd') {
        const cli = join(
          dirname(candidate),
          'node_modules',
          '@openai',
          'codex-security',
          'dist',
          'cli.js',
        );
        if (existsSync(cli)) return realpathSync(cli);
        continue;
      }
      const resolved = realpathSync(candidate);
      if (!statSync(resolved).isFile()) continue;
      accessSync(
        resolved,
        process.platform === 'win32' ? constants.F_OK : constants.X_OK,
      );
      return resolved;
    }
  }
  fail('reviewed CLI not found; see docs/security/codex-security.md.');
}

function run(cli, args, stdio) {
  const javascript = extname(cli).toLowerCase() === '.js';
  return spawnSync(
    javascript ? process.execPath : cli,
    javascript ? [cli, ...args] : args,
    {
      encoding: 'utf8',
      stdio,
    },
  );
}

const forwarded = process.argv.slice(2);
if (forwarded.some((value) => value !== '--dry-run')) {
  fail('only --dry-run is accepted by the repository scan wrapper.');
}

const cli = executable();
const identity = run(cli, ['info', '--format', 'json'], 'pipe');
if (identity.error || identity.status !== 0) {
  fail(
    identity.error?.message ??
      identity.stderr?.trim() ??
      'unable to inspect CLI identity.',
  );
}

let info;
try {
  info = JSON.parse(identity.stdout);
} catch {
  fail('CLI identity output was not valid JSON.');
}
for (const [field, version] of Object.entries(expected)) {
  if (info[field] !== version) {
    fail(`expected ${field} ${version}, received ${String(info[field])}.`);
  }
}

const scan = run(
  cli,
  [
    'scan',
    '.',
    '--headless',
    '--auth',
    'chatgpt',
    '--fail-on-severity',
    'high',
    '--knowledge-base',
    'docs/security',
    '--scan-prompt-file',
    'docs/security/codex-security-scan.md',
    '--codex',
    'approval_policy="never"',
    ...forwarded,
  ],
  'inherit',
);
if (scan.error) fail(scan.error.message);
process.exit(scan.status ?? 1);

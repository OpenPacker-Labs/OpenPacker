#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const gate = process.argv[2];
const directories = {
  unit: ['tests/unit', 'tests/property'],
  conformance: ['tests/conformance', 'tests/golden'],
  security: ['tests/security'],
  integration: ['tests/integration'],
  e2e: ['tests/e2e'],
  compat: ['tests/compat'],
  browser: ['tests/browser'],
};
const vitestTargets = {
  conformance: ['packages/contracts', 'packages/conformance'],
  security: [
    'packages/adapter-core',
    'packages/adapter-npm',
    'packages/adapter-cargo',
    'packages/adapter-nuget',
    'packages/adapter-nix',
    'packages/adapter-apt',
    'packages/adapter-winget',
    'packages/adapter-chocolatey',
    'packages/artifact-model',
    'packages/artifact-store',
    'packages/canonical',
    'packages/catalog',
    'packages/chunking',
    'packages/closure',
    'packages/events',
    'packages/lifecycle',
    'packages/materializer',
    'packages/oci',
    'packages/ocm',
    'packages/trust',
    'packages/policy',
    'packages/receipts',
    'packages/sandbox',
    'packages/opm-project',
    'apps/openpackerd',
    'apps/opm',
  ],
  integration: [
    'packages/adapter-core',
    'packages/adapter-npm',
    'packages/adapter-cargo',
    'packages/adapter-nuget',
    'packages/adapter-nix',
    'packages/catalog',
    'packages/artifact-model',
    'packages/artifact-store',
    'packages/chunking',
    'packages/closure',
    'packages/oci',
    'packages/ocm',
    'packages/materializer',
    'packages/trust',
    'packages/opm-project',
    'apps/openpackerd',
    'apps/openpacker-cli',
    'apps/opm',
  ],
  compat: [
    'packages/sdk',
    'packages/events',
    'packages/testkit',
    'examples/epoch-consumer',
  ],
};
const nodeTargets = {
  integration: ['integrations/mise/test/contract.test.mjs'],
};
const commands = {
  integration: [
    [
      'npm',
      [
        'run',
        'test:pact:provider',
        '--workspace',
        '@openpacker/example-epoch-consumer',
      ],
    ],
  ],
  compat: [
    [
      'npm',
      [
        'run',
        'test:pact:provider',
        '--workspace',
        '@openpacker/example-epoch-consumer',
      ],
    ],
  ],
  browser: [
    [
      'npm',
      [
        'run',
        'test:browser',
        '--workspace',
        '@openpacker/example-epoch-consumer',
      ],
    ],
  ],
};

if (!(gate in directories)) {
  console.error(
    `usage: node scripts/run-gate.mjs <${Object.keys(directories).join('|')}>`,
  );
  process.exit(2);
}

function filesIn(directory) {
  const absolute = join(root, directory);
  const files = [];
  for (const entry of readdirSync(absolute).sort()) {
    const path = join(absolute, entry);
    if (statSync(path).isDirectory())
      files.push(...filesIn(relative(root, path)));
    else if (entry.endsWith('.test.mjs')) files.push(path);
  }
  return files;
}

const files = [
  ...directories[gate].flatMap(filesIn),
  ...(nodeTargets[gate] ?? []).map((path) => join(root, path)),
];
if (files.length === 0) {
  console.error(`${gate}: no mandatory test files found`);
  process.exit(1);
}
for (const file of files)
  if (!existsSync(file)) {
    console.error(
      `${gate}: mandatory test file is absent: ${relative(root, file)}`,
    );
    process.exit(1);
  }

const targets = (vitestTargets[gate] ?? []).filter((path) =>
  existsSync(join(root, path)),
);
if (gate in vitestTargets && targets.length !== vitestTargets[gate].length) {
  const missing = vitestTargets[gate].filter((path) => !targets.includes(path));
  console.error(
    `${gate}: mandatory Vitest targets are absent: ${missing.join(', ')}`,
  );
  process.exit(1);
}
if (targets.length > 0) {
  const packageTests = spawnSync(
    'npm',
    [
      'exec',
      '--',
      'vitest',
      'run',
      ...targets,
      '--config',
      'scripts/vitest.gate.config.mjs',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (packageTests.error) throw packageTests.error;
  if (packageTests.status !== 0) process.exit(packageTests.status ?? 1);
}
for (const [command, args] of commands[gate] ?? []) {
  const commandResult = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
  });
  if (commandResult.error) throw commandResult.error;
  if (commandResult.status !== 0) process.exit(commandResult.status ?? 1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);

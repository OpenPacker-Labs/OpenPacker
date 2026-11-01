#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');

// `from '@openpacker/…'`, a side-effect import, or import('@openpacker/…').
// A name that only appears in a string is not one of these: tests/unit names
// packages that way, and building them is not this gate's job.
const WORKSPACE_IMPORT =
  /\bfrom\s+['"](@openpacker\/[^'"]+)['"]|\bimport\s*\(\s*['"](@openpacker\/[^'"]+)['"]\s*\)|\bimport\s+['"](@openpacker\/[^'"]+)['"]/gu;

/** Workspace specifiers a test file loads, in source order. */
export function workspaceSpecifiers(source) {
  const found = [];
  for (const match of source.matchAll(WORKSPACE_IMPORT))
    found.push(match[1] ?? match[2] ?? match[3]);
  return found;
}

/** `@openpacker/embedded/wasm-node` is the package `@openpacker/embedded`. */
export function packageOfSpecifier(specifier) {
  const parts = specifier.split('/');
  if (parts.length < 2 || !parts[0].startsWith('@') || parts[1] === '')
    return null;
  return `${parts[0]}/${parts[1]}`;
}

/**
 * Packages whose export file is not on disk, one each, sorted.
 * `isBuilt(specifier)` is true when the file node would load is present.
 */
export function unbuiltPackages(specifiers, isBuilt) {
  const missing = new Set();
  for (const specifier of specifiers) {
    const name = packageOfSpecifier(specifier);
    if (name === null)
      throw new Error(`workspace import is not a package name: ${specifier}`);
    if (!isBuilt(specifier)) missing.add(name);
  }
  return [...missing].sort();
}

/** Same, over the sources of the files `node --test` is about to load. */
export function packagesToBuild(sources, isBuilt) {
  return unbuiltPackages(sources.flatMap(workspaceSpecifiers), isBuilt);
}

/**
 * True when `import.meta.resolve` names a file that exists.
 * Resolve still returns the export path when that file was never built
 * (`@openpacker/chunking` → `dist/index.js`). That missing file is the
 * unit gate's `ERR_MODULE_NOT_FOUND`.
 */
export function publishedFileIsPresent(specifier, fileExists = existsSync) {
  let file;
  try {
    file = fileURLToPath(import.meta.resolve(specifier));
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'ERR_MODULE_NOT_FOUND' ||
        error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED')
    )
      return false;
    throw error;
  }
  return fileExists(file);
}

const directories = {
  unit: ['tests/unit', 'tests/property'],
  conformance: ['tests/conformance', 'tests/golden'],
  security: ['tests/security'],
  integration: ['tests/integration'],
  e2e: ['tests/e2e'],
  behavior: ['tests/behavior'],
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
    'packages/adapter-packslip',
    'packages/packslip',
    'packages/packslip-testkit',
    'packages/trust',
    'packages/policy',
    'packages/receipts',
    'packages/sandbox',
    'packages/opm-project',
    'apps/openpackerd',
    'apps/openpacker-cli',
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
    'packages/adapter-packslip',
    'packages/packslip',
    'packages/trust',
    'packages/opm-project',
    'apps/openpackerd',
    'apps/openpacker-cli',
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

function buildPackages(names) {
  const turboRun = fileURLToPath(new URL('./turbo-run.mjs', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [turboRun, 'build', ...names.map((name) => `--filter=${name}`)],
    { cwd: root, stdio: 'inherit' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
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

function main() {
  const gate = process.argv[2];
  if (!(gate in directories)) {
    console.error(
      `usage: node scripts/run-gate.mjs <${Object.keys(directories).join('|')}>`,
    );
    process.exit(2);
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
    const missing = vitestTargets[gate].filter(
      (path) => !targets.includes(path),
    );
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

  // Affected CI builds the packages a pull request changes, then this gate
  // still loads every file below. tests/property/prex.test.mjs imports
  // @openpacker/chunking, which that set does not build, so node --test dies
  // with ERR_MODULE_NOT_FOUND on dist/index.js. Build a package only when the
  // file its export names is absent. @openpacker/embedded#build is not cached,
  // and rebuilding it on every run would compile the resolver again.
  const missing = packagesToBuild(
    files.map((file) => readFileSync(file, 'utf8')),
    publishedFileIsPresent,
  );
  if (missing.length > 0) {
    console.error(
      `${gate}: building ${missing.join(', ')} (a test imports a file that is not built)`,
    );
    buildPackages(missing);
  }

  const result = spawnSync(process.execPath, ['--test', ...files], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

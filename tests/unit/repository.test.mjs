import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import test from 'node:test';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

function filesIn(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesIn(path) : [path];
  });
}

const sourceTests = (directory) =>
  filesIn(directory).filter((path) =>
    /(?:\.test|\.spec)\.[cm]?[jt]s$/u.test(path),
  );

test('every implementation workspace has a substantive, runnable unit test', () => {
  const missing = [];
  for (const parent of ['apps', 'packages']) {
    const directory = join(root, parent);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).sort()) {
      const workspace = join(directory, name);
      const manifestPath = join(workspace, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (
        typeof manifest.scripts?.test !== 'string' ||
        sourceTests(workspace).length === 0
      )
        missing.push(relative(root, workspace));
    }
  }
  assert.deepEqual(missing, []);
});

test('mandatory aggregate commands are explicit and fail-closed', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  for (const gate of [
    'test:conformance',
    'test:security',
    'test:integration',
    'test:e2e',
    'test:compat',
    'test:browser',
  ]) {
    assert.equal(
      manifest.scripts[gate],
      `node scripts/run-gate.mjs ${gate.slice(5)}`,
    );
  }
  for (const mandatory of [
    'test:docs',
    'check:rust',
    'benchmark',
    'demo',
    'golden:check',
    'test:fuzz',
  ])
    assert.ok(
      manifest.scripts.verify.includes(`npm run ${mandatory}`),
      `verify omits ${mandatory}`,
    );
  assert.doesNotMatch(
    manifest.scripts.verify,
    /continue-on-error|\|\|\s*true|--if-present/u,
  );
  assert.ok(
    manifest.scripts.verify.indexOf('npm run demo') <
      manifest.scripts.verify.indexOf('npm run golden:check') &&
      manifest.scripts.verify.indexOf('npm run golden:check') <
        manifest.scripts.verify.indexOf('npm run test:fuzz'),
    'verify must check authoritative demo goldens before fuzzing them',
  );
});

test('protocol packages and the resolver retain their pure dependency boundaries', () => {
  const forbiddenPackages = new Set([
    'fastify',
    '@openpacker/oci',
    '@openpacker/openpackerd',
    '@openpacker/cli',
  ]);
  for (const name of ['contracts', 'canonical', 'conformance']) {
    const manifest = JSON.parse(
      readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'),
    );
    assert.deepEqual(
      Object.keys(manifest.dependencies ?? {}).filter((dependency) =>
        forbiddenPackages.has(dependency),
      ),
      [],
      `${name} crosses the protocol dependency boundary`,
    );
  }

  const resolverSource = filesIn(join(root, 'crates/openpacker-resolver/src'))
    .filter((path) => path.endsWith('.rs'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    resolverSource,
    /std::(?:fs|net|process|time)|(?:reqwest|ureq|rand)::/u,
    'pure resolver source gained network, filesystem, clock, random, or process access',
  );
});

test('Turbo cannot restore a stale Rust-backed embedded build', () => {
  const turbo = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8'));
  assert.equal(turbo.tasks['@openpacker/embedded#build'].cache, false);
  assert.ok(turbo.globalDependencies.includes('tsconfig.base.json'));
});

// One vitest default for every package, so a run under load is not failed by
// a bound some packages raised and others did not; a test that asserts a
// duration says so itself.
test('every package and root vitest run extends the one shared default', () => {
  const shared = readFileSync(join(root, 'vitest.shared.ts'), 'utf8');
  assert.match(shared, /testTimeout: 30_000/u);
  assert.match(shared, /hookTimeout: 30_000/u);
  assert.match(shared, /tests\/support\/stores\.setup\.ts/u);
  const workspaces = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ).workspaces.flatMap((pattern) =>
    pattern.endsWith('/*')
      ? readdirSync(join(root, pattern.slice(0, -2))).map(
          (name) => `${pattern.slice(0, -2)}/${name}`,
        )
      : [pattern],
  );
  const usingVitest = workspaces.filter((workspace) => {
    const manifest = join(root, workspace, 'package.json');
    if (!existsSync(manifest)) return false;
    const { scripts = {} } = JSON.parse(readFileSync(manifest, 'utf8'));
    return Object.values(scripts).some((script) => /\bvitest\b/u.test(script));
  });
  assert.ok(usingVitest.length > 40, `${usingVitest.length} workspaces`);
  for (const workspace of usingVitest) {
    const config = join(root, workspace, 'vitest.config.ts');
    assert.ok(existsSync(config), `${workspace} has no vitest.config.ts`);
    const text = readFileSync(config, 'utf8');
    assert.match(text, /'\.\.\/\.\.\/vitest\.shared\.js'/u, workspace);
    assert.doesNotMatch(text, /testTimeout|hookTimeout/u, workspace);
  }
  for (const config of [
    'scripts/vitest.coverage.config.mjs',
    'scripts/vitest.gate.config.mjs',
  ]) {
    const text = readFileSync(join(root, config), 'utf8');
    assert.match(text, /'\.\.\/vitest\.shared\.ts'/u, config);
    assert.doesNotMatch(text, /testTimeout|hookTimeout/u, config);
    assert.match(text, /store-guard\.setup\.ts/u, config);
  }
});

// Strict env mode hands a task only what turbo.json names. Without these, cargo
// under `turbo run build` ignores an exported CARGO_TARGET_DIR and builds into
// the checkout's own target/, so every worktree grows a private copy.
test('Turbo passes the cargo build settings through to its tasks', () => {
  const turbo = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8'));
  for (const name of [
    'CARGO_HOME',
    'RUSTUP_HOME',
    'CARGO_TARGET_DIR',
    'CARGO_INCREMENTAL',
    'CARGO_BUILD_JOBS',
  ])
    assert.ok(turbo.globalPassThroughEnv.includes(name), name);
});

test('Pact verification compares committed bytes without rewriting them', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.doesNotMatch(manifest.scripts.test, /prettier\s+--write.*pacts/u);
  const consumer = readFileSync(
    join(root, 'examples/epoch-consumer/test/pact.consumer.test.ts'),
    'utf8',
  );
  assert.match(
    consumer,
    /expect\(generated\)\.toBe\(await readFile\(committedPact/u,
  );
  assert.doesNotMatch(consumer, /writeFile|copyFile|rename/u);
});

test('security orchestration retains every executable trust boundary', () => {
  const gate = readFileSync(join(root, 'scripts/run-gate.mjs'), 'utf8');
  for (const target of [
    'packages/adapter-core',
    'packages/adapter-npm',
    'packages/adapter-cargo',
    'packages/adapter-nuget',
    'packages/catalog',
    'packages/lifecycle',
    'packages/events',
    'packages/oci',
    'packages/ocm',
    'packages/materializer',
    'packages/trust',
  ])
    assert.match(gate, new RegExp(`['"]${target}['"]`, 'u'));
});

test('CI actions and installed Rust tools use exact versions', () => {
  const workflows = filesIn(join(root, '.github/workflows'))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
  assert.doesNotMatch(
    workflows,
    /uses:\s+[^\s@]+@(?:stable|main|master|v\d+)\s*$/mu,
  );
  for (const command of workflows.matchAll(
    /^\s*- run:\s+cargo install\s+([^\n]+)$/gmu,
  ))
    assert.match(command[1], /--version\s+\d+\.\d+\.\d+/u);
});

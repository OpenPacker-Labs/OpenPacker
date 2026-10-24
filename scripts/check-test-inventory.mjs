#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createVitest } from 'vitest/node';

const testFile = /\.(?:test|spec)\.(?:[cm]?js|tsx?)$/u;

function filesIn(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    filesIn(join(path, entry.name)),
  );
}

export function workspaceInventoryFailures(rows) {
  return rows.flatMap((row) => {
    const failures = [];
    if (row.testScript !== 'vitest run')
      failures.push(
        `${row.workspace}: test script is not a runnable Vitest gate`,
      );
    if (row.discoveredTests === 0)
      failures.push(`${row.workspace}: Vitest discovered no tests`);
    else if (row.activeTests === 0)
      failures.push(
        `${row.workspace}: discovered suite is skipped or todo only`,
      );
    return failures;
  });
}

export function authorityInventoryFailures(
  authorities,
  scriptsByOwner,
  hasOracle,
  hasActiveVitest,
) {
  return authorities.flatMap(
    ({ type, owner = 'root', script, command, oracles, vitest = [] }) => {
      const actual = scriptsByOwner.get(owner)?.[script] ?? '';
      const failures = [];
      if (!actual) failures.push(`${type}: missing ${owner} ${script} script`);
      else if (actual !== command)
        failures.push(
          `${type}: ${owner} ${script} does not match its authority command`,
        );
      for (const path of oracles)
        if (!hasOracle(path)) failures.push(`${type}: missing oracle ${path}`);
      for (const path of vitest)
        if (!hasActiveVitest(path))
          failures.push(`${type}: no runnable Vitest oracle ${path}`);
      return failures;
    },
  );
}

export async function checkTestInventory(root) {
  const workspaces = ['apps', 'examples', 'packages']
    .flatMap((directory) =>
      readdirSync(join(root, directory), { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            existsSync(join(root, directory, entry.name, 'package.json')),
        )
        .map((entry) => join(directory, entry.name)),
    )
    .sort();
  const vitest = await createVitest('test', {
    root,
    config: 'scripts/vitest.gate.config.mjs',
    run: true,
    reporters: [],
  });
  let discovered;
  try {
    await vitest.init();
    const result = await vitest.collect(['packages', 'apps', 'examples']);
    if (result.unhandledErrors.length)
      throw new Error('Vitest discovery reported unhandled errors');
    discovered = result.testModules.flatMap((module) =>
      [...module.children.allTests()].map((test) => ({
        file: module.moduleId,
        runnable: test.options.mode === 'run' || test.options.mode === 'only',
      })),
    );
  } finally {
    await vitest.close();
  }
  const manifests = new Map();
  const rows = workspaces.map((workspace) => {
    const manifest = JSON.parse(
      readFileSync(join(root, workspace, 'package.json'), 'utf8'),
    );
    manifests.set(workspace, manifest);
    const tests = discovered.filter(
      ({ file }) =>
        relative(join(root, workspace), file) !== '..' &&
        !relative(join(root, workspace), file).startsWith(
          `..${process.platform === 'win32' ? '\\' : '/'}`,
        ),
    );
    return {
      workspace,
      testScript: manifest.scripts?.test,
      discoveredTests: tests.length,
      activeTests: tests.filter(({ runnable }) => runnable).length,
    };
  });

  const rootScripts = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ).scripts;
  const commands = {
    test: 'turbo run test --concurrency=1 && node scripts/run-gate.mjs unit',
    conformance: 'node scripts/run-gate.mjs conformance',
    security: 'node scripts/run-gate.mjs security',
    integration: 'node scripts/run-gate.mjs integration',
    e2e: 'node scripts/run-gate.mjs e2e',
    compat: 'node scripts/run-gate.mjs compat',
    browser: 'node scripts/run-gate.mjs browser',
    fuzz: 'node scripts/fuzz-smoke.mjs && node tests/fuzz/upm-auth-config.mjs && node tests/fuzz/upm-maven-pom.mjs',
    coverage: 'node scripts/coverage.mjs',
    parity:
      'npm exec -- vitest run packages/adapters-default/src/standard-pack.test.ts packages/adapters-default/src/standard-pack.native.test.ts && node --test integrations/mise/test/contract.test.mjs',
    nativeParity: 'node scripts/pack-parity-container.mjs',
    live: 'npm run test:live --workspace @openpacker/oci && npm run test:live --workspace @openpacker/adapter-nix',
  };
  const authorities = [
    {
      type: 'unit',
      script: 'test',
      command: commands.test,
      oracles: ['tests/unit'],
    },
    {
      type: 'property',
      script: 'test',
      command: commands.test,
      oracles: ['tests/property'],
    },
    {
      type: 'conformance',
      script: 'test:conformance',
      command: commands.conformance,
      oracles: ['tests/conformance', 'packages/conformance/test'],
      vitest: ['packages/conformance/test/contracts.test.ts'],
    },
    {
      type: 'security',
      script: 'test:security',
      command: commands.security,
      oracles: ['tests/security', 'packages/sandbox/src/escape.test.ts'],
      vitest: ['packages/sandbox/src/escape.test.ts'],
    },
    {
      type: 'integration',
      script: 'test:integration',
      command: commands.integration,
      oracles: ['tests/integration', 'integrations/mise/test'],
    },
    {
      type: 'e2e',
      script: 'test:e2e',
      command: commands.e2e,
      oracles: ['tests/e2e'],
    },
    {
      type: 'compatibility',
      script: 'test:compat',
      command: commands.compat,
      oracles: ['tests/compat'],
    },
    {
      type: 'browser',
      script: 'test:browser',
      command: commands.browser,
      oracles: [
        'tests/browser',
        'examples/epoch-consumer/test/sdk-browser.playwright.mjs',
      ],
    },
    {
      type: 'behavior',
      script: 'test:behavior',
      command: 'node scripts/run-gate.mjs behavior',
      oracles: ['tests/behavior'],
    },
    {
      type: 'snapshot',
      script: 'test',
      command: commands.test,
      oracles: [
        'packages/canonical/test/snapshot.test.ts',
        'packages/lock-import/src/snapshot.test.ts',
        'packages/adapter-core/src/host-fetch.snapshot.test.ts',
        'packages/opm-project/test/host-fetch.snapshot.test.ts',
        'packages/opm-project/test/update.test.ts',
        'packages/adapter-maven/src/index.test.ts',
      ],
      vitest: [
        'packages/canonical/test/snapshot.test.ts',
        'packages/lock-import/src/snapshot.test.ts',
        'packages/adapter-core/src/host-fetch.snapshot.test.ts',
        'packages/opm-project/test/host-fetch.snapshot.test.ts',
        'packages/opm-project/test/update.test.ts',
        'packages/adapter-maven/src/index.test.ts',
      ],
    },
    {
      type: 'fuzz',
      script: 'test:fuzz',
      command: commands.fuzz,
      oracles: [
        'scripts/fuzz-smoke.mjs',
        'tests/fuzz/upm-auth-config.mjs',
        'tests/fuzz/upm-maven-pom.mjs',
      ],
    },
    {
      type: 'pact',
      script: 'coverage',
      command: commands.coverage,
      oracles: ['examples/epoch-consumer/test/pact.consumer.test.ts'],
      vitest: ['examples/epoch-consumer/test/pact.consumer.test.ts'],
    },
    {
      type: 'chaos',
      script: 'coverage',
      command: commands.coverage,
      oracles: [
        'examples/epoch-consumer/test/pact.chaos.test.ts',
        'packages/adapter-core/src/host-fetch.chaos.test.ts',
        'packages/opm-project/test/shared-store.chaos.test.ts',
        'apps/openpackerd/test/publish.chaos.test.ts',
      ],
      vitest: [
        'examples/epoch-consumer/test/pact.chaos.test.ts',
        'packages/adapter-core/src/host-fetch.chaos.test.ts',
        'packages/opm-project/test/shared-store.chaos.test.ts',
        'apps/openpackerd/test/publish.chaos.test.ts',
      ],
    },
    {
      type: 'mutation',
      script: 'coverage',
      command: commands.coverage,
      oracles: [
        'examples/epoch-consumer/test/pact.mutation.test.ts',
        'packages/opm-project/test/host-fetch.mutation.test.ts',
        'packages/opm-project/test/update.mutation.test.ts',
        'packages/adapter-maven/src/inspect.mutation.test.ts',
      ],
      vitest: [
        'examples/epoch-consumer/test/pact.mutation.test.ts',
        'packages/opm-project/test/host-fetch.mutation.test.ts',
        'packages/opm-project/test/update.mutation.test.ts',
        'packages/adapter-maven/src/inspect.mutation.test.ts',
      ],
    },
    {
      type: 'mutation',
      script: 'test',
      command: commands.test,
      oracles: ['tests/property/prex.test.mjs'],
    },
    {
      type: 'pack-parity',
      script: 'test:pack-parity',
      command: commands.parity,
      oracles: [
        'packages/adapters-default/src/standard-pack.test.ts',
        'packages/adapters-default/src/standard-pack.native.test.ts',
      ],
      vitest: [
        'packages/adapters-default/src/standard-pack.test.ts',
        'packages/adapters-default/src/standard-pack.native.test.ts',
      ],
    },
    {
      type: 'pack-parity-native',
      script: 'test:pack-parity:native',
      command: commands.nativeParity,
      oracles: ['scripts/pack-parity-container.mjs'],
    },
    {
      type: 'live-oci',
      script: 'test:live',
      command: commands.live,
      oracles: ['packages/oci/scripts/live-interop.mjs'],
    },
    {
      type: 'live-oci',
      owner: 'packages/oci',
      script: 'test:live',
      command: 'node scripts/live-interop.mjs',
      oracles: ['packages/oci/scripts/live-interop.mjs'],
    },
    {
      type: 'live-nix',
      script: 'test:live',
      command: commands.live,
      oracles: ['packages/adapter-nix/test/provider.live.test.ts'],
      vitest: ['packages/adapter-nix/test/provider.live.test.ts'],
    },
    {
      type: 'live-nix',
      owner: 'packages/adapter-nix',
      script: 'test:live',
      command: 'OPENPACKER_LIVE_NIX=1 vitest run test/provider.live.test.ts',
      oracles: ['packages/adapter-nix/test/provider.live.test.ts'],
      vitest: ['packages/adapter-nix/test/provider.live.test.ts'],
    },
  ];
  const hasOracle = (path) => {
    const absolute = join(root, path);
    if (!existsSync(absolute)) return false;
    if (!statSync(absolute).isDirectory()) return true;
    return filesIn(absolute).some((file) => testFile.test(file));
  };
  const runnableByFile = new Map();
  for (const test of discovered) {
    const path = relative(root, test.file);
    runnableByFile.set(
      path,
      (runnableByFile.get(path) ?? false) || test.runnable,
    );
  }
  const scriptsByOwner = new Map([
    ['root', rootScripts],
    ...[...manifests].map(([workspace, manifest]) => [
      workspace,
      manifest.scripts ?? {},
    ]),
  ]);
  const failures = [
    ...workspaceInventoryFailures(rows),
    ...authorityInventoryFailures(
      authorities,
      scriptsByOwner,
      hasOracle,
      (path) => runnableByFile.get(path) === true,
    ),
  ];
  if (failures.length) throw new Error(failures.join('\n'));
  const discoveredTests = rows.reduce(
    (sum, row) => sum + row.discoveredTests,
    0,
  );
  const runnableTests = rows.reduce((sum, row) => sum + row.activeTests, 0);
  console.log(
    `test inventory: ${workspaces.length} workspaces, ${runnableTests}/${discoveredTests} runnable/discovered tests, ${new Set(authorities.map(({ type }) => type)).size} test types`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await checkTestInventory(resolve(import.meta.dirname, '..'));

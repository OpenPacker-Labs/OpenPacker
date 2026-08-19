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
    if (!/(?:^|\s)vitest\s+run(?:\s|$)/u.test(row.testScript ?? ''))
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

export function authorityInventoryFailures(authorities, scripts, hasOracle) {
  return authorities.flatMap(({ type, script, commandIncludes, paths }) => {
    const command = scripts[script] ?? '';
    const failures = [];
    if (!command) failures.push(`${type}: missing ${script} script`);
    else if (!command.includes(commandIncludes))
      failures.push(`${type}: ${script} is not bound to ${commandIncludes}`);
    for (const path of paths)
      if (!hasOracle(path)) failures.push(`${type}: missing oracle ${path}`);
    return failures;
  });
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
  const rows = workspaces.map((workspace) => {
    const manifest = JSON.parse(
      readFileSync(join(root, workspace, 'package.json'), 'utf8'),
    );
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

  const authorities = [
    ['unit', 'test', 'run-gate.mjs unit', ['tests/unit']],
    ['property', 'test', 'run-gate.mjs unit', ['tests/property']],
    [
      'conformance',
      'test:conformance',
      'run-gate.mjs conformance',
      ['tests/conformance', 'packages/conformance/test'],
    ],
    [
      'security',
      'test:security',
      'run-gate.mjs security',
      ['tests/security', 'packages/sandbox/src/escape.test.ts'],
    ],
    [
      'integration',
      'test:integration',
      'run-gate.mjs integration',
      ['tests/integration', 'integrations/mise/test'],
    ],
    ['e2e', 'test:e2e', 'run-gate.mjs e2e', ['tests/e2e']],
    ['compatibility', 'test:compat', 'run-gate.mjs compat', ['tests/compat']],
    [
      'browser',
      'test:browser',
      'run-gate.mjs browser',
      [
        'tests/browser',
        'examples/epoch-consumer/test/sdk-browser.playwright.mjs',
      ],
    ],
    ['fuzz', 'test:fuzz', 'fuzz-smoke.mjs', ['scripts/fuzz-smoke.mjs']],
    [
      'pact',
      'coverage',
      'coverage.mjs',
      ['examples/epoch-consumer/test/pact.consumer.test.ts'],
    ],
    [
      'chaos',
      'coverage',
      'coverage.mjs',
      ['examples/epoch-consumer/test/pact.chaos.test.ts'],
    ],
    [
      'mutation',
      'coverage',
      'coverage.mjs',
      ['examples/epoch-consumer/test/pact.mutation.test.ts'],
    ],
    ['mutation', 'test', 'run-gate.mjs unit', ['tests/property/prex.test.mjs']],
    [
      'pack-parity',
      'test:pack-parity',
      'standard-pack.test.ts',
      [
        'packages/adapters-default/src/standard-pack.test.ts',
        'packages/adapters-default/src/standard-pack.native.test.ts',
      ],
    ],
    [
      'pack-parity-native',
      'test:pack-parity:native',
      'pack-parity-container.mjs',
      ['scripts/pack-parity-container.mjs'],
    ],
    [
      'live-oci',
      'test:live',
      '@openpacker/oci',
      ['packages/oci/scripts/live-interop.mjs'],
    ],
    [
      'live-nix',
      'test:live',
      '@openpacker/adapter-nix',
      ['packages/adapter-nix/test/provider.live.test.ts'],
    ],
  ].map(([type, script, commandIncludes, paths]) => ({
    type,
    script,
    commandIncludes,
    paths,
  }));
  const scripts = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ).scripts;
  const hasOracle = (path) => {
    const absolute = join(root, path);
    if (!existsSync(absolute)) return false;
    if (!statSync(absolute).isDirectory()) return true;
    return filesIn(absolute).some((file) => testFile.test(file));
  };
  const failures = [
    ...workspaceInventoryFailures(rows),
    ...authorityInventoryFailures(authorities, scripts, hasOracle),
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

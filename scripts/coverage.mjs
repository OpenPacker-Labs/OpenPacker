#!/usr/bin/env node
// Runs vitest once with scripts/vitest.coverage.config.mjs (single worker,
// serial files) so V8 precise-coverage snapshots merge deterministically.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import {
  coverageFailures,
  coverageThresholds as thresholds,
} from './coverage-policy.mjs';

const root = resolve(import.meta.dirname, '..');
const coverage = join(root, 'coverage');
const raw = join(coverage, 'raw');
const workspaceRoots = ['apps', 'examples', 'packages'];
const workspaces = workspaceRoots
  .flatMap((directory) =>
    readdirSync(join(root, directory), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name)),
  )
  .filter((workspace) => existsSync(join(root, workspace, 'package.json')))
  .sort();
rmSync(raw, { recursive: true, force: true });
mkdirSync(raw, { recursive: true });

const result = spawnSync(
  'npm',
  [
    'exec',
    '--',
    'vitest',
    'run',
    'packages',
    'apps',
    'examples',
    '--config',
    'scripts/vitest.coverage.config.mjs',
  ],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, OPENPACKER_V8_COVERAGE: raw },
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

function filesMatching(directory, predicate) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesMatching(path, predicate);
    return predicate(entry.name) ? [relative(root, path)] : [];
  });
}

const workspaceTests = new Map(
  workspaces.map((workspace) => [
    workspace,
    filesMatching(join(root, workspace), (name) =>
      /\.(?:test|spec)\.(?:[cm]?js|tsx?)$/u.test(name),
    ),
  ]),
);
const missingTests = [...workspaceTests]
  .filter(([, tests]) => tests.length === 0)
  .map(([workspace]) => workspace);
if (missingTests.length)
  throw new Error(`workspaces without tests: ${missingTests.join(', ')}`);

const expectedFiles = workspaces
  .flatMap((workspace) => {
    const source = join(root, workspace, 'src');
    return filesMatching(
      source,
      (name) =>
        name.endsWith('.ts') &&
        !name.endsWith('.test.ts') &&
        !name.endsWith('.d.ts'),
    );
  })
  .sort();
const functionsByFile = new Map(expectedFiles.map((file) => [file, new Map()]));
for (const name of readdirSync(raw).filter((entry) =>
  entry.endsWith('.json'),
)) {
  const payload = JSON.parse(readFileSync(join(raw, name), 'utf8'));
  for (const script of payload.result ?? []) {
    if (!script.url.startsWith('file:')) continue;
    const path = new URL(script.url).pathname;
    if (!path.startsWith(root)) continue;
    const file = relative(root, path);
    const recorded = functionsByFile.get(file);
    if (!recorded) continue;
    for (const fn of script.functions ?? []) {
      const range = fn.ranges?.[0];
      if (!range) continue;
      const key = `${fn.functionName}:${range.startOffset}:${range.endOffset}`;
      recorded.set(key, Math.max(recorded.get(key) ?? 0, range.count ?? 0));
    }
  }
}
const perFile = expectedFiles.map((file) => {
  const counts = [...functionsByFile.get(file).values()];
  const coveredFunctions = counts.filter((count) => count > 0).length;
  return {
    file,
    instrumented: counts.length > 0,
    functions: counts.length,
    coveredFunctions,
    functionPercent:
      counts.length === 0
        ? null
        : Number(((coveredFunctions / counts.length) * 100).toFixed(2)),
  };
});
const instrumentedFiles = perFile.filter(({ instrumented }) => instrumented);
const functions = instrumentedFiles.reduce(
  (sum, file) => sum + file.functions,
  0,
);
const coveredFunctions = instrumentedFiles.reduce(
  (sum, file) => sum + file.coveredFunctions,
  0,
);
if (instrumentedFiles.length === 0 || functions === 0)
  throw new Error(
    'V8 coverage contained no OpenPacker source; refusing an empty report',
  );
const instrumentedFilesPercent = Number(
  ((instrumentedFiles.length / expectedFiles.length) * 100).toFixed(2),
);
const functionPercent = Number(
  ((coveredFunctions / functions) * 100).toFixed(2),
);
const workspaceCoverage = workspaces.map((workspace) => {
  const files = perFile.filter(({ file }) => file.startsWith(`${workspace}/`));
  const instrumented = files.filter((file) => file.instrumented);
  const workspaceFunctions = instrumented.reduce(
    (sum, file) => sum + file.functions,
    0,
  );
  const workspaceCoveredFunctions = instrumented.reduce(
    (sum, file) => sum + file.coveredFunctions,
    0,
  );
  return {
    workspace,
    tests: workspaceTests.get(workspace).length,
    sourceFiles: files.length,
    instrumentedFiles: instrumented.length,
    instrumentedFilesPercent: Number(
      ((instrumented.length / files.length) * 100).toFixed(2),
    ),
    functions: workspaceFunctions,
    coveredFunctions: workspaceCoveredFunctions,
    functionPercent: Number(
      ((workspaceCoveredFunctions / workspaceFunctions) * 100).toFixed(2),
    ),
  };
});
const summary = {
  schemaVersion: 'org.openpacker.coverage-summary.v1',
  thresholds,
  sourceFiles: expectedFiles.length,
  instrumentedFiles: instrumentedFiles.length,
  instrumentedFilesPercent,
  functions,
  coveredFunctions,
  functionPercent,
  workspaces: workspaceCoverage,
  perFile,
};
writeFileSync(
  join(coverage, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(
  `coverage: ${instrumentedFilesPercent}% files, ${functionPercent}% functions across ${workspaceCoverage.length} workspaces`,
);
for (const workspace of workspaceCoverage)
  console.log(
    `${workspace.workspace}: ${workspace.instrumentedFilesPercent}% files, ${workspace.functionPercent}% functions, ${workspace.tests} test files`,
  );
const failingWorkspaces = coverageFailures(workspaceCoverage, thresholds);
if (failingWorkspaces.length)
  throw new Error(
    `workspace coverage below threshold: ${failingWorkspaces
      .map(
        (workspace) =>
          `${workspace.workspace} files ${workspace.instrumentedFilesPercent}%/${thresholds.instrumentedFilesPercent}%, functions ${workspace.functionPercent}%/${thresholds.functionPercent}%`,
      )
      .join('; ')}`,
  );
if (
  coverageFailures(
    [
      {
        sourceFiles: expectedFiles.length,
        instrumentedFiles: instrumentedFiles.length,
        instrumentedFilesPercent,
        functions,
        functionPercent,
      },
    ],
    thresholds,
  ).length
)
  throw new Error(
    `coverage below threshold: files ${instrumentedFilesPercent}%/${thresholds.instrumentedFilesPercent}%, functions ${functionPercent}%/${thresholds.functionPercent}%`,
  );

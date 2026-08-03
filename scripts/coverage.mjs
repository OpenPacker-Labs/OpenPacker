#!/usr/bin/env node
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const coverage = join(root, 'coverage');
const raw = join(coverage, 'raw');
const thresholds = { instrumentedFilesPercent: 80, functionPercent: 70 };
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

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
      ? [relative(root, path)]
      : [];
  });
}

const expectedFiles = ['packages', 'apps']
  .flatMap((directory) => sourceFiles(join(root, directory)))
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
const summary = {
  schemaVersion: 'org.openpacker.coverage-summary.v1',
  thresholds,
  sourceFiles: expectedFiles.length,
  instrumentedFiles: instrumentedFiles.length,
  instrumentedFilesPercent,
  functions,
  coveredFunctions,
  functionPercent,
  perFile,
};
writeFileSync(
  join(coverage, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary));
if (
  instrumentedFilesPercent < thresholds.instrumentedFilesPercent ||
  functionPercent < thresholds.functionPercent
)
  throw new Error(
    `coverage below threshold: files ${instrumentedFilesPercent}%/${thresholds.instrumentedFilesPercent}%, functions ${functionPercent}%/${thresholds.functionPercent}%`,
  );

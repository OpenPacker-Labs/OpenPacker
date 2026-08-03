#!/usr/bin/env node
/**
 * Offline demo: import native lock fixtures under native-capture-v1 and write
 * openpacker.lock.json digests for npm, Cargo, NuGet, PyPI, Go, and Maven.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalDigest, formatDigest } from '@openpacker/canonical';
import { createEmbeddedResolver } from '@openpacker/embedded';
import * as bindings from '@openpacker/embedded/wasm-node';
import {
  completeLockImport,
  planNativeLockImport,
} from '@openpacker/lock-import';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.demo-output', 'lock-import');
const fixtures = [
  ['npm', 'fixtures/locks/npm/package-lock.json'],
  ['cargo', 'fixtures/locks/cargo/Cargo.lock'],
  ['nuget', 'fixtures/locks/nuget/project.assets.json'],
  ['pypi', 'fixtures/locks/pypi/uv.lock.json'],
  ['golang', 'fixtures/locks/golang/go.sum'],
  ['maven', 'fixtures/locks/maven/gradle.lockfile'],
];

const resolver = createEmbeddedResolver(bindings);
const resolverBuildDigest = await canonicalDigest({
  implementation: 'openpacker-lock-import-demo',
  version: '0.1.0',
});

await mkdir(outDir, { recursive: true });
const summary = [];

for (const [name, relative] of fixtures) {
  const raw = await readFile(join(root, relative), 'utf8');
  const plan = await planNativeLockImport(raw);
  const result = await completeLockImport(plan, resolver, {
    providerId: 'org.openpacker.demo.lock-import',
    version: '0.1.0',
    resolverBuildDigest,
  });
  if (
    result.solveResponse.normalizedRequest.semantics.profile !==
    'native-capture-v1'
  )
    throw new Error(`${name}: expected native-capture-v1`);
  if (
    !result.semanticLoss.some(
      (loss) => loss.code === 'NATIVE_RESULT_CAPTURE_ONLY',
    )
  )
    throw new Error(`${name}: missing NATIVE_RESULT_CAPTURE_ONLY`);

  const lockPath = join(outDir, `${name}.openpacker.lock.json`);
  await writeFile(
    lockPath,
    `${JSON.stringify(result.lockfile, null, 2)}\n`,
    'utf8',
  );
  summary.push({
    ecosystem: name,
    source: relative,
    selectedExactPurls: result.lockfile.selectedExactPurls,
    solutionDigest: formatDigest(result.solveResponse.solution.solutionDigest),
    receiptDigest: formatDigest(result.lockfile.receiptDigest),
    lockfile: lockPath,
  });
  console.log(
    `lock-import ${name}: ${result.lockfile.selectedExactPurls.length} packages → ${formatDigest(result.solveResponse.solution.solutionDigest)}`,
  );
}

await writeFile(
  join(outDir, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
  'utf8',
);
console.log(`wrote ${summary.length} lock imports to ${outDir}`);

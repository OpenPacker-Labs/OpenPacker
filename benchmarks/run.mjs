#!/usr/bin/env node
import { performance } from 'node:perf_hooks';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalize, formatDigest, sha256 } from '@openpacker/canonical';
import { packageNodeId, parseVers } from '@openpacker/adapter-core';
import { NpmCodec } from '@openpacker/adapter-npm';
import { CatalogSnapshotBuilder } from '@openpacker/catalog';
import {
  collectStream,
  descriptorForBytes,
  streamFromBytes,
  verifyBytes,
} from '@openpacker/artifact-model';
import { createChunkIndex } from '@openpacker/chunking';
import { loadEmbeddedResolver } from '@openpacker/embedded';
import { loadNativeEmbeddedResolver } from '@openpacker/embedded/native';

const root = resolve(import.meta.dirname, '..');
const baseline = JSON.parse(
  readFileSync(join(root, 'benchmarks/baseline.json'), 'utf8'),
);
const solveInput = JSON.parse(
  readFileSync(join(root, 'tests/fixtures/bounded-solve.json'), 'utf8'),
);
const iterations = baseline.iterations;
const codec = new NpmCodec();

async function syntheticSolveInput(packageCount) {
  const input = structuredClone(solveInput);
  // Large synthetic runs measure Resolvo validity/proof throughput only. PREX
  // optimization claims above the bounded independent oracle fail closed.
  if (packageCount > 22)
    input.request.objectives = [
      'satisfy-hard-constraints',
      'exclude-lifecycle-denied',
    ];
  const template = input.universe.packages[0];
  input.universe.packages = [];
  for (let index = 0; index < packageCount; index += 1) {
    const digest = index.toString(16).padStart(64, '0');
    const exactPurl =
      index === 0 ? 'pkg:npm/demo@1.0.0' : `pkg:npm/benchmark-${index}@1.0.0`;
    const packageInstance = {
      ...structuredClone(template),
      nodeId: await packageNodeId({
        exactPurl,
        nativeSemanticsVersion: template.nativeSemantics.version,
      }),
      identity: {
        ...structuredClone(template.identity),
        canonicalPurl:
          index === 0 ? 'pkg:npm/demo' : `pkg:npm/benchmark-${index}`,
        exactPurl,
        name: index === 0 ? 'demo' : `benchmark-${index}`,
      },
      metadataDigest:
        index === 0
          ? structuredClone(template.metadataDigest)
          : { algorithm: 'sha256', value: digest },
    };
    packageInstance.requirements =
      index + 1 < packageCount
        ? [
            {
              id: `${packageInstance.nodeId}:next`,
              dependerNodeId: packageInstance.nodeId,
              expression: {
                type: 'package',
                purl: `pkg:npm/benchmark-${index + 1}`,
              },
              kind: 'runtime',
              optional: false,
              source: {
                type: 'metadata',
                uri: 'https://fixtures.openpacker.dev/benchmark',
              },
              authority: 'test-fixture',
              semanticLoss: [],
            },
          ]
        : [];
    input.universe.packages.push(packageInstance);
  }
  return input;
}

function cpuMilliseconds(start) {
  const elapsed = process.cpuUsage(start);
  return (elapsed.user + elapsed.system) / 1_000;
}

function measure(name, operation) {
  for (let index = 0; index < 250; index += 1) operation(index);
  const start = process.cpuUsage();
  for (let index = 0; index < iterations; index += 1) operation(index);
  const milliseconds = cpuMilliseconds(start);
  const threshold = baseline.thresholdsMilliseconds[name];
  if (!(milliseconds <= threshold))
    throw new Error(
      `${name}: ${milliseconds.toFixed(2)}ms exceeds ${threshold}ms threshold`,
    );
  return {
    clock: 'cpu',
    iterations,
    milliseconds,
    operationsPerSecond: (iterations * 1000) / milliseconds,
    thresholdMilliseconds: threshold,
  };
}

async function measureAsync(name, iterations, operation, warmup = 1) {
  for (let index = 0; index < warmup; index += 1) await operation(index);
  const start = process.cpuUsage();
  for (let index = 0; index < iterations; index += 1) await operation(index);
  const milliseconds = cpuMilliseconds(start);
  const threshold = baseline.thresholdsMilliseconds[name];
  if (!(milliseconds <= threshold))
    throw new Error(
      `${name}: ${milliseconds.toFixed(2)}ms exceeds ${threshold}ms threshold`,
    );
  return {
    clock: 'cpu',
    iterations,
    milliseconds,
    operationsPerSecond: (iterations * 1000) / milliseconds,
    thresholdMilliseconds: threshold,
  };
}

const packageInstance = solveInput.universe.packages[0];
const zero = solveInput.universe.canonicalDigest;

const results = {
  'canonical-json': measure('canonical-json', (index) =>
    canonicalize({
      index,
      name: 'fixture',
      nested: { stable: true },
      values: [3, 2, 1],
    }),
  ),
  'npm-purl': measure('npm-purl', (index) =>
    codec.canonicalizePurl(`pkg:npm/%40OpenPacker%2Fdemo@1.2.${index % 100}`),
  ),
  'npm-vers-membership': measure('npm-vers-membership', (index) =>
    codec.satisfies(`1.${index % 50}.${index % 100}`, '>=1.10.0 <2.0.0'),
  ),
  'vers-parse': measure('vers-parse', (index) =>
    parseVers(`vers:npm/>=1.${index % 50}.0|<2.0.0`),
  ),
};

results['catalog-snapshot-100-records-20'] = await measureAsync(
  'catalog-snapshot-100-records-20',
  20,
  async (index) => {
    const builder = new CatalogSnapshotBuilder(
      'benchmark',
      'fixture',
      'https://fixtures.openpacker.dev',
      '2026-08-02T00:00:00Z',
      '2026-08-02T00:00:00Z',
    );
    for (let record = 0; record < 100; record += 1) {
      const exactPurl = `pkg:npm/catalog-${record}@1.0.0`;
      builder.add({
        key: `demo-${index}-${record}`,
        package: {
          ...structuredClone(packageInstance),
          nodeId: await packageNodeId({
            exactPurl,
            nativeSemanticsVersion: packageInstance.nativeSemantics.version,
          }),
          identity: {
            ...structuredClone(packageInstance.identity),
            canonicalPurl: `pkg:npm/catalog-${record}`,
            exactPurl,
            name: `catalog-${record}`,
          },
        },
        rawMetadata: { index, record },
        provenance: {
          providerId: 'benchmark',
          endpoint: 'https://fixtures.openpacker.dev',
          retrievedAt: '2026-08-02T00:00:00Z',
          evaluationTime: '2026-08-02T00:00:00Z',
          metadataDigest: zero,
        },
        semanticLoss: [],
      });
    }
    await builder.build();
  },
);

const loadStart = performance.now();
const embedded = await loadEmbeddedResolver(async () => {
  const module = await import('@openpacker/embedded/wasm-node');
  return typeof module.default === 'object' ? module.default : module;
});
const loadMilliseconds = performance.now() - loadStart;
if (loadMilliseconds > baseline.thresholdsMilliseconds['wasm-load'])
  throw new Error(
    `wasm-load: ${loadMilliseconds.toFixed(2)}ms exceeds threshold`,
  );
results['wasm-load'] = {
  clock: 'wall',
  iterations: 1,
  milliseconds: loadMilliseconds,
  operationsPerSecond: 1000 / loadMilliseconds,
  thresholdMilliseconds: baseline.thresholdsMilliseconds['wasm-load'],
};
const coldStart = performance.now();
const solved = embedded.solve(solveInput);
const coldMilliseconds = performance.now() - coldStart;
if (coldMilliseconds > baseline.thresholdsMilliseconds['solver-cold-wasm'])
  throw new Error(
    `solver-cold-wasm: ${coldMilliseconds.toFixed(2)}ms exceeds threshold`,
  );
results['solver-cold-wasm'] = {
  clock: 'wall',
  iterations: 1,
  milliseconds: coldMilliseconds,
  operationsPerSecond: 1000 / coldMilliseconds,
  thresholdMilliseconds: baseline.thresholdsMilliseconds['solver-cold-wasm'],
};
results['solver-warm-proof-explanation-200'] = await measureAsync(
  'solver-warm-proof-explanation-200',
  200,
  () => embedded.solve(solveInput),
  10,
);
const mediumSolveInput = await syntheticSolveInput(100);
const largeSolveInput = await syntheticSolveInput(1_000);
results['solver-medium-100-warm-20'] = await measureAsync(
  'solver-medium-100-warm-20',
  20,
  () => embedded.solve(mediumSolveInput),
  2,
);
results['solver-large-1000-warm-1'] = await measureAsync(
  'solver-large-1000-warm-1',
  1,
  () => embedded.solve(largeSolveInput),
  1,
);
results['proof-check-1000'] = await measureAsync(
  'proof-check-1000',
  1_000,
  () => embedded.check(solveInput, solved),
  10,
);
results['explanation-canonical-1000'] = await measureAsync(
  'explanation-canonical-1000',
  1_000,
  () => canonicalize(solved.explanation),
  10,
);
results['oracle-100'] = await measureAsync(
  'oracle-100',
  100,
  () => embedded.bruteForceOracle(solveInput),
  5,
);

const nativeLoadStart = performance.now();
const native = await loadNativeEmbeddedResolver();
const nativeLoadMilliseconds = performance.now() - nativeLoadStart;
if (nativeLoadMilliseconds > baseline.thresholdsMilliseconds['native-load'])
  throw new Error(
    `native-load: ${nativeLoadMilliseconds.toFixed(2)}ms exceeds threshold`,
  );
results['native-load'] = {
  clock: 'wall',
  iterations: 1,
  milliseconds: nativeLoadMilliseconds,
  operationsPerSecond: 1000 / nativeLoadMilliseconds,
  thresholdMilliseconds: baseline.thresholdsMilliseconds['native-load'],
};
const nativeColdStart = performance.now();
const nativeSolved = native.solve(solveInput);
const nativeColdMilliseconds = performance.now() - nativeColdStart;
if (
  nativeColdMilliseconds > baseline.thresholdsMilliseconds['solver-cold-native']
)
  throw new Error(
    `solver-cold-native: ${nativeColdMilliseconds.toFixed(2)}ms exceeds threshold`,
  );
if (canonicalize(nativeSolved) !== canonicalize(solved))
  throw new Error('native and WASM benchmark solves disagree');
results['solver-cold-native'] = {
  clock: 'wall',
  iterations: 1,
  milliseconds: nativeColdMilliseconds,
  operationsPerSecond: 1000 / nativeColdMilliseconds,
  thresholdMilliseconds: baseline.thresholdsMilliseconds['solver-cold-native'],
};
results['solver-warm-native-proof-explanation-200'] = await measureAsync(
  'solver-warm-native-proof-explanation-200',
  200,
  () => native.solve(solveInput),
  10,
);
results['native-proof-check-1000'] = await measureAsync(
  'native-proof-check-1000',
  1_000,
  () => native.check(solveInput, nativeSolved),
  10,
);

const bytes = new Uint8Array(8 * 1024 * 1024);
for (let index = 0; index < bytes.length; index += 1)
  bytes[index] = index & 0xff;
const descriptor = await descriptorForBytes({
  bytes,
  descriptorId: 'benchmark',
  mediaType: 'application/octet-stream',
  artifactType: 'benchmark',
  nativeRole: 'fixture',
});
const verifyFixture = bytes.subarray(0, 1_024);
const verifyDigest = formatDigest(await sha256(verifyFixture));
const heapBefore = process.memoryUsage().heapUsed;
results['oci-stream-8mib'] = await measureAsync(
  'oci-stream-8mib',
  1,
  async () => {
    const collected = await collectStream(
      streamFromBytes(bytes),
      bytes.byteLength,
    );
    await verifyBytes(descriptor, collected);
  },
  0,
);
const heapGrowth = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
if (heapGrowth > baseline.thresholdsBytes['oci-stream-heap-growth'])
  throw new Error(`oci-stream heap growth ${heapGrowth} exceeds threshold`);
results['oci-stream-8mib'].heapGrowthBytes = heapGrowth;
results['oci-stream-8mib'].heapGrowthThresholdBytes =
  baseline.thresholdsBytes['oci-stream-heap-growth'];
results['chunking-8mib'] = await measureAsync(
  'chunking-8mib',
  1,
  () => createChunkIndex(streamFromBytes(bytes), descriptor),
  0,
);
results['digest-8mib'] = await measureAsync(
  'digest-8mib',
  1,
  () => sha256(bytes),
  0,
);
results['wasm-artifact-verify-1000'] = await measureAsync(
  'wasm-artifact-verify-1000',
  1_000,
  () => {
    if (!embedded.verifyArtifactDigest(verifyFixture, verifyDigest))
      throw new Error(
        'WASM digest verification rejected the benchmark fixture',
      );
  },
  10,
);
results['native-artifact-verify-1000'] = await measureAsync(
  'native-artifact-verify-1000',
  1_000,
  () => {
    if (!native.verifyArtifactDigest(verifyFixture, verifyDigest))
      throw new Error(
        'native digest verification rejected the benchmark fixture',
      );
  },
  10,
);

const report = {
  schemaVersion: 'org.openpacker.benchmark-report.v1',
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  methodology: {
    catalogRecordsPerSnapshot: 100,
    solverMedium: { nodes: 100, dependencyEdges: 99 },
    solverLarge: { nodes: 1_000, dependencyEdges: 999 },
    boundedOracleNodes: solveInput.universe.packages.length,
    artifactBytes: bytes.byteLength,
  },
  results,
};
mkdirSync(join(root, '.demo-output'), { recursive: true });
writeFileSync(
  join(root, '.demo-output/benchmark-report.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
for (const [name, result] of Object.entries(results))
  console.log(
    `${name}: ${result.milliseconds.toFixed(2)}ms, ${result.operationsPerSecond < 100 ? result.operationsPerSecond.toFixed(2) : Math.round(result.operationsPerSecond)} ops/s (limit ${result.thresholdMilliseconds}ms)`,
  );

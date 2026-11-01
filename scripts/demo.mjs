#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = join(root, '.demo-output');
const evaluationTime = '2026-08-02T00:00:00Z';

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      OPENPACKER_OFFLINE: '1',
      PACT_DO_NOT_TRACK: 'true',
      SOURCE_DATE_EPOCH: '1785628800',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed with exit ${result.status}`,
    );
}

function files(directory) {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

if (!process.argv.includes('--no-build')) {
  run('npm', ['run', 'build']);
  run('cargo', ['build', '--workspace', '--all-features', '--locked']);
}

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const cliCandidates = [
  'apps/openpacker-cli/dist/main.js',
  'apps/openpacker-cli/dist/esm/index.js',
  'apps/openpacker-cli/dist/cli.js',
].map((path) => join(root, path));
const cli = cliCandidates.find(existsSync);
if (!cli)
  throw new Error(
    `built OpenPacker CLI not found; checked ${cliCandidates.map((path) => relative(root, path)).join(', ')}`,
  );

run(process.execPath, [
  cli,
  'demo',
  '--offline',
  '--output',
  output,
  '--evaluation-time',
  evaluationTime,
  '--workflow-module',
  join(root, 'scripts/demo-workflow.mjs'),
]);

const required = [
  'demo-result.json',
  'openpacker.lock.json',
  'explanation.json',
  'receipt.json',
  'ocm-graph.json',
  'solution.cdx.json',
  'events.ndjson',
  'oci-layout/index.json',
];
for (const path of required)
  if (!existsSync(join(output, path)))
    throw new Error(`demo omitted mandatory artifact: ${path}`);

const canonicalMiseFiles = new Set([
  'mise/data/installs/openpacker-demo/1.0.0/.openpacker-mise.json',
  'mise/data/installs/openpacker-demo/1.0.0/bin/openpacker-demo',
]);

const result = JSON.parse(
  readFileSync(join(output, 'demo-result.json'), 'utf8'),
);
if (result.success !== true)
  throw new Error('demo-result.json does not attest successful verification');
const modeDigests = result.modeDigests;
if (!modeDigests || typeof modeDigests !== 'object')
  throw new Error('demo result omitted cross-runtime mode digests');
for (const field of ['request', 'universe', 'solution', 'unsignedReceipt']) {
  const values = Object.values(modeDigests).map((mode) => mode?.[field]);
  if (
    values.length < 6 ||
    values.some((value) => typeof value !== 'string') ||
    new Set(values).size !== 1
  ) {
    throw new Error(
      `cross-runtime ${field} digest mismatch or fewer than six successful modes`,
    );
  }
}

const index = {
  schemaVersion: 'org.openpacker.demo-index.v1',
  evaluationTime,
  files: files(output)
    .filter((path) => {
      const name = relative(output, path).replaceAll('\\', '/');
      return (
        name !== 'index.json' &&
        (!name.startsWith('mise/') || canonicalMiseFiles.has(name))
      );
    })
    .map((path) => {
      const bytes = readFileSync(path);
      return {
        path: relative(output, path).replaceAll('\\', '/'),
        size: bytes.byteLength,
        digest: digest(bytes),
      };
    }),
};
writeFileSync(
  join(output, 'index.json'),
  `${JSON.stringify(index, null, 2)}\n`,
);
for (const file of index.files)
  console.log(`${file.digest}  ${file.path} (${file.size} bytes)`);
console.log(`${digest(readFileSync(join(output, 'index.json')))}  index.json`);

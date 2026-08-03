#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';

const root = resolve(import.meta.dirname, '..');
const sourceDirectory = join(root, '.demo-output/golden-source');
const demoOutputUri = pathToFileURL(join(root, '.demo-output')).href;
const portableDemoOutputUri = 'file:///OPENPACKER_DEMO_OUTPUT';
const destinationDirectory = join(root, 'fixtures/golden');
const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || arguments_.some((value) => value !== '--check'))
  throw new Error('Usage: node scripts/generate-goldens.mjs [--check]');
const check = arguments_[0] === '--check';
const prettierConfig =
  (await resolveConfig(join(destinationDirectory, 'manifest.json'))) ?? {};
const kinds = [
  'normalize',
  'identity',
  'enumeration',
  'snapshot',
  'universe',
  'solution',
  'proof',
  'explanation',
  'unsatisfiable',
  'receipt',
  'lockfile',
  'lifecycle',
  'event',
  'oci',
  'ocm',
  'tuf',
  'sigstore',
  'slsa',
  'cyclonedx',
];

function stable(value) {
  if (typeof value === 'string' && value.startsWith(demoOutputUri))
    return `${portableDemoOutputUri}${value.slice(demoOutputUri.length)}`;
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

async function bytes(value, filepath) {
  return Buffer.from(
    await format(JSON.stringify(stable(value)), {
      ...prettierConfig,
      filepath,
    }),
  );
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function emit(file, output) {
  if (!check) return writeFile(join(root, file), output);
  const committed = await readFile(join(root, file)).catch(() => undefined);
  if (!committed?.equals(output))
    throw new Error(
      `Committed golden differs from authoritative demo: ${file}`,
    );
}

const demoResult = JSON.parse(
  await readFile(join(root, '.demo-output/demo-result.json'), 'utf8'),
);
if (demoResult.success !== true)
  throw new Error('Run `npm run demo` successfully before generating goldens');

if (!check) await mkdir(destinationDirectory, { recursive: true });
const entries = [];
for (const kind of kinds) {
  const source = join(sourceDirectory, `${kind}.json`);
  let value;
  try {
    value = JSON.parse(await readFile(source, 'utf8'));
  } catch (error) {
    throw new Error(
      `Missing or invalid authoritative ${kind} source at ${source}`,
      { cause: error },
    );
  }
  const output = await bytes(value, source);
  const file = `fixtures/golden/${kind}.json`;
  await emit(file, output);
  entries.push({ kind, file, digest: digest(output) });
}

const manifest = await bytes(
  {
    schemaVersion: 'org.openpacker.golden-manifest.v1',
    generator: 'scripts/generate-goldens.mjs',
    source: '.demo-output/golden-source',
    entries,
  },
  join(destinationDirectory, 'manifest.json'),
);
await emit('fixtures/golden/manifest.json', manifest);
console.log(
  `${check ? 'Checked' : 'Generated'} ${entries.length} digest-pinned protocol goldens`,
);

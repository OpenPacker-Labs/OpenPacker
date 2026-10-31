#!/usr/bin/env node
/**
 * The registry sample of ADR 0058 section 8: every archive in manifest.txt,
 * fetched from the registry into memory (nothing is written to disk), read by
 * one or more builds of the materializer in npm mode (the limits
 * `installArchiveLimits('npm')` sets) and under the general rule, and counted.
 *
 *   NODE_USE_ENV_PROXY=1 node run.mjs <name>=<opm module> [<name>=<opm module> ...] [--limit N] [--jobs N]
 *
 * An opm module is the materializer's built entry (dist/esm/index.js) or a
 * bundle of src/index.ts; the first is the build the others are compared with.
 * It prints, per build and mode, how many archives extract and the refusals by
 * code; every archive a build decides differently from the first; and every
 * archive the first refuses in npm mode with a TAR_AMBIGUOUS code. A version
 * the registry no longer serves (404, unpublished since the sample was drawn)
 * is counted as gone; any other fetch failure fails the run (exit 1).
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : Number(args[at + 1]);
};
const builds = [];
for (const arg of args.filter((value) => value.includes('='))) {
  const [name, path] = arg.split('=');
  builds.push([name, await import(pathToFileURL(resolve(path)).href)]);
}
if (builds.length === 0) {
  console.error(
    'usage: node run.mjs <name>=<opm module> [...] [--limit N] [--jobs N]',
  );
  process.exit(2);
}

const targets = readFileSync(join(here, 'manifest.txt'), 'utf8')
  .split('\n')
  .filter((line) => line !== '' && !line.startsWith('#'))
  .slice(0, option('--limit', Infinity));

/** `installArchiveLimits('npm')` (opm-project) and the general rule's defaults, from each build's own defaults. */
const modes = (defaults) => ({
  npm: {
    ...defaults,
    maximumFiles: 100_000,
    maximumPathBytes: 4096,
    maximumDepth: 128,
    maximumExpandedBytes: 1024 * 1024 * 1024,
    maximumCompressedBytes: 256 * 1024 * 1024,
    maximumCompressionRatio: 128,
    maximumMemoryBytes: 3 * 1024 * 1024 * 1024,
    acceptRedundantEntries: true,
    requireNpmReaderAgreement: true,
  },
  general: { ...defaults },
});

const tarball = (spec) => {
  const at = spec.lastIndexOf('@');
  const name = spec.slice(0, at);
  return `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${spec.slice(at + 1)}.tgz`;
};

async function decide(module, bytes, limits) {
  try {
    const entries = await module.inspectArchive(bytes, 'tar+gzip', limits);
    return `extracted ${entries.filter(({ type }) => type === 'file').length}`;
  } catch (error) {
    return `refused ${error.code ?? error.message}`;
  }
}

const counts = new Map();
const differences = [];
const gone = [];
const ambiguous = [];
let failures = 0;
let next = 0;
async function worker() {
  while (next < targets.length) {
    const spec = targets[next++];
    let bytes;
    try {
      const response = await fetch(tarball(spec));
      if (response.status === 404) {
        gone.push(spec);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      failures += 1;
      console.error(`${spec}: ${error.message}`);
      continue;
    }
    const decisions = {};
    for (const [build, module] of builds)
      for (const [mode, limits] of Object.entries(
        modes(module.DEFAULT_MATERIALIZATION_LIMITS),
      )) {
        const decision = await decide(module, bytes, limits);
        decisions[`${build} ${mode}`] = decision;
        const key = `${build} ${mode}: ${decision.startsWith('extracted') ? 'extracted' : decision}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    const [first] = builds[0];
    for (const [build] of builds.slice(1))
      for (const mode of ['npm', 'general'])
        if (decisions[`${build} ${mode}`] !== decisions[`${first} ${mode}`])
          differences.push(
            `${spec} ${mode}: ${first} ${decisions[`${first} ${mode}`]}, ${build} ${decisions[`${build} ${mode}`]}`,
          );
    if (decisions[`${first} npm`].startsWith('refused TAR_AMBIGUOUS'))
      ambiguous.push(`${spec}: ${decisions[`${first} npm`]}`);
  }
}
await Promise.all(Array.from({ length: option('--jobs', 8) }, worker));

console.log(
  `archives: ${targets.length}, read: ${targets.length - gone.length - failures}, gone from the registry: ${gone.length}, fetch failures: ${failures}`,
);
for (const spec of gone.sort()) console.log(`  gone: ${spec}`);
for (const [key, count] of [...counts].sort())
  console.log(String(count).padStart(6), key);
console.log(
  `\ndecided differently from ${builds[0][0]}: ${differences.length}`,
);
for (const line of differences.sort()) console.log(`  ${line}`);
console.log(
  `\nrefused by ${builds[0][0]} in npm mode, TAR_AMBIGUOUS_*: ${ambiguous.length}`,
);
for (const line of ambiguous.sort()) console.log(`  ${line}`);
process.exit(failures === 0 ? 0 : 1);

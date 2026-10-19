#!/usr/bin/env node
/**
 * A differential fuzz of `requireNpmReaderAgreement` (ADR 0057 section 8):
 * every archive of a family (families.mjs) is read by node-tar 6.2.1 (npm) as one
 * buffer and in pieces of 1, 1,460, 16,384 and 65,536 bytes, by pnpm 10.28.0's
 * `parseTarball`, and by opm in npm mode (the limits the npm adapter sets), and
 * sorted by what each did.
 *
 *   node run.mjs <opm module> <node-tar 6.2.1 dir> <pnpm 10.28.0 dir> <family> [--seed N] [--count N] [--pacote]
 *
 * <opm module> is the materializer's built entry, packages/materializer/dist/esm/index.js
 * (npm run build --workspace @openpacker/materializer), or a bundle of src/index.ts.
 * Seeded families take --seed (default 1) and --count (default 2000); the others
 * ignore both. --pacote also extracts with `tar.x` and pacote's filter and checks
 * the files opm returns against what it writes (class UNSAFE-PACOTE).
 *
 * The classes that fail the run (exit 1) are opm extracting what the readers read
 * differently (UNSAFE-ACCEPTED) and opm extracting a set the readers agree on
 * differently (UNSAFE-SET); both print up to five archives as base64. A refusal
 * where the readers agree is counted as an over-refusal by code, not a failure:
 * the families are not written to avoid them. A run finds what its families
 * reach, and says nothing about an archive none of them builds.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { FAMILIES } from './families.mjs';
import { pacoteInstalls } from '../tar-oracle/pacote.mjs';
import { FEEDS, loadNodeTar, nodeTar } from '../tar-oracle/readers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [opmArg, tarDirectory, pnpmDirectory, familyName, ...flags] =
  process.argv.slice(2);
const flag = (name, fallback) => {
  const at = flags.indexOf(name);
  return at === -1 ? fallback : Number(flags[at + 1]);
};
const family = FAMILIES[familyName];
if (!opmArg || !tarDirectory || !pnpmDirectory || family === undefined) {
  console.error(
    `usage: node run.mjs <opm module> <node-tar dir> <pnpm dir> <${Object.keys(FAMILIES).join('|')}> [--seed N] [--count N] [--pacote]`,
  );
  process.exit(2);
}
const withPacote = flags.includes('--pacote');
const { inspectArchive, DEFAULT_MATERIALIZATION_LIMITS } = await import(
  pathToFileURL(resolve(opmArg)).href
);
const NPM = {
  ...DEFAULT_MATERIALIZATION_LIMITS,
  acceptRedundantEntries: true,
  requireNpmReaderAgreement: true,
};
const tar = loadNodeTar(tarDirectory);

/** pnpm in a worker with a deadline; a worker that misses it is replaced. */
let worker;
let calls = 0;
const spawn = () => {
  worker = new Worker(join(here, 'pnpm-worker.mjs'), {
    workerData: { pnpmDirectory },
  });
};
spawn();
function pnpmRead(bytes) {
  calls += 1;
  const id = calls;
  return new Promise((resolveRead) => {
    const timer = setTimeout(() => {
      worker.terminate();
      spawn();
      resolveRead({ error: 'pnpm did not return' });
    }, 3000);
    const onMessage = (message) => {
      if (message.id !== id) return;
      clearTimeout(timer);
      worker.off('message', onMessage);
      resolveRead(message.result);
    };
    worker.on('message', onMessage);
    worker.postMessage({ id, bytes });
  });
}

const deadline = (promise, ms = 5000) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timed out')), ms).unref(),
    ),
  ]);
/** The files as a set, a later entry replacing an earlier one at its path. */
const asSet = (entries) =>
  JSON.stringify(
    [
      ...new Map(
        entries.map(([path, text]) => [path.replace(/\/$/u, ''), text]),
      ),
    ].sort(),
  );

async function opmRead(bytes) {
  try {
    const entries = await inspectArchive(new Uint8Array(bytes), 'tar', NPM);
    return {
      entries: entries
        .filter(({ type }) => type === 'file')
        .map(({ path, data }) => [
          path.split('/').slice(1).join('/'),
          Buffer.from(data).toString(),
        ]),
    };
  } catch (error) {
    return {
      code: error.code ?? `ERROR ${String(error.message).slice(0, 60)}`,
    };
  }
}

const histogram = new Map();
const samples = new Map();
const note = (cls, label, bytes, detail = '') => {
  histogram.set(cls, (histogram.get(cls) ?? 0) + 1);
  if (!cls.startsWith('UNSAFE')) return;
  const kept = samples.get(cls) ?? [];
  if (kept.length < 5)
    samples.set(cls, [
      ...kept,
      { label, detail, base64: bytes.toString('base64') },
    ]);
};

process.on('uncaughtException', () => undefined);

async function judge({ label, blocks }) {
  const bytes = Buffer.concat(blocks);
  let npm;
  try {
    const whole = asSet((await deadline(nodeTar(tar.Parse, bytes))).entries);
    const fed = [];
    for (const piece of FEEDS)
      fed.push(
        asSet((await deadline(nodeTar(tar.Parse, bytes, piece))).entries),
      );
    npm = fed.every((read) => read === whole) ? whole : `fed ${fed.join('|')}`;
  } catch (error) {
    npm = `node-tar ${error.message}`;
  }
  const pnpm = await pnpmRead(bytes);
  const opm = await opmRead(bytes);
  const agree = pnpm.entries !== undefined && npm === asSet(pnpm.entries);
  if (opm.entries === undefined) {
    note(`${agree ? 'over-refused' : 'refused'} ${opm.code}`, label, bytes);
    return;
  }
  const returned = asSet(opm.entries);
  if (!agree) {
    const kind =
      returned === npm
        ? 'npm'
        : pnpm.entries && returned === asSet(pnpm.entries)
          ? 'pnpm'
          : 'neither';
    note(
      'UNSAFE-ACCEPTED',
      label,
      bytes,
      `opm returns what ${kind} reads; npm ${npm.slice(0, 120)}; pnpm ${pnpm.entries ? asSet(pnpm.entries).slice(0, 120) : pnpm.error}; opm ${returned.slice(0, 120)}`,
    );
    return;
  }
  if (returned !== npm) {
    note(
      'UNSAFE-SET',
      label,
      bytes,
      `readers ${npm.slice(0, 120)}; opm ${returned.slice(0, 120)}`,
    );
    return;
  }
  if (withPacote) {
    const written = await deadline(pacoteInstalls(tar, bytes), 3000).catch(
      () => ({ error: 'timed out' }),
    );
    const names = (entries) =>
      asSet(
        entries.filter(([path]) => !/(^|\/)\.(git|npm)ignore$/u.test(path)),
      );
    if (written.entries && names(written.entries) !== names(opm.entries)) {
      note(
        'UNSAFE-PACOTE',
        label,
        bytes,
        `tar.x writes ${names(written.entries).slice(0, 120)}; opm ${names(opm.entries).slice(0, 120)}`,
      );
      return;
    }
  }
  note('agree, opm extracts the same', label, bytes);
}

const seed = flag('--seed', 1);
const count = flag('--count', 2000);
let total = 0;
for (const archive of family.archives(seed, count)) {
  total += 1;
  await judge(archive);
}
await worker.terminate();

console.log(
  `family=${familyName}${family.seeded ? ` seed=${seed}` : ''} archives=${total}${withPacote ? ' (+ tar.x with pacote filter)' : ''}`,
);
for (const [cls, n] of [...histogram].sort())
  console.log(String(n).padStart(8), cls);
for (const [cls, found] of samples) {
  console.log(`\n## ${cls}`);
  for (const { label, detail, base64 } of found)
    console.log(`   ${label}\n      ${detail}\n      base64 ${base64}`);
}
const unsafe = [...histogram]
  .filter(([cls]) => cls.startsWith('UNSAFE'))
  .reduce((sum, [, n]) => sum + n, 0);
console.log(`\nunsafe: ${unsafe}`);
process.exit(unsafe === 0 ? 0 : 1);

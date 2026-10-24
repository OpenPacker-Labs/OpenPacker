#!/usr/bin/env node
/**
 * The command line of the differential fuzz (fuzz.mjs says what is compared
 * and the classes; README.md where the readers come from).
 *
 *   node run.mjs <opm module> <node-tar 6.2.1 dir> <pnpm 10.28.0 dir> <family>
 *     [--node-tar-7 <node-tar 7.5.22 dir>] [--seed N] [--count N] [--pacote]
 *
 * <opm module> is the materializer's built entry,
 * packages/materializer/dist/esm/index.js, or a bundle of src/index.ts. Without
 * --seed, byte-sweep, pax-cut, meta-order and zero-blocks visit their fixed
 * lists and field-bytes and pax-records use seed 1; --count (default 2000) is
 * how many archives a seeded family draws. The run exits 1 on any archive in
 * an UNSAFE class, and prints up to five of each as base64.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FAMILIES } from './families.mjs';
import { openReaders, runFamily } from './fuzz.mjs';

const [opmArg, nodeTar6, pnpm, familyName, ...flags] = process.argv.slice(2);
const value = (name) => {
  const at = flags.indexOf(name);
  return at === -1 ? undefined : flags[at + 1];
};
const family = FAMILIES[familyName];
if (!opmArg || !nodeTar6 || !pnpm || family === undefined) {
  console.error(
    `usage: node run.mjs <opm module> <node-tar 6.2.1 dir> <pnpm 10.28.0 dir> <${Object.keys(FAMILIES).join('|')}> [--node-tar-7 <dir>] [--seed N] [--count N] [--pacote]`,
  );
  process.exit(2);
}
const seed =
  value('--seed') === undefined ? undefined : Number(value('--seed'));
const count = Number(value('--count') ?? 2000);
const pacote = flags.includes('--pacote');

const readers = openReaders({
  opm: await import(pathToFileURL(resolve(opmArg)).href),
  nodeTar6,
  nodeTar7: value('--node-tar-7'),
  pnpm,
  pacote,
});
const { total, histogram, samples, unsafe } = await runFamily(
  readers,
  family(seed, count),
);
await readers.close();

console.log(
  `family=${familyName} seed=${seed ?? 'none'} archives=${total} node-tar=${readers.versions.join(',')}${pacote ? ' (+ tar.x with pacote filter)' : ''}`,
);
for (const [verdict, n] of [...histogram].sort())
  console.log(String(n).padStart(8), verdict);
for (const [verdict, found] of samples) {
  console.log(`\n## ${verdict}`);
  for (const { label, detail, base64 } of found)
    console.log(`   ${label}\n      ${detail}\n      base64 ${base64}`);
}
console.log(`\nunsafe: ${unsafe}`);
process.exit(unsafe === 0 ? 0 : 1);

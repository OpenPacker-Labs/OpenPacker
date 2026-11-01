#!/usr/bin/env node
/**
 * Mutation runs for the npm reader agreement (ADR 0058 section 8): each
 * mutant in mutants.jsonl replaces one piece of source (`find`, which must
 * occur exactly once) by `replace`, runs a package's vitest suite (or the test
 * files it names), and puts the file back. A mutant is killed when the suite
 * fails. README.md has the results and, for each mutant that survives, why it
 * cannot change what opm decides.
 *
 *   node run.mjs all | <id,id,...> [--dry]
 *
 * It edits the checkout it is in and restores each file from what it read
 * (also when a run is interrupted by an exception); run it on a clean tree and
 * check `git status` afterwards. --dry only checks that every `find` occurs
 * once.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const mutants = readFileSync(join(here, 'mutants.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));

const [which = 'all', ...flags] = process.argv.slice(2);
const wanted =
  which === 'all'
    ? mutants
    : mutants.filter(({ id }) => which.split(',').includes(id));
const dry = flags.includes('--dry');

let survivors = 0;
for (const mutant of wanted) {
  const path = join(root, mutant.file);
  const original = readFileSync(path, 'utf8');
  const hits = original.split(mutant.find).length - 1;
  if (hits !== 1) {
    survivors += 1;
    console.log(`${mutant.id}\tfind matches ${hits} times\t${mutant.note}`);
    continue;
  }
  if (dry) continue;
  try {
    writeFileSync(
      path,
      original.replace(mutant.find, () => mutant.replace),
    );
    const run = spawnSync(
      join(root, 'node_modules/.bin/vitest'),
      ['run', '--testTimeout=60000', ...(mutant.tests ?? [])],
      {
        cwd: join(root, mutant.dir),
        encoding: 'utf8',
        env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      },
    );
    const tests = /Tests\s+(.*)/u.exec(`${run.stdout}\n${run.stderr}`)?.[1];
    const killed = run.status !== 0;
    if (!killed) survivors += 1;
    console.log(
      `${mutant.id}\t${killed ? 'killed' : 'SURVIVED'}\t${tests ?? '?'}\t${mutant.note}`,
    );
  } finally {
    writeFileSync(path, original);
  }
}
console.log(
  `${wanted.length} mutants, ${survivors} not killed${dry ? ' (dry: find checks only)' : ''}`,
);

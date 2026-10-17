#!/usr/bin/env node
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { PINNED } from './tools.mjs';

/**
 * A differential of the npm range reader and the archive version check against
 * node-semver itself, over generated input: what the golden file of
 * `oracle-npm-ranges.mjs` asks about a fixed battery, this asks about tens of
 * thousands of ranges and version pairs a seeded generator writes. It reads
 * the built packages (`npm run build -w packages/adapter-core -w
 * packages/adapter-npm` first) and the semver of npm 10.9.4, which is the
 * version pnpm 10.28's own code embeds (`tools.mjs` checks the two are one).
 *
 * For each range: the comparator sets and whether node-semver refuses it
 * (`npmComparatorSets` against `new Range(range).set`), `satisfies` of 30
 * versions through `parseSemverRange` and `evaluateSemverRange`, and through
 * `pnpm-install/ranges.ts`'s `versionSatisfies`; then `rangesIntersect` against
 * `semver.intersects` over pairs of valid ranges; then `npmVersionsEqual`
 * against pnpm's `equalOrSemverEqual` (`eq(a, b, { loose: true })`) over pairs
 * of version spellings. Exits 1 on any difference and prints the first few.
 * Not part of a test run: it is run by hand, as the oracles are (README.md).
 */

const USAGE = `Usage: node differential.mjs --npm <dir> [--seed <n>] [--draws <n>]
  --npm <dir>    the unpacked npm ${PINNED.npm} package (its semver is ${PINNED.semver})
  --seed <n>     the generator's seed (default 7)
  --draws <n>    ranges drawn, and twice as many version pairs (default 20000)`;

const option = (args, name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const args = process.argv.slice(2);
const npm = option(args, '--npm');
if (npm === undefined) {
  console.error(USAGE);
  process.exit(2);
}
const semverDir = join(resolve(npm), 'node_modules', 'semver');
const semver = createRequire(join(semverDir, 'package.json'))('./index.js');
const found = createRequire(join(semverDir, 'package.json'))(
  './package.json',
).version;
if (found !== PINNED.semver) {
  console.error(`semver at ${semverDir} is ${found}, not ${PINNED.semver}`);
  process.exit(2);
}

const built = (path) => import(new URL(path, import.meta.url).href);
const core = await built('../../../dist/esm/index.js');
const reader = await built('../../../dist/esm/npm-semver-range.js');
const ranges = await built(
  '../../../../adapter-npm/dist/esm/pnpm-install/ranges.js',
);

let seed = Number(option(args, '--seed') ?? 7);
const draws = Number(option(args, '--draws') ?? 20000);
/** mulberry32: the same input for the same seed on any machine. */
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (list) => list[Math.floor(random() * list.length)];

const OPERATORS = ['', '=', '==', '<', '<=', '>', '>=', '=>', '=<', '^', '~'];
OPERATORS.push('~>', '>~', 'v', 'V', '=v', '>=v', '^v', '~v', '> =', '>= ');
OPERATORS.push('^ ', '~ ', '~> ', '>= v', '!=', '<>', '<  ', '\t>', ' ~ ');
const OPERANDS = ['0', '0.0', '0.0.0', '1', '1.2', '1.2.3', '01', '1.02.3'];
OPERANDS.push('1.2.03', '1.2.3-0', '1.2.3-alpha', '1.2.3-alpha.1', '1.2.3-01');
OPERANDS.push('1.2.3-alpha.01', '1.2.3+b', '1.2.3-beta+b.1', '1.2+b', '1.x+b');
OPERANDS.push('1+b', '0.0.0+build', '1.2.x+b', 'x', 'X', '*', '1.x', '1.X');
OPERANDS.push('1.*', '1.2.x', '1.x.3', 'x.1', '*.*', 'x.x.x', '1.2.3.4');
OPERANDS.push('1.2.3-', '1.2.3-x.y-z', '0.0.1', '0.1.x', '0.0.x', '2.0.0-0');
OPERANDS.push('99999999999999999999.0.0', '9007199254740992.0.0', 'v1.2.3');
OPERANDS.push('1.2.3beta', '1.2.3-beta.2', '0.0.0-0', '1.2.3--', '1.x.x');
const AND = [' ', '  ', '\t', '\n', '\u3000', ','];
const OR = ['||', ' || ', '|| ', ' ||', '|||', '| |', ' ||  ||'];
const HYPHEN = [' - ', ' -  ', '  - ', ' -', '- ', '\t-\t'];
const SPECIAL = ['', ' ', '||', '1 ||', '|| 1', 'latest', '*', '>=0.0.0'];
SPECIAL.push('<0.0.0', '<0.0.0-0', '>=0.0.0-0', '>=0.0.0 <0.0.0');

function alternative() {
  if (random() < 0.15) return pick(OPERANDS) + pick(HYPHEN) + pick(OPERANDS);
  const count = 1 + Math.floor(random() * 3);
  return Array.from(
    { length: count },
    () => pick(OPERATORS) + pick(OPERANDS),
  ).join(pick(AND));
}
function range() {
  const roll = random();
  if (roll < 0.05) return pick(SPECIAL);
  const count = 1 + Math.floor(random() * (roll < 0.6 ? 1 : 3));
  return Array.from({ length: count }, alternative).join(pick(OR));
}

const VERSIONS = ['0.0.0', '0.0.0-0', '0.0.1', '0.1.0', '0.1.1', '1.0.0'];
VERSIONS.push('1.0.0-0', '1.2.0', '1.2.2', '1.2.3', '1.2.3-0', '1.2.3-alpha');
VERSIONS.push('1.2.3-alpha.1', '1.2.3-beta', '1.2.3-beta.2', '1.2.4', '1.3.0');
VERSIONS.push('1.2.4-0', '1.3.0-0', '2.0.0', '2.0.0-0', '2.0.0-rc.1', '3.0.0');
VERSIONS.push('1.2.3+b', 'v1.2.3', ' 1.2.3 ', '1.2.3-01', '01.2.3', '1.2');
VERSIONS.push('=1.2.3');

const asText = (sets) =>
  sets === undefined
    ? null
    : sets
        .map((set) =>
          set
            .map((one) =>
              one.version === undefined ? '' : `${one.operator}${one.version}`,
            )
            .join(' '),
        )
        .join('||');
function oracleSets(text) {
  try {
    return new semver.Range(text).set
      .map((set) => set.map((one) => one.value).join(' '))
      .join('||');
  } catch {
    return null;
  }
}
const compare = (left, right) =>
  core.compareParsedVersions(core.parseSemver(left), core.parseSemver(right));
function viaParser(version, text) {
  if (semver.valid(version) === null) return false;
  const ast = core.parseSemverRange(text, {
    scheme: 'npm',
    bare: 'exact',
    hyphenRanges: true,
  }).ast;
  return core.evaluateSemverRange(
    version.trim().replace(/^[=v]+/u, ''),
    ast,
    compare,
  );
}

const stats = { ranges: 0, valid: 0, sets: 0, satisfies: 0, intersects: 0 };
const differences = { sets: 0, satisfies: 0, intersects: 0, versions: 0 };
const examples = [];
const note = (kind, detail) => {
  differences[kind] += 1;
  if (examples.length < 10) examples.push([kind, ...detail]);
};

const seen = new Set();
const valid = [];
for (let draw = 0; draw < draws; draw += 1) {
  const text = range();
  if (seen.has(text)) continue;
  seen.add(text);
  stats.ranges += 1;
  const mine = asText(reader.npmComparatorSets(text));
  const theirs = oracleSets(text);
  stats.sets += 1;
  if (mine !== theirs) note('sets', [text, mine, theirs]);
  if (theirs === null) continue;
  stats.valid += 1;
  if (mine !== null) valid.push(text);
  for (const version of VERSIONS) {
    const want = semver.satisfies(version, text);
    stats.satisfies += 2;
    if (viaParser(version, text) !== want)
      note('satisfies', ['parseSemverRange', version, text, want]);
    if (ranges.versionSatisfies(version, text) !== want)
      note('satisfies', ['versionSatisfies', version, text, want]);
  }
}
for (let pair = 0; pair < Math.min(valid.length * 4, 60000); pair += 1) {
  const left = pick(valid);
  const right = pick(valid);
  stats.intersects += 1;
  const want = semver.intersects(left, right);
  if (ranges.rangesIntersect(left, right) !== want)
    note('intersects', [left, right, want]);
}

const PREFIX = ['', '', '', '=', 'v', 'vv', '=v', 'v=', ' ', '\t', '==', 'V'];
const NUMBER = ['0', '1', '01', '00', '2', '10', '010', '9007199254740991'];
NUMBER.push('9007199254740992', '99999999999999999999');
const PRE = ['', '', '-1', '-01', '-0', '-alpha', '-alpha.1', '-alpha.01'];
PRE.push('alpha', '-1.2', '-x-y', '-99999999999999999999', '-', '.1');
const BUILD = ['', '', '+b', '+build.5', '+01', '+'];
const spelling = () =>
  pick(PREFIX) +
  [pick(NUMBER), pick(NUMBER), pick(NUMBER)]
    .slice(0, random() < 0.1 ? 2 : 3)
    .join('.') +
  pick(PRE) +
  pick(BUILD);
function pnpmEqual(left, right) {
  if (left === right) return true;
  try {
    return semver.eq(left, right, { loose: true });
  } catch {
    return false;
  }
}
const spellings = Array.from({ length: 4000 }, spelling);
let equal = 0;
for (let pair = 0; pair < draws * 2; pair += 1) {
  const left = pick(spellings);
  const right =
    random() < 0.5 ? pick(spellings) : left.replace(/^[=v\s]*/u, pick(PREFIX));
  const want = pnpmEqual(left, right);
  if (want) equal += 1;
  if (core.npmVersionsEqual(left, right) !== want)
    note('versions', [left, right, want]);
}

console.log(
  JSON.stringify({
    semver: found,
    seed: option(args, '--seed') ?? '7',
    ...stats,
    versionPairs: draws * 2,
    equalPairs: equal,
    differences,
  }),
);
for (const example of examples) console.log(JSON.stringify(example));
process.exitCode = Object.values(differences).some((count) => count > 0)
  ? 1
  : 0;

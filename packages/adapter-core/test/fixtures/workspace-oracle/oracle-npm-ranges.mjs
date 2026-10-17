import { PINNED } from './tools.mjs';
import { rangeList } from './oracle-ranges.mjs';

/**
 * The npm range grammar as pnpm reads it: node-semver 7.7.3, the copy pnpm
 * 10.28.0 bundles, strict (`new Range(range)`, `satisfies(version, range)`).
 * The battery is every operator spelling against every operand below, the
 * ranges after them, and the workspace range battery; the versions sit on the
 * edges a range is read at (zeros, a `-0` bound, prereleases on a bound).
 */
export const VERSIONS = [
  '0.0.0',
  '0.0.1',
  '0.0.2',
  '0.1.0',
  '0.1.2',
  '0.2.0',
  '1.0.0',
  '1.0.1',
  '1.2.0',
  '1.2.2',
  '1.2.3',
  '1.2.4',
  '1.3.0',
  '1.9.9',
  '2.0.0',
  '2.0.1',
  '3.0.0',
  '10.0.0',
  '0.0.0-0',
  '0.0.1-rc.1',
  '1.0.0-rc.1',
  '1.2.3-0',
  '1.2.3-beta',
  '1.2.3-beta.2',
  '1.2.4-0',
  '1.3.0-0',
  '1.3.0-beta',
  '2.0.0-0',
  '2.0.0-rc.1',
  '3.0.0-0',
];

/** How an operator may be written, node-semver's spellings and ones it refuses. */
const OPERATORS = [
  '',
  '=',
  '<',
  '<=',
  '>',
  '>=',
  '^',
  '~',
  'v',
  '~>',
  '>= ',
  '< ',
  '^ ',
  '=v',
  '>=v',
  '^=',
  '~ ',
  '> =',
  '==',
  'V',
  '~>=',
  '<=v',
];

/** Whole, partial and wildcard versions, and text that only looks like one. */
const OPERANDS = [
  '0.0.0',
  '0.0.1',
  '0.1.0',
  '0.1.2',
  '1.0.0',
  '1.2.3',
  '1.2.4',
  '2.0.0',
  '1.2.3-beta',
  '1.2.3-0',
  '1.2.3+b',
  '1',
  '1.2',
  '0',
  '0.0',
  '0.1',
  '1.x',
  '1.2.x',
  'x',
  '*',
  '0.x',
  '1.*',
  '2',
  '1.X',
  '0.0.x',
  'x.y',
  '1.2.3.4',
  '01.2.3',
  '1.2.3-01',
  '1.2.3beta',
  '1.2-beta',
  '1.x.3',
  '1.2.3-rc.1+b.2',
  '',
  ' ',
  'X.x',
  '*.*',
  '1.2.3-',
  '1..2',
  '99999999999999999.0.0',
  'v',
  'latest',
  '1.2.3+',
  '0.0.0-0',
  '1.x-beta',
];

const OTHERS = [
  '1 -2',
  '1 - ',
  '- 2',
  '1 - 2 - 3',
  '|| 1',
  '1 || || 2',
  '>=  1.2.3',
  '>=\t1',
  '~ > 1',
  '~>  1',
  '1\u00a02',
  '>=1\u00a0<2',
  '1.2.3\n',
  '\t^1',
  '>=1.2.3 <2 >=1.5',
  '* || 1',
  '1 || *',
  '<0.0.0',
  '<0.0.0-0',
  '<0.0.0 || 1',
  '<0.0.0-0 || <0.0.0-0',
  '>=0.0.0',
  '>=0.0.0 <1',
  '>=0 || <0.0.0',
  '>=0.0.0+build',
  '~1.2.3-beta',
  '^0.0.0',
  '^0.0',
  '^0.0.0-beta',
  '~0',
  '<=0.x',
  '>0.x',
  '>=*',
  '<*',
  '>*',
  '<=*',
  '=*',
  '!=1',
  '1 2',
  'a',
  '1.2.3 a',
  '>=1.2.3+build <2',
  '1.2.3+b.c - 2.0.0+d',
  '^1.2.3+build',
  '~>1.2.3-beta+x',
  '> 1',
  '< = 1',
  '>==1.2.3',
  '>==1',
  'vv1.2.3',
  '>=vv1',
  '1.2.3-x.y.z',
  '1.2.3-x.1.02',
  'v1 - v2',
  '=1.2.3 - 2',
  'v1 || v2.x',
  '>=1.3.0-beta <1.3',
  '>=1.2.3-beta <=1.2',
];

/** Every range asked about, in a fixed order, each once. */
export function npmRangeList() {
  const ranges = [];
  for (const operator of OPERATORS)
    for (const operand of OPERANDS) ranges.push(`${operator}${operand}`);
  ranges.push(...OTHERS, ...rangeList());
  return [...new Set(ranges)];
}

/**
 * For each range, what node-semver reads it as (`new Range(range).range`, the
 * comparators it keeps) and which of VERSIONS satisfy it (`1` or `0` each), or
 * `null` where it refuses the range.
 */
export function npmRangeOracle(tools) {
  const { pnpmSemver: semver } = tools;
  const answers = {};
  for (const range of npmRangeList()) {
    let read = null;
    try {
      read = new semver.Range(range).range;
    } catch {
      read = null;
    }
    answers[range] =
      read === null
        ? null
        : {
            range: read,
            satisfies: VERSIONS.map((version) =>
              semver.satisfies(version, range) ? '1' : '0',
            ).join(''),
          };
  }
  return {
    generatedWith: {
      semver: `semver ${PINNED.pnpmSemver}, the copy inside pnpm ${PINNED.pnpm}: new Range(range).range and satisfies(version, range); null where new Range(range) throws`,
    },
    versions: VERSIONS,
    answers,
  };
}

export const oracle = {
  name: 'npm-ranges',
  file: new URL('../npm-range-oracle.json', import.meta.url),
  generate: (tools) => npmRangeOracle(tools),
};

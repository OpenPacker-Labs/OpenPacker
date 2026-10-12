import { PINNED } from './tools.mjs';

/** Versions that tell the range grammars apart: zeros, minors, majors, prereleases. */
export const VERSIONS = [
  '0.0.0',
  '0.0.1',
  '0.0.3',
  '0.1.0',
  '0.1.2',
  '0.2.0',
  '0.9.9',
  '1.0.0',
  '1.0.1',
  '1.2.0',
  '1.2.3',
  '1.2.4',
  '1.3.0',
  '1.9.9',
  '2.0.0',
  '2.1.0',
  '3.0.0',
  '10.0.0',
  '0.0.1-rc.1',
  '1.0.0-rc.1',
  '1.2.3-rc.1',
  '1.2.3-rc.2',
  '2.0.0-rc.1',
];

const OPERATORS = ['', '=', '^', '~', '>', '>=', '<', '<='];

/** Full and partial versions, with and without wildcards, a leading v, and a prerelease. */
const OPERANDS = [
  '*',
  'x',
  'X',
  '0',
  '1',
  '2',
  '0.0',
  '0.1',
  '1.0',
  '1.2',
  '0.x',
  '1.x',
  '1.X',
  '1.*',
  '0.0.x',
  '0.1.x',
  '1.2.x',
  '1.x.x',
  '0.x.x',
  '0.0.0',
  '0.0.1',
  '0.0.3',
  '0.1.2',
  '1.2.3',
  '1.0.0',
  'v1',
  'v1.2',
  'v1.2.3',
  '1.2.3-rc.1',
  '1.0.0-rc.1',
  '0.0.1-rc.1',
];

const OTHERS = [
  '',
  '  ',
  '*',
  '>=1.0.0 <2.0.0',
  '>=1 <2',
  '>1 <=2',
  '>=0.0.1 <0.1',
  '^1.2.3 ^1.2.0',
  '1.0.0 - 2.0.0',
  '1 - 2',
  '1.2 - 1.4',
  '1.2.3 - 2',
  '1.x - 2.x',
  '1.0.0 - 1.2',
  '0 - 1',
  '1.2.3 - 1.2.5',
  '1.x || 2.x',
  '^1.0.0 || ^2.0.0',
  '>=1 <=2 || 0.x',
  '<1.0.0 || >=2.0.0',
  '~1.2.3 || ^0.1',
  '>= 1.2.3',
  '^ 1.2.3',
  '~ 1.2',
  '>=1.2.3 <1.3.0',
  '>=1.2.3-rc.1 <1.2.4',
  '<1.0.0-rc.2',
  '>=1.0.0-rc.1',
  '^1.2.3-rc.1',
  '~1.2.3-rc.1',
  '^0.0.3-rc.1',
  'latest',
  'next',
  'file:../x',
  'git+https://example.test/x.git',
  'npm:foo@1',
  'link:../x',
  'workspace:*',
  'http://example.test/x.tgz',
  '1.2.3.4',
  '1..2',
  '^',
  '>=',
  '||',
  '1 ||',
];

/** Every range asked about, in a fixed order, each once. */
export function rangeList() {
  const ranges = [];
  for (const operator of OPERATORS)
    for (const operand of OPERANDS) ranges.push(`${operator}${operand}`);
  ranges.push(...OTHERS);
  return [...new Set(ranges)];
}

/**
 * npm's own answer for a range and a version: `semver.satisfies(version, range, true)`
 * (loose, as the dependency check calls it), or `null` where the range is not
 * a semantic version range at all.
 */
export function rangeOracle(tools) {
  const { semver } = tools;
  const ranges = rangeList();
  const answers = {};
  for (const range of ranges)
    answers[range] =
      semver.validRange(range, true) === null
        ? null
        : VERSIONS.map((version) => semver.satisfies(version, range, true));
  return {
    generatedWith: {
      semver: `semver ${PINNED.semver}, the copy inside npm ${PINNED.npm}: satisfies(version, range, true); null where validRange(range, true) is null`,
    },
    versions: VERSIONS,
    answers,
  };
}

export const oracle = {
  name: 'ranges',
  file: new URL('../workspace-range-oracle.json', import.meta.url),
  generate: (tools) => rangeOracle(tools),
};

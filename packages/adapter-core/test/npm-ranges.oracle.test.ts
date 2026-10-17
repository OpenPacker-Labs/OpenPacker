import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compareParsedVersions,
  evaluateSemverRange,
  parseSemver,
  parseSemverRange,
  type RangeAst,
} from '../src/index.js';

/**
 * npm-range-oracle.json holds what node-semver 7.7.3, the copy pnpm 10.28.0
 * bundles, read each range in test/fixtures/workspace-oracle/oracle-npm-ranges.mjs
 * as (`new Range(range).range`) and which versions satisfy it, or null where
 * it refuses the range. The npm scheme of the range parser must read every one
 * the same: refuse what it refuses, keep the comparators it keeps, and answer
 * every version as it does. On the reader before this one, 404 of them differed.
 */
const oracle: {
  versions: string[];
  answers: Record<string, { range: string; satisfies: string } | null>;
} = JSON.parse(
  readFileSync(
    new URL('./fixtures/npm-range-oracle.json', import.meta.url),
    'utf8',
  ),
);

/** A range as node-semver writes one back: an exact comparator has no `=`, `*` is empty. */
function asSemver(ast: RangeAst): string {
  if (ast.type === 'any') return '';
  if (ast.type === 'comparison')
    return `${ast.operator === '=' ? '' : ast.operator}${ast.version}`;
  return ast.items.map(asSemver).join(ast.type === 'and' ? ' ' : '||');
}

function read(range: string): RangeAst | null {
  try {
    return parseSemverRange(range, {
      scheme: 'npm',
      bare: 'exact',
      hyphenRanges: true,
    }).ast;
  } catch {
    return null;
  }
}

const compare = (left: string, right: string) =>
  compareParsedVersions(parseSemver(left), parseSemver(right));

describe('npm ranges, against node-semver as pnpm reads them', () => {
  it('asks about enough ranges and versions to mean something', () => {
    const answers = Object.values(oracle.answers);
    expect(answers.length).toBeGreaterThanOrEqual(1142);
    expect(answers.filter((answer) => answer === null).length).toBe(382);
    expect(oracle.versions).toHaveLength(30);
  });

  it.each(Object.entries(oracle.answers))(
    'reads %j as node-semver does',
    (range, answer) => {
      const ast = read(range);
      if (answer === null) {
        expect(ast).toBeNull();
        return;
      }
      expect(ast).not.toBeNull();
      expect(asSemver(ast!)).toBe(answer.range);
      expect(
        oracle.versions
          .map((version) =>
            evaluateSemverRange(version, ast!, compare) ? '1' : '0',
          )
          .join(''),
      ).toBe(answer.satisfies);
    },
  );
});

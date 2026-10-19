/**
 * Two npm ranges that have a version in common, as pnpm asks it of an override
 * (ADR 0055 §18.4).
 *
 * pnpm applies `name@range` to a dependency when the two ranges intersect
 * (`isIntersectingRange` in `@pnpm/hooks.read-package-hook`), which is
 * node-semver's `intersects`: some alternative of each is satisfiable and every
 * comparator of the one intersects every comparator of the other, pairwise,
 * with node-semver's rules for an exact comparator and for prereleases. This is
 * that rule over the comparators `@openpacker/adapter-core` reads an npm range
 * to, which are node-semver's own (`1.2` is `>=1.2.0 <1.3.0-0`, `>=0.0.0` is
 * `*`); a range it refuses is not a range, as node-semver refuses it.
 */

import {
  compareParsedVersions,
  evaluateSemverRange,
  npmVersion,
  parseSemver,
  parseSemverRange,
  type RangeAst,
} from '@openpacker/adapter-core';

/**
 * `''` is node-semver's exact comparator (`1.2.3`), written `=` by the parser;
 * with no version it is node-semver's `*`, which a range is only when it is
 * nothing else.
 */
interface Comparator {
  readonly operator: '' | '<' | '<=' | '>' | '>=';
  readonly version: string;
}

const ANY: Comparator = { operator: '', version: '' };

const compare = (left: string, right: string): number =>
  compareParsedVersions(parseSemver(left), parseSemver(right));

/** The range as alternatives of comparators, or undefined when it is not one. */
function comparatorSets(range: string): Comparator[][] | undefined {
  let ast: RangeAst;
  try {
    ast = parseSemverRange(range, {
      scheme: 'npm',
      bare: 'exact',
      hyphenRanges: true,
    }).ast;
  } catch {
    return undefined;
  }
  const sets: Comparator[][] = [];
  for (const alternative of ast.type === 'or' ? ast.items : [ast]) {
    const set: Comparator[] = [];
    for (const item of alternative.type === 'and'
      ? alternative.items
      : [alternative]) {
      if (item.type === 'any') {
        set.push(ANY);
        continue;
      }
      if (item.type !== 'comparison' || item.operator === '!=')
        return undefined;
      set.push({
        operator: item.operator === '=' ? '' : item.operator,
        version: item.version,
      });
    }
    sets.push(set);
  }
  return sets;
}

/** `semver.validRange(text) !== null`. */
export function isRange(text: string): boolean {
  return comparatorSets(text) !== undefined;
}

/** `new Range(comparator).test(version)`: the comparator, and the prerelease rule. */
function satisfies(version: string, comparator: Comparator): boolean {
  // `*` takes every version but a prerelease.
  if (comparator === ANY) return parseSemver(version).prerelease.length === 0;
  return evaluateSemverRange(
    version,
    {
      type: 'comparison',
      operator: comparator.operator === '' ? '=' : comparator.operator,
      version: comparator.version,
    },
    compare,
  );
}

/** node-semver's `Comparator.prototype.intersects`, without `includePrerelease`. */
function comparatorsIntersect(a: Comparator, b: Comparator): boolean {
  if (a === ANY) return true;
  if (a.operator === '') return satisfies(a.version, b);
  if (b === ANY) return true;
  if (b.operator === '') return satisfies(b.version, a);
  const belowZero = (c: Comparator) =>
    c.operator === '<' && c.version.startsWith('0.0.0');
  if (belowZero(a) || belowZero(b)) return false;
  const [up, down] = [a.operator[0], b.operator[0]];
  if (up === down) return true;
  const order = compare(a.version, b.version);
  if (order === 0 && a.operator.includes('=') && b.operator.includes('='))
    return true;
  return (order < 0 && up === '>') || (order > 0 && up === '<');
}

/** node-semver's `isSatisfiable`: every two comparators of the set intersect. */
function satisfiable(set: readonly Comparator[]): boolean {
  return set.every((a, index) =>
    set.slice(index + 1).every((b) => comparatorsIntersect(a, b)),
  );
}

/** `semver.intersects(left, right)`; false when either is not a range. */
export function rangesIntersect(left: string, right: string): boolean {
  const lefts = comparatorSets(left);
  const rights = comparatorSets(right);
  if (lefts === undefined || rights === undefined) return false;
  return lefts.some(
    (l) =>
      satisfiable(l) &&
      rights.some(
        (r) =>
          satisfiable(r) &&
          l.every((a) => r.every((b) => comparatorsIntersect(a, b))),
      ),
  );
}

/**
 * `semver.satisfies(version, range)`; false when either does not parse. The
 * version is read by node-semver's strict grammar (`npmVersion`), which refuses
 * `1.2.3-01` and `01.2.3` as `new SemVer` does.
 */
export function versionSatisfies(version: string, range: string): boolean {
  const written = npmVersion(version);
  if (written === undefined) return false;
  try {
    return evaluateSemverRange(
      written,
      parseSemverRange(range, {
        scheme: 'npm',
        bare: 'exact',
        hyphenRanges: true,
      }).ast,
      compare,
    );
  } catch {
    return false;
  }
}

/**
 * pnpm's `isIntersectingRange(selectorRange, specifier)`: no range in the
 * selector, the same text, or two ranges that intersect.
 */
export function overrideRangeApplies(
  selectorRange: string | undefined,
  specifier: string,
): boolean {
  return (
    selectorRange === undefined ||
    selectorRange === '' ||
    specifier === selectorRange ||
    rangesIntersect(specifier, selectorRange)
  );
}

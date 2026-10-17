/**
 * Two npm ranges that have a version in common, as pnpm asks it of an override
 * (ADR 0055 §18.4).
 *
 * pnpm applies `name@range` to a dependency when the two ranges intersect
 * (`isIntersectingRange` in `@pnpm/hooks.read-package-hook`), which is
 * node-semver's `intersects`: some alternative of each is satisfiable and every
 * comparator of the one intersects every comparator of the other, pairwise,
 * with node-semver's rules for an exact comparator and for prereleases. This is
 * that rule over the range grammar `@openpacker/adapter-core` already reads; a
 * range it cannot read is not a range, as one node-semver cannot read is not.
 */

import {
  compareParsedVersions,
  evaluateSemverRange,
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

/** `semver.validRange(text) !== null`, as far as the forms opm reads go. */
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

/** A whole version as node-semver reads one: three numbers, no fewer. */
const FULL_VERSION =
  /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/** `semver.satisfies(version, range)`; false when either does not parse. */
export function versionSatisfies(version: string, range: string): boolean {
  if (!FULL_VERSION.test(version.trim())) return false;
  try {
    return evaluateSemverRange(
      version,
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

const NUMBER = String.raw`(?:0|[1-9]\d*)`;
const WILD = '[xX*]';
/** A whole version with no prerelease, where node-semver's `-0` bounds would differ. */
const FULL = String.raw`${NUMBER}\.${NUMBER}\.${NUMBER}(?:\+[0-9A-Za-z.-]+)?`;
const PARTIAL = String.raw`${NUMBER}(?:\.(?:${NUMBER}|${WILD})){0,2}`;
/**
 * node-semver reads `<=1.2` as `<1.3.0-0`, `>1` as `>=2.0.0`, `^0.x` as
 * `<1.0.0-0`, `~1.x` as `<2.0.0-0` and `<0.x` as nothing, the range reader
 * otherwise, so a partial version takes only these.
 */
const COMPARATOR = String.raw`(?:(?:[~^]|[<>]=?|=)?${FULL}|(?:>=)?${PARTIAL}|<[1-9]\d*(?:\.(?:${NUMBER}|${WILD})){0,2}|\^[1-9]\d*(?:\.(?:${NUMBER}|${WILD})){0,2}|~${NUMBER}(?:\.${NUMBER}(?:\.${WILD})?)?)`;
/** One alternative in the forms both readings agree on, or a hyphen range. */
const PLAIN_ALTERNATIVE = new RegExp(
  `^(?:${WILD}|${FULL} - (?:${FULL}|${PARTIAL})|${COMPARATOR}(?: +${COMPARATOR})*)$`,
  'u',
);

/**
 * Whether opm reads `text` as pnpm (node-semver) does: a range of whole
 * versions without a prerelease written with `^`, `~`, comparators, x-ranges,
 * hyphen ranges and `||`; a `name:` or `path/` specifier or a dist-tag, which
 * neither reads as a range. Not `~>1`, `v1.x`, `<*`, `<=1.2` or a prerelease
 * bound, which the two read differently.
 */
export function readsAsPnpm(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '' || /[:/]/u.test(trimmed)) return true;
  if (/^[A-Za-z][\w.-]*$/u.test(trimmed) && !/^[vV=]?[\dxX*]/u.test(trimmed))
    return true;
  return trimmed
    .replace(/([<>]=?|=|~|\^)\s+/gu, '$1')
    .split('||')
    .every((alternative) => PLAIN_ALTERNATIVE.test(alternative.trim()));
}

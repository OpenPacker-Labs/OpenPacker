/**
 * npm's range grammar, read as node-semver 7.7.2 reads it: `new Range(text)`,
 * strict, without `includePrerelease`. 7.7.2 is what pnpm 10.28's own code
 * embeds and what npm 10.9 uses; the 7.7.3 pnpm ships beside its bundle is
 * node-gyp's. The one difference: 7.7.3 strips build metadata from a
 * comparator first, and 7.7.2 does not, so it refuses `+build` after a partial
 * version or an x-range (`=1+b`, `<=1.2+b`, `1.x+b`), and `>=0.0.0+build` is
 * `>=0.0.0` and not `*`.
 *
 * The range reader the other schemes share took forms node-semver refuses (a
 * lone `>=`, `~`, `^` or `=`, `x.y`, `> = 1`) as `*`, which fails open, and
 * read a partial version its own way (`<=1.2` as `<=1.2.0`, where node-semver
 * reads `<1.3.0-0`). So an npm range is read here by node-semver's own steps,
 * in its order and with its regular expressions (bounded as its `safeRe` bounds
 * them): hyphen ranges, trimming, carets, tildes, x-ranges, stars and
 * `>=0.0.0`, then each comparator against its strict grammar, then the sets.
 * What node-semver refuses is refused; what it reads is read to the same
 * comparators, `1.2` to `>=1.2.0 <1.3.0-0`. This is a port of node-semver's
 * `classes/range.js`, `classes/comparator.js` and `internal/re.js`, and its
 * licence and notice, below, are node-semver's.
 */

/*
 * The ISC License
 *
 * Copyright (c) Isaac Z. Schlueter and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
 * IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

import type { RangeAst } from './index.js';
import { ProviderError } from './provider-error.js';
import { quote } from './terminal-text.js';

/** One comparator: node-semver's operator (`''` is exact) and version; `undefined` version is `*`. */
export interface NpmComparator {
  readonly operator: '' | '<' | '<=' | '>' | '>=';
  readonly version?: string;
}

const MAX_LENGTH = 256;
const MAX_SAFE_BUILD_LENGTH = MAX_LENGTH - 6;
const LETTERDASHNUMBER = '[a-zA-Z0-9-]';

/** node-semver's `makeSafeRegex`: every unbounded repetition of these, bounded. */
function safe(source: string): string {
  let bounded = source;
  for (const [token, max] of [
    [String.raw`\s`, 1],
    [String.raw`\d`, MAX_LENGTH],
    [LETTERDASHNUMBER, MAX_SAFE_BUILD_LENGTH],
  ] as const)
    bounded = bounded
      .split(`${token}*`)
      .join(`${token}{0,${max}}`)
      .split(`${token}+`)
      .join(`${token}{1,${max}}`);
  return bounded;
}

const NUMERIC = String.raw`0|[1-9]\d*`;
const NUMERIC_LOOSE = String.raw`\d+`;
const NON_NUMERIC = String.raw`\d*[a-zA-Z-]${LETTERDASHNUMBER}*`;
const MAIN = String.raw`(${NUMERIC})\.(${NUMERIC})\.(${NUMERIC})`;
const MAIN_LOOSE = String.raw`(${NUMERIC_LOOSE})\.(${NUMERIC_LOOSE})\.(${NUMERIC_LOOSE})`;
const PRE_ID = `(?:${NON_NUMERIC}|${NUMERIC})`;
const PRE_ID_LOOSE = `(?:${NON_NUMERIC}|${NUMERIC_LOOSE})`;
const PRERELEASE = String.raw`(?:-(${PRE_ID}(?:\.${PRE_ID})*))`;
const PRERELEASE_LOOSE = String.raw`(?:-?(${PRE_ID_LOOSE}(?:\.${PRE_ID_LOOSE})*))`;
const BUILD_ID = `${LETTERDASHNUMBER}+`;
const BUILD = String.raw`(?:\+(${BUILD_ID}(?:\.${BUILD_ID})*))`;
const FULL_PLAIN = `v?${MAIN}${PRERELEASE}?${BUILD}?`;
const LOOSE_PLAIN = String.raw`[v=\s]*${MAIN_LOOSE}${PRERELEASE_LOOSE}?${BUILD}?`;
const GTLT = '((?:<|>)?=?)';
const XR = String.raw`${NUMERIC}|x|X|\*`;
const XRANGE_PLAIN = String.raw`[v=\s]*(${XR})(?:\.(${XR})(?:\.(${XR})(?:${PRERELEASE})?${BUILD}?)?)?`;
const LONE_TILDE = '(?:~>?)';
const LONE_CARET = String.raw`(?:\^)`;

const re = (source: string, flags = '') => new RegExp(safe(source), flags);
const FULL = re(`^${FULL_PLAIN}$`);
const LOOSE = re(`^${LOOSE_PLAIN}$`);
const XRANGE = re(String.raw`^${GTLT}\s*${XRANGE_PLAIN}$`);
const TILDE_TRIM = re(String.raw`(\s*)${LONE_TILDE}\s+`, 'g');
const TILDE = re(`^${LONE_TILDE}${XRANGE_PLAIN}$`);
const CARET_TRIM = re(String.raw`(\s*)${LONE_CARET}\s+`, 'g');
const CARET = re(`^${LONE_CARET}${XRANGE_PLAIN}$`);
const COMPARATOR = re(String.raw`^${GTLT}\s*(${FULL_PLAIN})$|^$`);
const COMPARATOR_TRIM = re(
  String.raw`(\s*)${GTLT}\s*(${LOOSE_PLAIN}|${XRANGE_PLAIN})`,
  'g',
);
const HYPHEN = re(
  String.raw`^\s*(${XRANGE_PLAIN})\s+-\s+(${XRANGE_PLAIN})\s*$`,
);
const STAR = re(String.raw`(<|>)?=?\s*\*`);
const GTE0 = re(String.raw`^\s*>=\s*0\.0\.0\s*$`);

type Part = string | undefined;
const isX = (id: Part): boolean =>
  id === undefined || id === '' || id.toLowerCase() === 'x' || id === '*';
const next = (id: Part): number => Number(id) + 1;

/** node-semver's `hyphenReplace`, without `includePrerelease`. */
function hyphen(
  ...[, from, fM, fm, fp, , , to, tM, tm, tp, tpr]: Part[]
): string {
  const lower = isX(fM)
    ? ''
    : isX(fm)
      ? `>=${fM}.0.0`
      : isX(fp)
        ? `>=${fM}.${fm}.0`
        : `>=${from}`;
  const upper = isX(tM)
    ? ''
    : isX(tm)
      ? `<${next(tM)}.0.0-0`
      : isX(tp)
        ? `<${tM}.${next(tm)}.0-0`
        : tpr
          ? `<=${tM}.${tm}.${tp}-${tpr}`
          : `<=${to}`;
  return `${lower} ${upper}`.trim();
}

/** node-semver's `replaceTilde`. */
function tilde(...[, M, m, p, pr]: Part[]): string {
  if (isX(M)) return '';
  if (isX(m)) return `>=${M}.0.0 <${next(M)}.0.0-0`;
  if (isX(p)) return `>=${M}.${m}.0 <${M}.${next(m)}.0-0`;
  return `>=${M}.${m}.${p}${pr ? `-${pr}` : ''} <${M}.${next(m)}.0-0`;
}

/** node-semver's `replaceCaret`, without `includePrerelease`. */
function caret(...[, M, m, p, pr]: Part[]): string {
  if (isX(M)) return '';
  if (isX(m)) return `>=${M}.0.0 <${next(M)}.0.0-0`;
  if (isX(p))
    return M === '0'
      ? `>=${M}.${m}.0 <${M}.${next(m)}.0-0`
      : `>=${M}.${m}.0 <${next(M)}.0.0-0`;
  const lower = `>=${M}.${m}.${p}${pr ? `-${pr}` : ''}`;
  if (M !== '0') return `${lower} <${next(M)}.0.0-0`;
  return m === '0'
    ? `${lower} <${M}.${m}.${next(p)}-0`
    : `${lower} <${M}.${next(m)}.0-0`;
}

/** node-semver's `replaceXRange`, without `includePrerelease`. */
function xRange(matched: string, ...[given, M, m, p]: Part[]): string {
  const xM = isX(M);
  const xm = xM || isX(m);
  const xp = xm || isX(p);
  let gtlt = given === '=' && xp ? '' : (given ?? '');
  if (xM) return gtlt === '>' || gtlt === '<' ? '<0.0.0-0' : '*';
  if (gtlt !== '' && xp) {
    let [major, minor, patch] = [Number(M), xm ? 0 : Number(m), 0];
    if (gtlt === '>') {
      gtlt = '>=';
      if (xm) [major, minor] = [major + 1, 0];
      else minor += 1;
    } else if (gtlt === '<=') {
      gtlt = '<';
      if (xm) major += 1;
      else minor += 1;
    }
    return `${gtlt}${major}.${minor}.${patch}${gtlt === '<' ? '-0' : ''}`;
  }
  if (xm) return `>=${M}.0.0 <${next(M)}.0.0-0`;
  if (xp) return `>=${M}.${m}.0 <${M}.${next(m)}.0-0`;
  return matched;
}

const each = (text: string, rewrite: (one: string) => string): string =>
  text.trim().split(/\s+/u).map(rewrite).join(' ');

/** node-semver's `parseComparator`: one space-separated piece, desugared. */
function desugar(piece: string): string {
  let text = each(piece, (one) => one.replace(CARET, caret));
  text = each(text, (one) => one.replace(TILDE, tilde));
  text = text
    .split(/\s+/u)
    .map((one) => one.trim().replace(XRANGE, xRange))
    .join(' ');
  return text.trim().replace(STAR, '');
}

/**
 * A version as node-semver's strict `SemVer` writes it back (no `v`, no build
 * metadata), or undefined where `new SemVer(text)` throws: leading zeros in a
 * number or in a numeric prerelease identifier (`1.2.3-01`), a partial version,
 * a `=` in front.
 */
export function npmVersion(text: string): string | undefined {
  if (text.length > MAX_LENGTH) return undefined;
  const match = FULL.exec(text.trim());
  if (match === null) return undefined;
  const [, major, minor, patch, prerelease] = match;
  if (
    [major, minor, patch].some((part) => Number(part) > Number.MAX_SAFE_INTEGER)
  )
    return undefined;
  return `${major}.${minor}.${patch}${prerelease === undefined ? '' : `-${prerelease}`}`;
}

/**
 * A version as node-semver's loose `SemVer` compares it (each number and each
 * numeric prerelease identifier as a number, no build), or undefined where
 * `new SemVer(text, { loose: true })` throws.
 */
function looseVersion(text: string): string | undefined {
  if (text.length > MAX_LENGTH) return undefined;
  const match = LOOSE.exec(text.trim());
  if (match === null) return undefined;
  const [, major, minor, patch, prerelease] = match;
  const main = [major, minor, patch].map(Number);
  if (main.some((part) => part > Number.MAX_SAFE_INTEGER)) return undefined;
  const ids = (prerelease ?? '')
    .split('.')
    .filter((id) => id !== '')
    .map((id) => (/^[0-9]+$/u.test(id) ? String(Number(id)) : id));
  return `${main.join('.')}${ids.length > 0 ? `-${ids.join('.')}` : ''}`;
}

/**
 * Whether two versions are one as pnpm compares an archive's version with the
 * lock's (`equalOrSemverEqual`): the same text, or node-semver's
 * `eq(a, b, { loose: true })`. Loose reading takes `=1.0.0`, `vv1.0.0`,
 * `01.0.0` and `1.0.0-01` as spellings of one version and ignores build
 * metadata. It makes two versions one only where node-semver itself does: a
 * numeric prerelease identifier beyond 2^53 is compared as a double, so
 * `1.0.0-12345678901234567890` and `1.0.0-12345678901234567891` are one, to
 * pnpm and here. Past such a pair node-semver stops comparing (`.a` and `.b`
 * after it are one to pnpm); this compares the rest, and refuses them.
 */
export function npmVersionsEqual(left: string, right: string): boolean {
  if (left === right) return true;
  const read = looseVersion(left);
  return read !== undefined && read === looseVersion(right);
}

/** node-semver's `Comparator`: the operator and version, `*`, or undefined when it refuses it. */
function comparator(text: string): NpmComparator | undefined {
  const match = COMPARATOR.exec(text.trim().split(/\s+/u).join(' '));
  if (match === null) return undefined;
  const operator = (match[1] === '=' ? '' : (match[1] ?? '')) as
    | ''
    | '<'
    | '<='
    | '>'
    | '>=';
  if (match[2] === undefined || match[2] === '') return { operator: '' };
  const written = npmVersion(match[2]);
  return written === undefined ? undefined : { operator, version: written };
}

const valueOf = (c: NpmComparator): string =>
  c.version === undefined ? '' : `${c.operator}${c.version}`;
const NULL_SET = '<0.0.0-0';

/** node-semver's `parseRange`: one `||` alternative as its comparators. */
function alternative(text: string): NpmComparator[] | undefined {
  const rewritten = text
    .replace(HYPHEN, hyphen)
    .replace(COMPARATOR_TRIM, '$1$2$3')
    .replace(TILDE_TRIM, '$1~')
    .replace(CARET_TRIM, '$1^');
  const pieces = rewritten
    .split(' ')
    .map(desugar)
    .join(' ')
    .split(/\s+/u)
    .map((piece) => piece.trim().replace(GTE0, ''));
  const comparators: NpmComparator[] = [];
  for (const piece of pieces) {
    const parsed = comparator(piece);
    if (parsed === undefined) return undefined;
    comparators.push(parsed);
  }
  const unique = new Map<string, NpmComparator>();
  for (const parsed of comparators) {
    if (valueOf(parsed) === NULL_SET) return [parsed];
    unique.set(valueOf(parsed), parsed);
  }
  if (unique.size > 1) unique.delete('');
  return [...unique.values()];
}

/**
 * The comparator sets of `text` as node-semver's `new Range(text)` keeps them,
 * or undefined when it throws (so `semver.validRange(text)` is null).
 */
export function npmComparatorSets(text: string): NpmComparator[][] | undefined {
  const raw = text.trim().replace(/\s+/gu, ' ');
  let sets: NpmComparator[][] = [];
  for (const part of raw.split('||')) {
    const set = alternative(part.trim());
    if (set === undefined) return undefined;
    if (set.length > 0) sets.push(set);
  }
  if (sets.length === 0) return undefined;
  if (sets.length > 1) {
    const first = sets[0]!;
    sets = sets.filter((set) => valueOf(set[0]!) !== NULL_SET);
    if (sets.length === 0) sets = [first];
    else if (sets.length > 1) {
      const any = sets.find(
        (set) => set.length === 1 && set[0]!.version === undefined,
      );
      if (any !== undefined) sets = [any];
    }
  }
  return sets;
}

/**
 * `text` as the range AST (an exact comparator is `=`, node-semver's `*` is
 * `any`), or undefined when node-semver refuses it.
 */
export function npmRangeAst(text: string): RangeAst | undefined {
  const sets = npmComparatorSets(text);
  if (sets === undefined) return undefined;
  const alternatives = sets.map((set): RangeAst => {
    const items = set.map(
      (each): RangeAst =>
        each.version === undefined
          ? { type: 'any' }
          : {
              type: 'comparison',
              operator: each.operator === '' ? '=' : each.operator,
              version: each.version,
            },
    );
    return items.length === 1 ? items[0]! : { type: 'and', items };
  });
  return alternatives.length === 1
    ? alternatives[0]!
    : { type: 'or', items: alternatives };
}

/**
 * `text` as `npmRangeAst` reads it, for the range parser's `npm` scheme: what
 * node-semver refuses is refused (`INVALID_NATIVE_RANGE`), and `bare`,
 * `commaAnd` and `hyphenRanges` do not apply, npm's grammar fixing all three.
 */
export function npmAst(text: string): RangeAst {
  const ast = npmRangeAst(text);
  if (ast === undefined)
    throw new ProviderError(
      'INVALID_NATIVE_RANGE',
      `Invalid npm range: ${quote(text)}`,
    );
  return ast;
}

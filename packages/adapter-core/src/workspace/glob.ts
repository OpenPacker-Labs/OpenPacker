import { WorkspaceError } from './errors.js';
import type { WorkspaceLimits } from './limits.js';

/**
 * The glob dialect workspace declarations are written in: `*`, `?`, `**` and
 * `{a,b}`, over `/`-separated directory paths. It is the subset npm (minimatch
 * and glob) and pnpm (picomatch and tinyglobby) agree on for naming
 * directories. Everything else those libraries read (character classes,
 * extglobs, brace ranges, backslash escapes) is refused by name, because a
 * pattern read differently by the tool and by opm would select different
 * members.
 *
 * Matching is by hand and linear in the pattern times the name: no pattern is
 * turned into a regular expression, so no pattern can make it backtrack.
 */

export type Segment =
  | { readonly kind: 'globstar' }
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'wild'; readonly text: string };

/** One pattern with its braces expanded: the segments of a directory path. */
export interface GlobAlternative {
  readonly segments: readonly Segment[];
}

const FORBIDDEN = /[\\()[\]|]/u;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/u;
const DRIVE = /^[A-Za-z]:$/u;

function unsupported(pattern: string, what: string): WorkspaceError {
  return new WorkspaceError(
    'WORKSPACE_PATTERN_UNSUPPORTED',
    `The workspace pattern ${JSON.stringify(pattern)} uses ${what}, which is not supported; use *, ?, ** and {a,b} with "/" separators`,
    [pattern],
  );
}

/** Expand `{a,b}` (nested and across "/"). Braces need a comma: `{a}` and `{1..3}` are refused. */
export function expandBraces(text: string, maximum: number): string[] {
  const open = text.indexOf('{');
  const stray = text.indexOf('}');
  if (open === -1) {
    if (stray !== -1)
      throw new WorkspaceError(
        'WORKSPACE_PATTERN_INVALID',
        `The workspace pattern ${JSON.stringify(text)} has a "}" with no "{"`,
        [text],
      );
    return [text];
  }
  if (stray !== -1 && stray < open)
    throw new WorkspaceError(
      'WORKSPACE_PATTERN_INVALID',
      `The workspace pattern ${JSON.stringify(text)} has a "}" with no "{"`,
      [text],
    );
  let depth = 0;
  let close = -1;
  const cuts: number[] = [];
  for (let at = open; at < text.length; at += 1) {
    const character = text[at];
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        close = at;
        break;
      }
    } else if (character === ',' && depth === 1) cuts.push(at);
  }
  if (close === -1)
    throw new WorkspaceError(
      'WORKSPACE_PATTERN_INVALID',
      `The workspace pattern ${JSON.stringify(text)} has a "{" with no "}"`,
      [text],
    );
  if (cuts.length === 0)
    throw unsupported(
      text,
      'braces without a comma (a single choice or a range)',
    );
  const prefix = text.slice(0, open);
  const suffix = text.slice(close + 1);
  const bounds = [open, ...cuts, close];
  const results: string[] = [];
  for (let index = 0; index + 1 < bounds.length; index += 1) {
    const part = text.slice(bounds[index]! + 1, bounds[index + 1]);
    for (const expanded of expandBraces(`${prefix}${part}${suffix}`, maximum)) {
      results.push(expanded);
      if (results.length > maximum)
        throw new WorkspaceError(
          'WORKSPACE_LIMIT_EXCEEDED',
          `The workspace pattern ${JSON.stringify(text)} expands to more than ${maximum} alternatives`,
          [text],
        );
    }
  }
  return results;
}

function parseSegments(alternative: string, original: string): Segment[] {
  const segments: Segment[] = [];
  const parts = alternative.split('/');
  for (const [index, part] of parts.entries()) {
    if (part === '') continue;
    if (part === '.') {
      // A pattern that is only "." names the root. A "." anywhere else is read
      // by pnpm and not by npm, which selects nothing for it, so it is refused.
      if (parts.length === 1) continue;
      throw new WorkspaceError(
        'WORKSPACE_PATTERN_INVALID',
        `The workspace pattern ${JSON.stringify(original)} has a "." segment; write the path without it`,
        [original],
      );
    }
    if (part === '..' || (index === 0 && DRIVE.test(part)))
      throw new WorkspaceError(
        'WORKSPACE_PATTERN_ESCAPES_ROOT',
        `The workspace pattern ${JSON.stringify(original)} leaves the workspace root (${part === '..' ? '".." segment' : 'drive letter'})`,
        [original],
      );
    if (part === '**') {
      if (segments.at(-1)?.kind !== 'globstar')
        segments.push({ kind: 'globstar' });
    } else if (part.includes('*') || part.includes('?')) {
      segments.push({ kind: 'wild', text: part.replace(/\*+/gu, '*') });
    } else segments.push({ kind: 'literal', text: part });
  }
  return segments;
}

/**
 * Compile one pattern (no leading `!`) into the alternatives its braces name.
 * A pattern with no segment left (`.`, `./`) compiles to one alternative with
 * none: it names the root itself.
 */
export function compileGlob(
  pattern: string,
  limits: WorkspaceLimits,
): readonly GlobAlternative[] {
  if (pattern.length > limits.maxPatternLength)
    throw new WorkspaceError(
      'WORKSPACE_LIMIT_EXCEEDED',
      `A workspace pattern is ${pattern.length} characters long, more than the limit of ${limits.maxPatternLength}`,
      [pattern.slice(0, 64)],
    );
  if (CONTROL.test(pattern))
    throw new WorkspaceError(
      'WORKSPACE_PATTERN_INVALID',
      `The workspace pattern ${JSON.stringify(pattern)} contains a control character`,
      [pattern],
    );
  if (FORBIDDEN.test(pattern))
    throw unsupported(
      pattern,
      'a backslash, a character class, an extglob or a group',
    );
  return expandBraces(pattern, limits.maxPatternAlternatives).map(
    (alternative) => ({ segments: parseSegments(alternative, pattern) }),
  );
}

/** `*` and `?` over code points, by the two-pointer walk: O(name x pattern), no backtracking blow-up. */
function wildMatches(pattern: string, name: string): boolean {
  const p = Array.from(pattern);
  const n = Array.from(name);
  let pi = 0;
  let ni = 0;
  let star = -1;
  let mark = 0;
  while (ni < n.length) {
    const pc = p[pi];
    if (pc === '*') {
      star = pi;
      pi += 1;
      mark = ni;
    } else if (pi < p.length && (pc === '?' || pc === n[ni])) {
      pi += 1;
      ni += 1;
    } else if (star !== -1) {
      pi = star + 1;
      mark += 1;
      ni = mark;
    } else return false;
  }
  while (p[pi] === '*') pi += 1;
  return pi === p.length;
}

/** A name starting with "." is matched only by a segment that starts with a literal "."; `node_modules` is never matched. */
function segmentAccepts(segment: Segment, name: string): boolean {
  if (name === 'node_modules') return false;
  if (segment.kind === 'literal') return segment.text === name;
  if (segment.kind === 'globstar') return !name.startsWith('.');
  if (name.startsWith('.') && !segment.text.startsWith('.')) return false;
  return wildMatches(segment.text, name);
}

/** The pattern positions reachable after the path, with a globstar standing for zero or more directories. */
function reachable(
  segments: readonly Segment[],
  path: readonly string[],
  globstarConsumes: boolean,
): ReadonlySet<number> {
  const close = (states: Set<number>): Set<number> => {
    for (const state of [...states].sort((a, b) => a - b)) {
      let at = state;
      while (segments[at]?.kind === 'globstar') {
        at += 1;
        states.add(at);
      }
    }
    return states;
  };
  let states = close(new Set([0]));
  for (const name of path) {
    const next = new Set<number>();
    for (const state of states) {
      const segment = segments[state];
      if (segment === undefined) continue;
      if (segment.kind === 'globstar') {
        if (globstarConsumes && segmentAccepts(segment, name)) next.add(state);
      } else if (segmentAccepts(segment, name)) next.add(state + 1);
    }
    states = close(next);
    if (states.size === 0) break;
  }
  return states;
}

/**
 * Whether the directory `path` (one name per element) matches the pattern.
 * With `globstarConsumes` false a `**` stands only for zero directories, which
 * tells a match the pattern names from one it reaches by searching.
 */
export function globMatches(
  glob: GlobAlternative,
  path: readonly string[],
  globstarConsumes = true,
): boolean {
  return reachable(glob.segments, path, globstarConsumes).has(
    glob.segments.length,
  );
}

/** Whether some directory at or below `prefix` could still match: the walk descends only where this holds. */
export function globMayMatchBelow(
  glob: GlobAlternative,
  prefix: readonly string[],
  globstarConsumes = true,
): boolean {
  for (const state of reachable(glob.segments, prefix, globstarConsumes))
    if (state < glob.segments.length) return true;
  return false;
}

/**
 * Whether a pattern written as text (`packages/*`) is matched by a glob, the
 * way `minimatch(pattern, glob)` reads it: the text is a path of names, `*` in
 * it is an ordinary character.
 */
export function textMatchesGlob(
  text: string,
  alternatives: readonly GlobAlternative[],
): boolean {
  const path = text.split('/').filter((part) => part !== '' && part !== '.');
  return alternatives.some((alternative) => globMatches(alternative, path));
}

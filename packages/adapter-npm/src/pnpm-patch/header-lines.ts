/**
 * The two header lines of a patch that pnpm reads with a regex that backtracks
 * (ADR 0056), read here in one pass over the line, and the bound on a header
 * line.
 *
 * pnpm's `parse.js` reads `index abc..def` with `/(\w+)\.\.(\w+)/` and
 * `diff --git a/x b/y` with `/^diff --git a\/(.*?) b\/(.*?)\s*$/`. Over one
 * line of n characters the first costs n^2 when there is no `..` in it and the
 * second when the line has many ` b/` or much whitespace before its end: 40,000
 * characters held `opm ci --plan` for 5.8 s and 160,000 for 104 s, before any
 * work budget exists. Each function below gives the match the regex gives (the
 * same groups, and no match where the regex has none; `header-lines.test.ts`
 * compares them over generated lines) without the search.
 */

import { PACKAGE_TREE_LIMITS } from '@openpacker/adapter-core';

/**
 * The longest header line opm reads: two paths of the longest a patch may
 * name (4,088 bytes, the 4,096 of a path in an archive less `package/`), the
 * `diff --git a/ b/` frame (16 characters) around them, 8,192 in all, and 108
 * of room for trailing whitespace, which the line may carry and is not part
 * of a path. A git diff writes nothing longer; a longer line is refused, not
 * read.
 */
export const MAXIMUM_HEADER_LINE =
  2 * PACKAGE_TREE_LIMITS.maximumPathBytes + 108;

/**
 * What a line begins with for the parser to read it: the `diff --git` line
 * and the header lines of a file's patch (`readHeaderLine`). Any other line
 * of the header part, a commit message or a mail header before the first
 * diff, an `index`-less note, a comment, is read as nothing, in time that
 * does not depend on its length (a few `startsWith`), and has no bound.
 */
export const INTERPRETED_PREFIXES = [
  'diff --git ',
  'old mode ',
  'new mode ',
  'deleted file mode ',
  'new file mode ',
  'rename from ',
  'rename to ',
  'index ',
  '--- ',
  '+++ ',
] as const;

/** True when the parser reads the line as a header line, and so bounds it. */
export const isInterpreted = (line: string): boolean =>
  INTERPRETED_PREFIXES.some((prefix) => line.startsWith(prefix));

/** A header line past `MAXIMUM_HEADER_LINE`; `readPatchText` makes it a `SIZE_LIMIT`. */
export class HeaderLineTooLong extends Error {
  constructor(readonly length: number) {
    super(`a header line of ${length} characters`);
    this.name = 'HeaderLineTooLong';
  }
}

/** `\w`: a letter or digit of ASCII, or `_`. */
const isWord = (code: number): boolean =>
  (code >= 48 && code <= 57) ||
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  code === 95;

/**
 * `/(\w+)\.\.(\w+)/.exec(line)`: the first run of word characters that is
 * followed by two dots and a word character, and the run after the dots. A
 * run starts where the regex first matches because a shorter match inside it
 * ends at the same place.
 */
export function indexHashes(line: string): readonly [string, string] | null {
  for (let start = 0; start < line.length; ) {
    if (!isWord(line.charCodeAt(start))) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < line.length && isWord(line.charCodeAt(end))) end += 1;
    if (
      line.startsWith('..', end) &&
      end + 2 < line.length &&
      isWord(line.charCodeAt(end + 2))
    ) {
      let stop = end + 3;
      while (stop < line.length && isWord(line.charCodeAt(stop))) stop += 1;
      return [line.slice(start, end), line.slice(end + 2, stop)];
    }
    start = end;
  }
  return null;
}

const FRAME = 'diff --git a/';

/**
 * `/^diff --git a\/(.*?) b\/(.*?)\s*$/.exec(line)`, the two paths. `.` stops at
 * a line terminator (`\n`, `\r`, U+2028, U+2029) and `\s*` does not, so the
 * match is the first ` b/` when no terminator comes before the line's trailing
 * whitespace; the second path is what is left of the line with that
 * whitespace taken off (`trimEnd` and `\s` are the same characters). Any later
 * ` b/` fails whenever the first does.
 */
export function diffLinePaths(line: string): readonly [string, string] | null {
  if (!line.startsWith(FRAME)) return null;
  const rest = line.slice(FRAME.length);
  const split = rest.indexOf(' b/');
  if (split === -1) return null;
  // The trailing whitespace starts after the "/" of " b/" at the earliest.
  const end = rest.trimEnd().length;
  const terminator = rest.search(/[\n\r\u2028\u2029]/u);
  if (terminator !== -1 && terminator < end) return null;
  return [rest.slice(0, split), rest.slice(split + 3, end)];
}

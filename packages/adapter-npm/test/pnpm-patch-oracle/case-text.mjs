/** What the cases of the oracle are written with (README.md). */

export const lines = (...items) => items.join('\n');
export const crlf = (text) => text.replace(/\n/gu, '\r\n');
/** Twenty-six numbered lines, each unique, so a hunk can only fit in one place. */
export const numbered = (count, prefix = 'line') =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);

export const MODIFY = lines(
  'diff --git a/index.js b/index.js',
  'index 1111111..2222222 100644',
  '--- a/index.js',
  '+++ b/index.js',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  '',
);

/** A hunk whose header puts it `claimed` lines from where its context is. */
export function shifted(claimed) {
  return lines(
    'diff --git a/long.js b/long.js',
    '--- a/long.js',
    '+++ b/long.js',
    `@@ -${claimed},3 +${claimed},3 @@`,
    ' line 30',
    '-line 31',
    '+LINE 31',
    ' line 32',
    '',
  );
}

export const LONG = { 'long.js': `${numbered(60).join('\n')}\n` };

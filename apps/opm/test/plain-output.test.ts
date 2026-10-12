import { describe, expect, it } from 'vitest';
import { HOSTILE, ciProject, lines, violations } from './plain-fixture.js';
import { type Ran } from './repo-fixture.js';

/**
 * A cloned repository's file cannot shape what opm writes, on either stream,
 * whichever command reads it: no line that looks like opm's own after any kind
 * of line break, and none of the characters a terminal acts on (escape and C1
 * sequences, bidirectional overrides, a lone carriage return). The same
 * repository is run with `x` and with hostile text in a field, and the two
 * outputs have the same number of lines.
 */
async function expectPlain(
  go: (text: string) => Promise<Ran>,
  // `opm manifest` prints a JSON document on stdout: what a string in it holds is
  // the document's content, so only its stderr is held to this.
  streams: { stdout: boolean } = { stdout: true },
): Promise<void> {
  const innocent = await go('x');
  const hostile = await go(HOSTILE);
  if (streams.stdout) {
    expect(violations(hostile.out)).toEqual([]);
    expect(lines(hostile.out)).toBe(lines(innocent.out));
  }
  expect(violations(hostile.err)).toEqual([]);
  expect(lines(hostile.err)).toBe(lines(innocent.err));
}

describe('opm ci, after it has installed', () => {
  const CI = [
    ['ci'],
    ['ci', '--production'],
    ['ci', '--omit', 'optional'],
  ] as const;

  it.each(CI)(
    'names a package that declares an install script on one line (%#)',
    async (...argv) => {
      const go = ciProject((builds, text) => {
        builds.version = `3.0.0${text}`;
      });
      const innocent = await go('x', [...argv]);
      expect(innocent.out).toContain('install script not run: builds@3.0.0x');
      await expectPlain((text) => go(text, [...argv]));
    },
  );

  it('names it on one line whatever its name field holds', async () => {
    const go = ciProject((builds, text) => {
      builds.name = `builds${text}`;
    });
    await expectPlain((text) => go(text, ['ci']));
  });
});

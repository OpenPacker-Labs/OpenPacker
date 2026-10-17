/**
 * The prefix of every line of a run over members is the member's name, or its
 * directory when `package.json` names none, and the script's (`run-output.ts`).
 * The member's own lines follow it as they are, as a child's output is passed
 * through. A name that holds a control or a bidi character is refused by
 * workspace discovery, but a directory is not, and a repository can hold one:
 * the prefix is escaped like every other value that reaches a terminal.
 */

import { describe, expect, it } from 'vitest';
import { contextWith, go, makeWorkspace } from './workspace-fixture.js';

const posix = describe.skipIf(process.platform === 'win32');

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1 = String.fromCharCode(0x9b);
const RLO = String.fromCharCode(0x202e);
const SLASH = String.fromCharCode(92);

/** The characters of `text` that a terminal would act on. */
function controls(text: string): string[] {
  return [...text].filter((char) => {
    const code = char.codePointAt(0)!;
    return (
      (code < 0x20 && code !== 0x0a) ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f) ||
      code === 0x202e
    );
  });
}

posix('a member whose name holds a control or a bidi character', () => {
  it.each([
    ['an escape', `a${ESC}]0;x${BEL}`],
    ['a C1 control', `a${C1}31m`],
    ['a right-to-left override', `a${RLO}b`],
  ])(
    'is refused before anything runs, and nothing reaches the terminal as a control (%s)',
    async (_what, name) => {
      const ws = await makeWorkspace({
        'packages/a': { name, scripts: { build: 'true' } },
        'packages/ok': { name: 'ok', scripts: { build: 'true' } },
      });
      const ran = await go('run', ['build', '-r'], ws.root, contextWith());
      expect(ran.status).not.toBe(0);
      expect(ran.err).toContain('cannot safely hold');
      expect(ran.out).toBe('');
      expect(await ws.log()).toEqual([]);
      expect(controls(ran.err + ran.out)).toEqual([]);
    },
  );
});

posix(
  'a member known only by a directory that holds a control or a bidi character',
  () => {
    it.each([
      ['an escape', ESC, `${SLASH}u001b`],
      ['a right-to-left override', RLO, `${SLASH}u202e`],
      ['a line feed', String.fromCharCode(0x0a), `${SLASH}n`],
    ])(
      'prefixes its lines with the directory as text, in the default and the streaming shape (%s)',
      async (_what, char, shown) => {
        for (const flags of [[], ['--stream']]) {
          const ws = await makeWorkspace({
            [`packages/a${char}b`]: {
              scripts: { build: 'echo out; echo err 1>&2' },
            },
            'packages/ok': { name: 'ok', scripts: { build: 'echo out' } },
          });
          const ran = await go(
            'run',
            ['build', '-r', ...flags],
            ws.root,
            contextWith(),
          );
          expect(ran.status, ran.err).toBe(0);
          expect(controls(ran.out + ran.err), flags.join(' ')).toEqual([]);
          // Every line says whose it is: a forged line cannot be made of a name.
          for (const line of (ran.out + ran.err).split('\n').filter(Boolean))
            expect(line, line).toMatch(
              /^(packages\/a.+b|ok) build: (out|err)$/u,
            );
          expect(ran.out).toContain(`a${shown}b build: out`);
          expect(ran.err).toContain(`a${shown}b build: err`);
        }
      },
    );
  },
);

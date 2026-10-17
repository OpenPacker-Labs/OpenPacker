/**
 * What the lock and the project's files say reaches a terminal only quoted
 * and escaped: a lock whose `os` held `ESC ] 0 ; PWN BEL` set the terminal's
 * title when opm ci refused it.
 */

import type { NativeTarget } from '@openpacker/adapter-core';
import { describe, expect, it } from 'vitest';
import { readPnpmLock } from '../pnpm-lock/index.js';
import { LOCK, pkg } from './lock-support.js';
import { buildPnpmModel } from './model.js';
import { quote } from './quote.js';
import { selectTops } from './scope.js';
import { selectInstances } from './select.js';

const LINUX: NativeTarget = { os: 'linux', architecture: 'x64', libc: 'glibc' };

/** Whether `text` holds a character a terminal acts on rather than shows. */
const hasControl = (text: string): boolean =>
  [...text].some((character) => {
    const code = character.codePointAt(0)!;
    return (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    );
  });

describe('a value in a message', () => {
  it('is quoted with every control character escaped', () => {
    expect(quote('a\u001b]0;PWN\u0007b')).toBe('"a\\u001b]0;PWN\\u0007b"');
    expect(quote('\u009b31m')).toBe('"\\u009b31m"');
    expect(quote('evil\u202etxt.exe')).toBe('"evil\\u202etxt.exe"');
    expect(quote('line\u2028break')).toBe('"line\\u2028break"');
    expect(quote('plain@1.0.0')).toBe('"plain@1.0.0"');
  });

  it('is cut to a length a line can hold, saying how long it was', () => {
    const shown = quote('x'.repeat(200_000));
    expect(shown.length).toBeLessThan(260);
    expect(shown).toMatch(/\.\.\. \(200000 characters\)$/u);
  });
});

describe('the platform refusal of a package whose lock entry is hostile', () => {
  const model = buildPnpmModel(
    readPnpmLock(
      LOCK(`importers:

  .:
    dependencies:
      native:
        specifier: 1.0.0
        version: 1.0.0

packages:

${pkg('native@1.0.0', '    os: ["darwin\\e]0;PWN\\a"]\n    cpu: ["arm64\\e[2J"]\n    libc: ["musl\\a"]\n')}

snapshots:

  native@1.0.0: {}
`),
    ).lock,
  );

  it('writes the os, cpu and libc quoted, and no control character', () => {
    const selection = selectInstances({
      model,
      tops: selectTops(model),
      omit: new Set(),
      targets: [LINUX],
    });
    expect(selection.refused).toHaveLength(1);
    const reason = selection.refused[0]!.reason;
    expect(hasControl(reason)).toBe(false);
    expect(reason).toBe(
      '"native@1.0.0" is for os "darwin\\u001b]0;PWN\\u0007" cpu "arm64\\u001b[2J" libc "musl\\u0007", not "linux/x64/glibc", and is not optional',
    );
  });
});

/**
 * The spelling classes of tar-spelling.ts, field by field: every spelling the
 * registry sample holds is accepted, and a spelling outside the classes is
 * refused whether or not the readers happen to read it alike (the oracle's
 * OVER_REFUSED cases are the ones they read alike).
 */

import { describe, expect, it } from 'vitest';
import { assertSpellingKnown } from './tar-spelling.js';

/** A ustar header spelled as npm writes one, then `text` (Latin-1) written at `offset`. */
function header(edits: Array<[number, string | number[]]> = []): Uint8Array {
  const bytes = Buffer.alloc(512);
  bytes.write('package/a.js', 0);
  bytes.write('000644 \0', 100, 'latin1');
  bytes.write('000000 \0', 108, 'latin1');
  bytes.write('000000 \0', 116, 'latin1');
  bytes.write('00000000004 ', 124, 'latin1');
  bytes.write('14572541052 ', 136, 'latin1');
  bytes.write('012345\0 ', 148, 'latin1');
  bytes.write('0', 156);
  bytes.write('ustar\u000000', 257, 'latin1');
  bytes.write('000000 \0', 329, 'latin1');
  bytes.write('000000 \0', 337, 'latin1');
  for (const [offset, text] of edits)
    if (typeof text === 'string') bytes.write(text, offset, 'latin1');
    else Buffer.from(text).copy(bytes, offset);
  return bytes;
}

const refused = (bytes: Uint8Array, ustar = true): string | undefined => {
  try {
    assertSpellingKnown(bytes, 0, ustar);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

describe('the spelling of a header', () => {
  it('as npm, GNU tar and the other writers in the registry spell it is accepted', () => {
    expect(refused(header())).toBeUndefined();
    for (const edits of [
      [[148, '0012345\0']],
      [[148, '012345 \0']],
      [[100, '0000644\0']],
      [[100, '0000755\0']],
      [[108, '\0'.repeat(8)]],
      [[108, '0001750\0']],
      [[108, [0x80, 0, 0, 0, 0, 0, 0x30, 0x39]]],
      [[124, '00000000004\0']],
      [[124, '0000000004 \0']],
      [[136, '14572541052\0']],
      [
        [
          136,
          [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0],
        ],
      ],
      [[257, 'ustar  \0']],
      [[257, '\0'.repeat(8)]],
      [[329, '\0'.repeat(8)]],
      [[476, '14572541052\0']],
    ] as Array<Array<[number, string | number[]]>>)
      expect(refused(header(edits)), JSON.stringify(edits)).toBeUndefined();
  });

  it.each([
    ['checksum', 148, '\n 12345\0'],
    ['checksum', 148, '12345\0x\0'],
    ['mode', 100, '\0' + '000644\0'],
    ['mode', 100, '000644\0x'],
    ['mode', 100, '\t 00644\0'],
    ['mode', 100, '+0644\0\0\0'],
    ['uid', 108, '000000\0x'],
    ['uid', 108, '0000009\0'],
    ['gid', 116, 'abc\0\0\0\0\0'],
    ['size', 124, '0000000004\0x'],
    ['size', 124, '\0' + '0000000004\0'],
    ['mtime', 136, '0000000000z\0'],
    ['magic', 257, 'ustar\u00000 '],
    ['magic', 257, 'USTAR\u000000'],
    ['devmajor', 329, 'zzzzzzz\0'],
    ['atime', 476, 'zzzzzzzzzzz\0'],
    ['last 12 bytes', 500, 'tail'],
  ])('with its %s spelled otherwise is refused (%#)', (label, offset, text) => {
    const error = (() => {
      try {
        assertSpellingKnown(header([[offset, text]]), 0, true);
        return undefined;
      } catch (thrown) {
        return thrown as { code?: string; message: string };
      }
    })();
    expect(error?.code).toBe('TAR_AMBIGUOUS_SPELLING');
    expect(error?.message).toContain(label);
  });

  it('may hold base-256 where node-tar writes it, and not in the mode or the size', () => {
    const big = [0x80, 0, 0, 0, 0, 0, 0, 1];
    expect(refused(header([[116, big]]))).toBeUndefined();
    expect(refused(header([[100, big]]))).toBe('TAR_AMBIGUOUS_SPELLING');
    expect(refused(header([[124, [...big, 0, 0, 0, 0]]]))).toBe(
      'TAR_AMBIGUOUS_SPELLING',
    );
  });

  it('reads devmajor and devminor only under ustar magic, and atime and ctime only when byte 475 is zero', () => {
    expect(refused(header([[329, 'zzzzzzz\0']]), false)).toBeUndefined();
    expect(refused(header([[337, 'zzzzzzz\0']]), false)).toBeUndefined();
    expect(
      refused(
        header([
          [475, 'p'],
          [476, 'zzzzzzzzzzz\0'],
        ]),
      ),
    ).toBeUndefined();
    expect(refused(header([[488, 'zzzzzzzzzzz\0']]))).toBe(
      'TAR_AMBIGUOUS_SPELLING',
    );
  });
});

/**
 * Text in a tar header is UTF-8 up to its first NUL. Bytes that are not UTF-8
 * (a name written in Latin-1, say) are an archive the materializer refuses with
 * its own typed error, not a bare TypeError from the decoder.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_MATERIALIZATION_LIMITS, inspectArchive } from './index.js';
import { MaterializationError } from './errors.js';
import { tarText } from './tar-fields.js';

/** The code a call refuses with, or what it threw if that is no MaterializationError. */
const refusal = (run: () => string): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof MaterializationError
      ? error.code
      : `not a MaterializationError: ${String(error)}`;
  }
  return undefined;
};

/** One file's header (ustar magic) and data, then the end of the archive. */
function archive(edit: (header: Buffer) => void): Uint8Array {
  const header = Buffer.alloc(512);
  header.write('package/a.js', 0);
  header.write('0000644\0', 100);
  header.write('00000000001\0', 124);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  edit(header);
  header.write('        ', 148);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const data = Buffer.alloc(512);
  data.write('a');
  return Buffer.concat([header, data, Buffer.alloc(1024)]);
}

describe('tarText', () => {
  it('reads up to the first NUL and ignores what follows it', () => {
    expect(tarText(Uint8Array.of(0x61, 0x62, 0, 0xff, 0xfe))).toBe('ab');
    expect(tarText(Uint8Array.of(0xc3, 0xa9))).toBe('é');
  });

  it('refuses bytes that are not UTF-8 with a typed error', () => {
    expect(refusal(() => tarText(Uint8Array.of(0x61, 0xe9, 0x62)))).toBe(
      'INVALID_TAR_TEXT',
    );
  });
});

describe('a header whose text is not UTF-8', () => {
  it.each([
    ['name', (header: Buffer) => header.write('package/é.js', 0, 'latin1')],
    ['prefix', (header: Buffer) => header.write('packé', 345, 'latin1')],
  ])('refuses its %s as INVALID_TAR_TEXT, in either mode', async (_, edit) => {
    for (const npm of [false, true])
      await expect(
        inspectArchive(
          archive((header) => edit(header)),
          'tar',
          {
            ...DEFAULT_MATERIALIZATION_LIMITS,
            ...(npm && { requireNpmReaderAgreement: true }),
          },
        ),
      ).rejects.toMatchObject({
        name: 'MaterializationError',
        code: 'INVALID_TAR_TEXT',
      });
  });
});

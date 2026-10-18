/**
 * What `assertPaxAgrees` refuses in a pax header's body (ADR 0057 §8): a newline
 * inside a record, and a header of more than one block (512 bytes) with a byte
 * past 0x7f. The archives that show the readers part over it are in
 * test/tar-oracle (tar-end.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { assertPaxAgrees } from './tar-agreement.js';

const refused = (data: Uint8Array): string | undefined => {
  try {
    assertPaxAgrees(data, 0);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};
/** One record, `<length> comment=<value>\n`, with the length counting itself. */
const comment = (value: string): Uint8Array => {
  const line = ` comment=${value}\n`;
  const bytes = Buffer.byteLength(line);
  const length = bytes + String(bytes + String(bytes).length).length;
  return Buffer.from(`${length}${line}`);
};
/** One record, `<length> <key>=<value>\n`, the length counting itself. */
const rawRecord = (key: string, value: string): string => {
  const line = ` ${key}=${value}\n`;
  const bytes = Buffer.byteLength(line);
  const length = bytes + String(bytes + String(bytes).length).length;
  return `${length}${line}`;
};
/**
 * A header body of exactly `size` bytes: a short comment, then one whose value
 * ends in `tail`. One record alone cannot reach every size, because the digits
 * of its length move with it, so the first record is tried at a few lengths.
 */
const body = (size: number, tail: string): Uint8Array => {
  for (let first = 0; first < 12; first += 1) {
    const head = comment('y'.repeat(first));
    for (let fill = 0; fill < size; fill += 1) {
      const record = comment('x'.repeat(fill) + tail);
      if (head.byteLength + record.byteLength === size)
        return Buffer.concat([head, record]);
    }
  }
  throw new Error(`no two records are ${size} bytes`);
};

describe('a pax header body', () => {
  it('may be ASCII of any length', () => {
    expect(refused(body(100, ''))).toBeUndefined();
    expect(refused(body(512, ''))).toBeUndefined();
    expect(refused(body(513, ''))).toBeUndefined();
    expect(refused(body(4096, ''))).toBeUndefined();
  });

  it('may hold bytes past 0x7f in one block, not in more than one', () => {
    expect(refused(body(100, 'é'))).toBeUndefined();
    expect(refused(body(512, 'é'))).toBeUndefined();
    expect(refused(body(513, 'é'))).toBe('TAR_AMBIGUOUS_PAX');
    expect(refused(body(4096, 'é'))).toBe('TAR_AMBIGUOUS_PAX');
  });

  it('may not hold a linkpath record, in any of its records', () => {
    expect(refused(Buffer.from(rawRecord('linkpath', '1234')))).toBe(
      'TAR_AMBIGUOUS_PAX',
    );
    expect(refused(Buffer.from(rawRecord('linkpath', '..')))).toBe(
      'TAR_AMBIGUOUS_PAX',
    );
    expect(
      refused(
        Buffer.concat([
          comment('fine'),
          Buffer.from(rawRecord('linkpath', '')),
        ]),
      ),
    ).toBe('TAR_AMBIGUOUS_PAX');
  });

  it('may hold records that only look like a linkpath', () => {
    for (const record of [
      rawRecord('linkpathx', '1'),
      rawRecord('xlinkpath', '1'),
      rawRecord('comment', 'linkpath=1'),
      rawRecord('LINKPATH', '1'),
      rawRecord('SCHILY.linkpath', '1'),
    ])
      expect(refused(Buffer.from(record)), record).toBeUndefined();
  });

  it('may not hold a newline inside a record, in any of its records', () => {
    expect(refused(comment('one\ntwo'))).toBe('TAR_AMBIGUOUS_PAX');
    const second = Buffer.concat([comment('fine'), comment('a\nb')]);
    expect(refused(second)).toBe('TAR_AMBIGUOUS_PAX');
    expect(refused(Buffer.concat([comment('fine'), comment('fine')]))).toBe(
      undefined,
    );
  });
});

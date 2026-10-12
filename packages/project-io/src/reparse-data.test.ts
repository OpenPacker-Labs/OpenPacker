import { describe, expect, it } from 'vitest';
import {
  IO_REPARSE_TAG_MOUNT_POINT,
  IO_REPARSE_TAG_SYMLINK,
  decodeReparse,
  encodeMountPoint,
  junctionPath,
  ntSubstituteName,
  pathOfSubstituteName,
  relativeTargetOf,
  samePath,
} from './reparse-data.js';

/** Little-endian UTF-16 of an ASCII string, as hex. */
const wide = (text: string): string =>
  Buffer.from(text, 'utf16le').toString('hex');

describe('encodeMountPoint', () => {
  it('lays out REPARSE_DATA_BUFFER exactly as documented', () => {
    // \??\C:\a (8 characters, 16 bytes) and C:\a (4 characters, 8 bytes):
    // tag, data length 36 = 8 + (16 + 2 + 8 + 2), reserved, then the four
    // offsets and lengths of MountPointReparseBuffer, then PathBuffer.
    const expected = [
      '030000a0',
      '2400',
      '0000',
      '0000',
      '1000',
      '1200',
      '0800',
      wide('\\??\\C:\\a'),
      '0000',
      wide('C:\\a'),
      '0000',
    ].join('');

    expect(encodeMountPoint('\\??\\C:\\a', 'C:\\a').toString('hex')).toBe(
      expected,
    );
  });

  it('round-trips through decodeReparse', () => {
    const buffer = encodeMountPoint(
      '\\??\\D:\\work\\é-日本',
      'D:\\work\\é-日本',
    );

    expect(decodeReparse(buffer)).toEqual({
      tag: IO_REPARSE_TAG_MOUNT_POINT,
      substitute: '\\??\\D:\\work\\é-日本',
      print: 'D:\\work\\é-日本',
      relative: false,
    });
  });

  it('refuses a target whose reparse data would pass the 16 KiB limit', () => {
    const long = `C:\\${'a'.repeat(9000)}`;
    expect(() => encodeMountPoint(`\\??\\${long}`, long)).toThrow(RangeError);
  });
});

describe('decodeReparse', () => {
  it('reads a symbolic-link buffer, with its relative flag', () => {
    const substitute = Buffer.from('..\\x', 'utf16le');
    const print = Buffer.from('..\\x', 'utf16le');
    const buffer = Buffer.alloc(20 + substitute.length + print.length);
    buffer.writeUInt32LE(IO_REPARSE_TAG_SYMLINK, 0);
    buffer.writeUInt16LE(buffer.length - 8, 4);
    buffer.writeUInt16LE(0, 8);
    buffer.writeUInt16LE(substitute.length, 10);
    buffer.writeUInt16LE(substitute.length, 12);
    buffer.writeUInt16LE(print.length, 14);
    buffer.writeUInt32LE(1, 16);
    substitute.copy(buffer, 20);
    print.copy(buffer, 20 + substitute.length);

    expect(decodeReparse(buffer)).toEqual({
      tag: IO_REPARSE_TAG_SYMLINK,
      substitute: '..\\x',
      print: '..\\x',
      relative: true,
    });
  });

  it('does not read a tag it does not know', () => {
    const buffer = Buffer.alloc(32);
    buffer.writeUInt32LE(0x9000001a, 0);
    expect(decodeReparse(buffer)).toBeUndefined();
  });

  it('refuses a buffer that is shorter than its header or than its names', () => {
    expect(() => decodeReparse(Buffer.alloc(4))).toThrow(RangeError);
    const lying = encodeMountPoint('\\??\\C:\\a', 'C:\\a');
    lying.writeUInt16LE(500, 10);
    expect(() => decodeReparse(lying)).toThrow(/runs past the/u);
  });
});

describe('NT names', () => {
  it.each([
    [
      'C:\\proj\\packages\\a',
      '\\??\\C:\\proj\\packages\\a',
      'C:\\proj\\packages\\a',
    ],
    ['C:\\proj\\a\\', '\\??\\C:\\proj\\a', 'C:\\proj\\a'],
    ['C:\\', '\\??\\C:\\', 'C:\\'],
    [
      '\\\\server\\share\\a',
      '\\??\\UNC\\server\\share\\a',
      '\\\\server\\share\\a',
    ],
    ['\\\\?\\C:\\a', '\\??\\C:\\a', 'C:\\a'],
    [
      '\\\\?\\UNC\\server\\share\\a',
      '\\??\\UNC\\server\\share\\a',
      '\\\\server\\share\\a',
    ],
  ])('writes %s as %s and reads it back as %s', (path, substitute, back) => {
    expect(ntSubstituteName(path)).toBe(substitute);
    expect(pathOfSubstituteName(substitute)).toBe(back);
  });
});

describe('the text of a junction', () => {
  const root = 'C:\\work\\project';

  it('resolves a relative target against the link directory', () => {
    expect(
      junctionPath(root, 'node_modules/@scope', '../../packages/pkg'),
    ).toBe('C:\\work\\project\\packages\\pkg');
    expect(junctionPath(root, 'node_modules', '../packages/pkg')).toBe(
      'C:\\work\\project\\packages\\pkg',
    );
  });

  it('gives the relative text back, with forward slashes', () => {
    expect(
      relativeTargetOf(
        root,
        'node_modules/@scope',
        'C:\\work\\project\\packages\\pkg',
      ),
    ).toBe('../../packages/pkg');
  });

  it('is the identity through a round trip for every shape of link', () => {
    for (const [directory, target] of [
      ['node_modules', '../packages/pkg'],
      ['node_modules/@s', '../../a/b/c'],
      ['node_modules/x/node_modules', '../../../packages/pkg'],
    ] as const)
      expect(
        relativeTargetOf(
          root,
          directory,
          junctionPath(root, directory, target),
        ),
      ).toBe(target);
  });

  it('does not invent a relative form for another drive', () => {
    expect(relativeTargetOf(root, 'node_modules', 'D:\\other\\pkg')).toBe(
      'D:\\other\\pkg',
    );
  });

  it('compares paths without case or a trailing slash', () => {
    expect(samePath('C:\\Work\\Project\\', 'c:\\work\\project')).toBe(true);
    expect(samePath('C:\\work\\a', 'C:\\work\\b')).toBe(false);
  });
});

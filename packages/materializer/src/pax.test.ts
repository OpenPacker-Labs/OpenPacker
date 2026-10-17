import { describe, expect, it } from 'vitest';
import { inspectArchive } from './index.js';

interface Block {
  name: string;
  type?: string;
  data?: string | Uint8Array;
}

/** A ustar archive from the entries given, spelled exactly as given. */
function tar(entries: readonly Block[]): Uint8Array {
  const text = new TextEncoder();
  const blocks: Uint8Array[] = [];
  const octal = (value: number, length: number): Uint8Array =>
    text.encode(value.toString(8).padStart(length - 1, '0') + '\0');
  for (const entry of entries) {
    const data =
      typeof entry.data === 'string'
        ? text.encode(entry.data)
        : (entry.data ?? new Uint8Array());
    const header = new Uint8Array(512);
    header.set(text.encode(entry.name), 0);
    header.set(octal(0o644, 8), 100);
    header.set(octal(0, 8), 108);
    header.set(octal(0, 8), 116);
    header.set(octal(data.byteLength, 12), 124);
    header.set(octal(0, 12), 136);
    header.fill(32, 148, 156);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    header.set(text.encode('ustar\0'), 257);
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.set(text.encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148);
    blocks.push(
      header,
      data,
      new Uint8Array((512 - (data.byteLength % 512)) % 512),
    );
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((sum, b) => sum + b.byteLength, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.byteLength;
  }
  return out;
}

/** One pax record, its length (in bytes) counting its own digits. */
function record(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const size = Buffer.byteLength(body);
  let length = size + 1;
  while (String(length).length + size !== length)
    length = String(length).length + size;
  return `${length}${body}`;
}

const LONG = `package/esm/models/operations/${'documentlookup'.repeat(8)}.d.ts.map`;

describe('pax extended headers', () => {
  it('give the entry after them the path the header could not hold', async () => {
    expect(LONG.length).toBeGreaterThan(100);
    const entries = await inspectArchive(
      tar([
        {
          name: 'PaxHeader/documentlookup',
          type: 'x',
          data: record('path', LONG) + record('mtime', '1700000000.123'),
        },
        { name: LONG.slice(0, 100), data: 'map' },
        { name: 'package/package.json', data: '{}' },
      ]),
      'tar',
    );
    expect(entries.map((entry) => entry.path)).toEqual([
      LONG,
      'package/package.json',
    ]);
    expect(Buffer.from(entries[0]!.data).toString()).toBe('map');
  });

  it('apply to one entry and no more', async () => {
    const entries = await inspectArchive(
      tar([
        {
          name: 'PaxHeader/a',
          type: 'x',
          data: record('path', 'package/long'),
        },
        { name: 'package/short', data: 'one' },
        { name: 'package/other', data: 'two' },
      ]),
      'tar',
    );
    expect(entries.map((entry) => entry.path)).toEqual([
      'package/long',
      'package/other',
    ]);
  });

  it('carry a path in UTF-8', async () => {
    const entries = await inspectArchive(
      tar([
        {
          name: 'PaxHeader/a',
          type: 'x',
          data: record('path', 'package/dönerz.js'),
        },
        { name: 'package/d', data: 'x' },
      ]),
      'tar',
    );
    expect(entries[0]?.path).toBe('package/dönerz.js');
  });

  it('are checked as the path of any entry is', async () => {
    for (const path of ['../escape', '/etc/passwd', 'package/../../x'])
      await expect(
        inspectArchive(
          tar([
            { name: 'PaxHeader/a', type: 'x', data: record('path', path) },
            { name: 'package/ok', data: 'x' },
          ]),
          'tar',
        ),
        path,
      ).rejects.toThrow(/PATH_TRAVERSAL|ABSOLUTE_PATH/u);
  });

  it('cannot rename an entry onto another', async () => {
    await expect(
      inspectArchive(
        tar([
          { name: 'package/a', data: 'one' },
          { name: 'PaxHeader/a', type: 'x', data: record('path', 'package/a') },
          { name: 'package/b', data: 'two' },
        ]),
        'tar',
      ),
    ).rejects.toThrow(/DUPLICATE/u);
  });

  it.each([
    ['a length that is not the record', '99 path=package/x\n'],
    ['a length with no record', '3 \n'],
    ['no newline', '15 path=package/x'],
    ['no equals sign', '14 pathpackage\n'],
    ['a zero length', '0 path=package/x\n'],
    ['a record cut short', '30 path=package/x\n'],
    ['bytes after the last record', `${record('path', 'package/x')}garbage`],
  ])('are refused with %s', async (_label, data) => {
    await expect(
      inspectArchive(
        tar([
          { name: 'PaxHeader/a', type: 'x', data },
          { name: 'package/ok', data: 'x' },
        ]),
        'tar',
      ),
    ).rejects.toThrow(/INVALID_PAX_HEADER/u);
  });

  it('keeps a byte order mark in a key, as node-tar and pnpm do: it is not `path`', async () => {
    const entries = await inspectArchive(
      tar([
        {
          name: 'PaxHeader/a',
          type: 'x',
          data: record('\uFEFFpath', 'package/renamed'),
        },
        { name: 'package/ok', data: 'x' },
      ]),
      'tar',
    );
    expect(entries.map(({ path }) => path)).toEqual(['package/ok']);
  });

  it('may repeat the size the entry already has, as npm writes them', async () => {
    const entries = await inspectArchive(
      tar([
        {
          name: 'PaxHeader/a',
          type: 'x',
          data:
            record('path', LONG) +
            record('mtime', '499162500') +
            record('size', '3'),
        },
        { name: LONG.slice(0, 100), data: 'map' },
      ]),
      'tar',
    );
    expect(entries.map((entry) => entry.path)).toEqual([LONG]);
  });

  it('are refused when they would change the size of the entry', async () => {
    for (const size of ['0', '4', '03', '1e1', '9999999999'])
      await expect(
        inspectArchive(
          tar([
            { name: 'PaxHeader/a', type: 'x', data: record('size', size) },
            { name: 'package/ok', data: 'one' },
          ]),
          'tar',
        ),
        size,
      ).rejects.toThrow(/PAX_SIZE_REJECTED/u);
  });

  it('are refused in pairs, and with no entry after them', async () => {
    const once = {
      name: 'PaxHeader/a',
      type: 'x',
      data: record('path', 'p/a'),
    };
    await expect(
      inspectArchive(tar([once, once, { name: 'package/ok' }]), 'tar'),
    ).rejects.toThrow(/INVALID_PAX_HEADER/u);
    await expect(
      inspectArchive(tar([{ name: 'package/ok' }, once]), 'tar'),
    ).rejects.toThrow(/INVALID_PAX_HEADER/u);
  });

  it('are bounded in size', async () => {
    await expect(
      inspectArchive(
        tar([
          {
            name: 'PaxHeader/a',
            type: 'x',
            data: record('comment', 'x'.repeat(70_000)),
          },
          { name: 'package/ok', data: 'x' },
        ]),
        'tar',
      ),
    ).rejects.toThrow(/PAX_HEADER_LIMIT/u);
  });

  describe('global ones', () => {
    it('are read and change nothing', async () => {
      const entries = await inspectArchive(
        tar([
          {
            name: 'pax_global_header',
            type: 'g',
            data: record('comment', 'abcdef0123456789'),
          },
          { name: 'package/package.json', data: '{}' },
        ]),
        'tar',
      );
      expect(entries.map((entry) => entry.path)).toEqual([
        'package/package.json',
      ]);
    });

    it.each([
      ['a path', record('path', 'package/x')],
      ['a size', record('size', '1')],
    ])('cannot name every entry by %s', async (_label, data) => {
      await expect(
        inspectArchive(
          tar([
            { name: 'g', type: 'g', data },
            { name: 'package/a', data: '1' },
          ]),
          'tar',
        ),
      ).rejects.toThrow(/PAX_GLOBAL_REJECTED/u);
    });
  });

  it('still leave the other entry types refused', async () => {
    await expect(
      inspectArchive(
        tar([
          { name: 'PaxHeader/a', type: 'x', data: record('path', 'package/l') },
          { name: 'package/l', type: '2' },
        ]),
        'tar',
      ),
    ).rejects.toThrow(/SYMLINK_REJECTED/u);
  });
});

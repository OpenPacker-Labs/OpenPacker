/**
 * How the Windows backend types a directory listing, run on any platform
 * against a fake NtQueryDirectoryFile that writes FILE_DIRECTORY_INFORMATION
 * records. What NTFS reports for a real junction is for the Windows leg of CI
 * (handle-windows-link.test.ts); this pins the part that is ours: the offsets
 * read, the end of the listing, and that a reparse point is never a directory.
 */

import { describe, expect, it } from 'vitest';
import {
  listNtDirectory,
  scanNtDirectory,
  type NtQueryDirectory,
} from './handle-nt-dir.js';

const DIRECTORY = 0x10;
const NORMAL = 0x80;
const REPARSE_POINT = 0x400;
const NO_MORE_FILES = 0x80000006 | 0;

/** One FILE_DIRECTORY_INFORMATION record: attributes at 56, name length at 60, name at 64. */
function record(name: string, attributes: number): Buffer {
  const nameBytes = Buffer.from(name, 'utf16le');
  const size = Math.ceil((64 + nameBytes.length) / 8) * 8;
  const entry = Buffer.alloc(size);
  entry.writeUInt32LE(attributes, 56);
  entry.writeUInt32LE(nameBytes.length, 60);
  nameBytes.copy(entry, 64);
  return entry;
}

/** A directory that answers the first query with `entries` and the second with no more files. */
function directory(entries: [string, number][]): NtQueryDirectory {
  let queries = 0;
  return {
    getOsFHandle: (fd) => ({ fd }),
    NtQueryDirectoryFile: (...args: never[]) => {
      const call = args as unknown[];
      const buffer = call[5] as Buffer;
      queries += 1;
      if (queries > 1) return NO_MORE_FILES;
      let offset = 0;
      entries.forEach(([name, attributes], index) => {
        const entry = record(name, attributes);
        if (index < entries.length - 1) entry.writeUInt32LE(entry.length, 0);
        entry.copy(buffer, offset);
        offset += entry.length;
      });
      return 0;
    },
  };
}

/**
 * A directory that answers each query with the next page of `pages`, then with
 * no more files, and counts the queries made.
 */
function paged(pages: [string, number][][]): {
  api: NtQueryDirectory;
  queries: () => number;
} {
  let queries = 0;
  return {
    queries: () => queries,
    api: {
      getOsFHandle: (fd) => ({ fd }),
      NtQueryDirectoryFile: (...args: never[]) => {
        const buffer = (args as unknown[])[5] as Buffer;
        const page = pages[queries];
        queries += 1;
        if (page === undefined) return NO_MORE_FILES;
        let offset = 0;
        page.forEach(([name, attributes], index) => {
          const entry = record(name, attributes);
          if (index < page.length - 1) entry.writeUInt32LE(entry.length, 0);
          entry.copy(buffer, offset);
          offset += entry.length;
        });
        return 0;
      },
    },
  };
}

const never = (status: number, name: string): never => {
  throw new Error(`unexpected NT status 0x${status.toString(16)} for ${name}`);
};

describe('listNtDirectory', () => {
  it('types a file, a directory and a reparse point from their attributes, and drops . and ..', () => {
    const listed = listNtDirectory(
      directory([
        ['.', DIRECTORY],
        ['..', DIRECTORY],
        ['a.txt', NORMAL],
        ['sub', DIRECTORY],
        ['pkg', DIRECTORY | REPARSE_POINT],
      ]),
      7,
      never,
    );

    expect(listed.map((entry) => entry.name)).toEqual(['a.txt', 'sub', 'pkg']);
    const [file, folder, junction] = listed;
    expect(
      [file!.isFile(), file!.isDirectory(), file!.isSymbolicLink()],
      'a.txt (attributes NORMAL): isFile, isDirectory, isSymbolicLink',
    ).toEqual([true, false, false]);
    expect(
      [folder!.isFile(), folder!.isDirectory(), folder!.isSymbolicLink()],
      'sub (attributes DIRECTORY): isFile, isDirectory, isSymbolicLink',
    ).toEqual([false, true, false]);
    expect(
      [junction!.isFile(), junction!.isDirectory(), junction!.isSymbolicLink()],
      'pkg (attributes DIRECTORY | REPARSE_POINT 0x410): isFile, isDirectory, isSymbolicLink',
    ).toEqual([false, false, true]);
  });

  it('types a file that is a reparse point as a link too, so nothing mistakes it for a file', () => {
    const [entry] = listNtDirectory(
      directory([['shortcut', NORMAL | REPARSE_POINT]]),
      7,
      never,
    );

    expect(
      [entry!.isFile(), entry!.isDirectory(), entry!.isSymbolicLink()],
      'shortcut (attributes NORMAL | REPARSE_POINT 0x480): isFile, isDirectory, isSymbolicLink',
    ).toEqual([false, false, true]);
  });

  it('is empty for a directory that holds only . and ..', () => {
    expect(
      listNtDirectory(
        directory([
          ['.', DIRECTORY],
          ['..', DIRECTORY],
        ]),
        7,
        never,
      ),
    ).toEqual([]);
  });

  it('hands any other NT status to the caller to turn into an error', () => {
    const failing: NtQueryDirectory = {
      getOsFHandle: () => ({}),
      NtQueryDirectoryFile: () => 0xc0000022 | 0,
    };

    expect(() => listNtDirectory(failing, 7, never)).toThrow(
      'unexpected NT status 0xc0000022 for <directory>',
    );
  });
});

describe('scanNtDirectory', () => {
  const names = (entries: { name: string }[]) =>
    entries.map((entry) => entry.name);
  const fiveInThreePages = (): [string, number][][] => [
    [
      ['.', DIRECTORY],
      ['a', NORMAL],
      ['b', NORMAL],
    ],
    [
      ['c', NORMAL],
      ['d', DIRECTORY],
    ],
    [['e', NORMAL]],
  ];

  it('stops asking the system for entries once the bound is passed', () => {
    const { api, queries } = paged(fiveInThreePages());

    const listing = scanNtDirectory(api, 7, never, 3);

    expect(
      [listing.exceeded, names(listing.entries)],
      'bound 3 over a, b, c, d, e: [exceeded, entries kept]',
    ).toEqual([true, ['a', 'b', 'c']]);
    expect(
      queries(),
      'NtQueryDirectoryFile calls made before it stopped (the third page is never asked for)',
    ).toBe(2);
  });

  it('returns a directory that exactly fills the bound whole, and says it is not exceeded', () => {
    const { api } = paged(fiveInThreePages());

    const listing = scanNtDirectory(api, 7, never, 5);

    expect([listing.exceeded, names(listing.entries)]).toEqual([
      false,
      ['a', 'b', 'c', 'd', 'e'],
    ]);
  });

  it('types what it keeps the way the whole listing does', () => {
    const { api } = paged(fiveInThreePages());

    const listing = scanNtDirectory(api, 7, never, 4);

    expect(
      listing.entries.map((entry) => [entry.name, entry.isDirectory()]),
    ).toEqual([
      ['a', false],
      ['b', false],
      ['c', false],
      ['d', true],
    ]);
  });

  it('does not count . and .. against the bound', () => {
    const empty = paged([
      [
        ['.', DIRECTORY],
        ['..', DIRECTORY],
      ],
    ]);
    expect(scanNtDirectory(empty.api, 7, never, 0)).toEqual({
      entries: [],
      exceeded: false,
    });
    const one = paged([
      [
        ['.', DIRECTORY],
        ['..', DIRECTORY],
        ['only', NORMAL],
      ],
    ]);
    const listing = scanNtDirectory(one.api, 7, never, 0);
    expect([listing.exceeded, listing.entries]).toEqual([true, []]);
  });

  it('is what listNtDirectory reads when there is no bound', () => {
    expect(
      names(listNtDirectory(paged(fiveInThreePages()).api, 7, never)),
    ).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

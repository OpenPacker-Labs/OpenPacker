/**
 * For an archive the npm adapter materializes (`requireNpmReaderAgreement`),
 * opm refuses what npm's and pnpm's own readers install differently, and
 * installs what both install where they agree. The readers are node-tar 6.2.1
 * (npm) and pnpm 10.28.0's `parseTarball`, recorded over the same bytes in
 * test/tar-oracle/oracle.json by its generate.mjs; paths are compared as
 * installed, the first component stripped. Any other archive keeps the
 * general end rule: two zero blocks, or the end of the data.
 */

import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATERIALIZATION_LIMITS,
  inspectArchive,
  MaterializationError,
  type MaterializationLimits,
} from './index.js';

type Files = Array<[string, string]>;

interface OracleCase {
  name: string;
  bytes: string;
  nodeTar: { entries: Files; warnings: string[] };
  pnpm: { entries?: Files; error?: string };
}

const oracle: { cases: OracleCase[] } = JSON.parse(
  readFileSync(
    new URL('../test/tar-oracle/oracle.json', import.meta.url),
    'utf8',
  ),
);

/** The code opm refuses each case with where npm and pnpm disagree. */
const REFUSED: Record<string, string> = {
  'the end of the data ends it': 'TAR_AMBIGUOUS_END',
  'a lone zero block between entries': 'TAR_AMBIGUOUS_END',
  'lone zero blocks between three entries': 'TAR_AMBIGUOUS_END',
  'a lone zero block before the first entry': 'TAR_AMBIGUOUS_END',
  'a lone zero block, a block that is not a header, then an entry':
    'TAR_AMBIGUOUS_END',
  'a node-tar null block between entries': 'TAR_AMBIGUOUS_END',
  'an 8-digit checksum with no terminator, typeflag 0 after it':
    'TAR_AMBIGUOUS_CHECKSUM',
  'a prefix in a header without ustar magic': 'TAR_AMBIGUOUS_PREFIX',
  'a prefix in a GNU header (magic "ustar  ")': 'TAR_AMBIGUOUS_PREFIX',
  'a header whose name starts with NUL, its path in the prefix':
    'TAR_AMBIGUOUS_END',
  'a directory with a size hides the entries inside it':
    'TAR_AMBIGUOUS_DIRECTORY',
  'a file named like a directory, with a size, hides the entries inside it':
    'TAR_AMBIGUOUS_DIRECTORY',
  'a directory with a size hides a header and leaves a payload that starts with NUL':
    'TAR_AMBIGUOUS_DIRECTORY',
  'a file named like a directory, with no size': 'TAR_AMBIGUOUS_DIRECTORY',
};

const disagree = (item: OracleCase) =>
  !isDeepStrictEqual(item.nodeTar.entries, item.pnpm.entries);

const NPM: MaterializationLimits = {
  ...DEFAULT_MATERIALIZATION_LIMITS,
  requireNpmReaderAgreement: true,
};
const GENERAL = DEFAULT_MATERIALIZATION_LIMITS;
const Z = Buffer.alloc(512);
const bytesOf = (name: string) =>
  new Uint8Array(
    Buffer.from(
      oracle.cases.find((item) => item.name === name)!.bytes,
      'base64',
    ),
  );

/** What opm installs from `bytes`, as the oracle records it, or its refusal. */
async function opm(
  bytes: Uint8Array,
  limits = NPM,
): Promise<Files | { code?: string | undefined }> {
  try {
    return (await inspectArchive(bytes, 'tar', limits))
      .filter(({ type }) => type === 'file')
      .map(({ path, data }) => [
        path.split('/').slice(1).join('/'),
        Buffer.from(data).toString(),
      ]);
  } catch (error) {
    return {
      code: error instanceof MaterializationError ? error.code : undefined,
    };
  }
}

describe('a tar archive npm and pnpm read', () => {
  it('refuses exactly the cases where npm and pnpm disagree', () => {
    expect(oracle.cases.filter(disagree).map(({ name }) => name)).toEqual(
      Object.keys(REFUSED),
    );
  });

  it.each(oracle.cases.map((item) => [item.name, item] as const))(
    '%s',
    async (name, item) => {
      const result = await opm(
        new Uint8Array(Buffer.from(item.bytes, 'base64')),
      );
      expect(result).toEqual(
        disagree(item) ? { code: REFUSED[name] } : item.nodeTar.entries,
      );
    },
  );
});

describe('a tar archive of any other ecosystem', () => {
  it('ends at the end of the data, with no zero block', async () => {
    expect(
      await opm(
        bytesOf('the end of the data ends it'),
        DEFAULT_MATERIALIZATION_LIMITS,
      ),
    ).toEqual([['a.js', 'a']]);
  });

  it('refuses a lone zero block that more data follows: the readers disagree', async () => {
    const general = DEFAULT_MATERIALIZATION_LIMITS;
    for (const name of [
      'a lone zero block between entries',
      'lone zero blocks between three entries',
      'a lone zero block before the first entry',
      'a lone zero block, then a block that is not a header',
    ])
      expect(await opm(bytesOf(name), general), name).toEqual({
        code: 'TAR_AMBIGUOUS_END',
      });
  });

  it('refuses a lone zero block and a partial block that is not zero', async () => {
    const a = bytesOf('the end of the data ends it');
    expect(
      await opm(Buffer.concat([a, Z, Buffer.alloc(100, 0x41)]), GENERAL),
    ).toEqual({ code: 'TAR_AMBIGUOUS_END' });
  });

  it('accepts any length of zero padding after the end marker', async () => {
    const a = bytesOf('the end of the data ends it');
    for (const padding of [
      Buffer.alloc(0),
      Buffer.alloc(100),
      Buffer.alloc(512),
      Buffer.alloc(512 + 100),
      Buffer.alloc(9216),
    ])
      for (const marker of [Z, Buffer.concat([Z, Z])])
        expect(
          await opm(Buffer.concat([a, marker, padding]), GENERAL),
          `${marker.length} + ${padding.length}`,
        ).toEqual([['a.js', 'a']]);
  });

  it("reads a directory's size as before: skipped, not refused", async () => {
    expect(
      await opm(
        bytesOf('a directory with a size hides the entries inside it'),
        GENERAL,
      ),
    ).toEqual([['a.js', 'a']]);
  });

  it('ends at two zero blocks and reads nothing after them', async () => {
    expect(
      await opm(
        bytesOf('nothing after two zero blocks is read'),
        DEFAULT_MATERIALIZATION_LIMITS,
      ),
    ).toEqual([['a.js', 'a']]);
  });

  it('reads its checksum over 8 bytes and its prefix whatever the magic, as before', async () => {
    const general = DEFAULT_MATERIALIZATION_LIMITS;
    expect(
      await opm(
        bytesOf('an 8-digit checksum with no terminator, typeflag 0 after it'),
        general,
      ),
    ).toEqual([
      ['a.js', 'a'],
      ['eight.js', 'e'],
    ]);
    expect(
      await opm(bytesOf('a prefix in a header without ustar magic'), general),
    ).toEqual([
      ['a.js', 'a'],
      ['noprefix.js', 'p'],
    ]);
  });
});

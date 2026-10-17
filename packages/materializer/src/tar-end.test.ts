/**
 * opm refuses a tar archive that npm's and pnpm's own readers install
 * differently, and installs what both install where they agree. The readers
 * are node-tar 6.2.1 (npm) and pnpm 10.28.0's `parseTarball`, recorded over
 * the same bytes in test/tar-oracle/oracle.json by its generate.mjs; paths are
 * compared as installed, the first component stripped.
 */

import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { inspectArchive, MaterializationError } from './index.js';

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
};

const disagree = (item: OracleCase) =>
  !isDeepStrictEqual(item.nodeTar.entries, item.pnpm.entries);

/** What opm installs from `bytes`, as the oracle records it, or its refusal. */
async function opm(
  bytes: Uint8Array,
): Promise<Files | { code?: string | undefined }> {
  try {
    return (await inspectArchive(bytes, 'tar'))
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

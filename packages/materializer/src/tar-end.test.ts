/**
 * Where a tar archive ends, against npm's own reader. node-tar ends an archive
 * at two zero blocks in a row, or at the end of the data; a lone zero block
 * between entries is skipped, and the entries after it are extracted. Stopping
 * at the first zero block, as the materializer did, extracted less than npm
 * does, silently. pnpm's `parseTarball` stops at any block that starts with a
 * zero byte (recorded in the oracle beside node-tar).
 *
 * The oracle is test/tar-oracle/oracle.json, written by its generate.mjs from
 * node-tar 6.2.1 and pnpm 10.28.0 over the bytes it holds.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MATERIALIZATION_LIMITS,
  inspectArchive,
  type MaterializationLimits,
} from './index.js';

interface OracleCase {
  name: string;
  bytes: string;
  nodeTar: { entries: Array<[string, string]>; warnings: string[] };
}

const oracle: { cases: OracleCase[] } = JSON.parse(
  readFileSync(
    new URL('../test/tar-oracle/oracle.json', import.meta.url),
    'utf8',
  ),
);

/** Where node-tar skips a block that is not a header (with a warning), opm refuses. */
const REFUSED = new Set([
  'a lone zero block, then a block that is not a header',
  'a lone zero block, a block that is not a header, then an entry',
]);

const read = async (bytes: Uint8Array, limits?: MaterializationLimits) =>
  (await inspectArchive(bytes, 'tar', limits))
    .filter(({ type }) => type === 'file')
    .map(({ path, data }) => [path, Buffer.from(data).toString()]);

describe('the end of a tar archive', () => {
  it.each(oracle.cases.map((item) => [item.name, item] as const))(
    '%s',
    async (name, item) => {
      const bytes = new Uint8Array(Buffer.from(item.bytes, 'base64'));
      if (REFUSED.has(name)) {
        expect(item.nodeTar.warnings).toContain('TAR_ENTRY_INVALID');
        await expect(inspectArchive(bytes, 'tar')).rejects.toMatchObject({
          // Its checksum field is not a number: it is not a header.
          code: 'INVALID_TAR_NUMBER',
        });
      } else expect(await read(bytes)).toEqual(item.nodeTar.entries);
    },
  );

  it('counts an entry after a lone zero block toward the file limit', async () => {
    const item = oracle.cases.find(
      ({ name }) => name === 'a lone zero block between entries',
    )!;
    const bytes = new Uint8Array(Buffer.from(item.bytes, 'base64'));
    await expect(
      inspectArchive(bytes, 'tar', {
        ...DEFAULT_MATERIALIZATION_LIMITS,
        maximumFiles: 1,
      }),
    ).rejects.toMatchObject({ code: 'FILE_COUNT_LIMIT' });
  });
});

/**
 * For an archive the npm adapter materializes (`requireNpmReaderAgreement`),
 * opm refuses the archives the readers read differently and installs what they
 * read alike, with two stated exceptions: OVER_REFUSED (they agree and opm
 * refuses) and PINNED (they agree and opm lays it out differently). The readers
 * are node-tar 6.2.1 (npm 10.9.4's) and 7.5.22 (npm 11's), each as `Parse` fed
 * whole and in pieces and as `tar.x` with pacote's filter, and pnpm 10.28.0's
 * `parseTarball`, recorded over the same bytes in test/tar-oracle/oracle.json
 * by its generate.mjs; a reading is the files installed, the first path
 * component stripped, and which of them have an execute bit. Any other archive
 * keeps the general end rule: two zero blocks, or the end of the data, and a
 * lone zero block with data after it refused. What the expectations are, case
 * by case, is in tar-end.expect.ts.
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
import { OVER_REFUSED, PACOTE, PINNED, REFUSED } from './tar-end.expect.js';

type Files = Array<[string, string]>;

/** What a reader installed: the files, and the paths with an execute bit. */
interface Reading {
  entries: Files;
  executable: string[];
}

interface OracleCase {
  name: string;
  bytes: string;
  /** node-tar 6.2.1's `Parse`, fed whole. */
  nodeTar: Reading;
  /** node-tar's reading for each piece size it reads differently from one buffer. */
  fed: Record<string, Reading>;
  nodeTar7: Reading;
  fed7: Record<string, Reading>;
  pnpm: Partial<Reading> & { error?: string };
  /** `tar.x` with pacote's filter, or how it failed. */
  pacote: Partial<Reading> & { error?: string };
  pacote7: Partial<Reading> & { error?: string };
}

const oracle: { cases: OracleCase[] } = JSON.parse(
  readFileSync(
    new URL('../test/tar-oracle/oracle.json', import.meta.url),
    'utf8',
  ),
);

/** On disk a later entry replaces an earlier one at its path, and a path that ends in a slash is written without it. */
const written = (files: Files) =>
  [
    ...new Map(
      files.map(([path, text]): [string, string] => [
        path.replace(/\/$/u, ''),
        text,
      ]),
    ),
  ].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

/**
 * `tar.x` wrote something other than `Parse` reads (its ignore-file renames
 * aside, `PACOTE`), or failed: the reader npm runs is not the one the rest of
 * the oracle reads.
 */
const extractDiffers = (
  item: OracleCase,
  extracted: OracleCase['pacote'],
  parsed: Reading,
) =>
  extracted.error !== undefined ||
  !isDeepStrictEqual(
    written(extracted.entries ?? []),
    written(PACOTE[item.name] ?? parsed.entries),
  ) ||
  !isDeepStrictEqual(extracted.executable, parsed.executable);

/** Every reading of node-tar (both lines, whole and in pieces, and `tar.x`) is pnpm's. */
const disagree = (item: OracleCase) =>
  [
    item.nodeTar,
    ...Object.values(item.fed),
    item.nodeTar7,
    ...Object.values(item.fed7),
  ].some(
    (reading) =>
      !isDeepStrictEqual(reading.entries, item.pnpm.entries) ||
      !isDeepStrictEqual(reading.executable, item.pnpm.executable),
  ) ||
  extractDiffers(item, item.pacote, item.nodeTar) ||
  extractDiffers(item, item.pacote7, item.nodeTar7);

const NPM: MaterializationLimits = {
  ...DEFAULT_MATERIALIZATION_LIMITS,
  acceptRedundantEntries: true,
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
async function opmReading(
  bytes: Uint8Array,
  limits = NPM,
): Promise<Reading | { code?: string | undefined }> {
  try {
    const files = (await inspectArchive(bytes, 'tar', limits)).filter(
      ({ type }) => type === 'file',
    );
    return {
      entries: files.map(({ path, data }) => [
        path.split('/').slice(1).join('/'),
        Buffer.from(data).toString(),
      ]),
      executable: files
        .filter(({ mode }) => ((mode ?? 0) & 0o111) !== 0)
        .map(({ path }) => path.split('/').slice(1).join('/'))
        .sort(),
    };
  } catch (error) {
    return {
      code: error instanceof MaterializationError ? error.code : undefined,
    };
  }
}

/** The files only, for the tests of the general rule. */
async function opm(
  bytes: Uint8Array,
  limits = NPM,
): Promise<Files | { code?: string | undefined }> {
  const reading = await opmReading(bytes, limits);
  return 'entries' in reading ? reading.entries : reading;
}

describe('a tar archive npm and pnpm read', () => {
  it('refuses the archives the readers read differently, in the order of the oracle', () => {
    expect(oracle.cases.filter(disagree).map(({ name }) => name)).toEqual(
      Object.keys(REFUSED),
    );
  });

  it('refuses no other archive where they agree than the ones it lists', () => {
    expect(
      oracle.cases
        .filter((item) => !disagree(item) && item.name in OVER_REFUSED)
        .map(({ name }) => name),
    ).toEqual(Object.keys(OVER_REFUSED));
  });

  it('pins only differences it can state', () => {
    for (const name of Object.keys(PINNED)) {
      const item = oracle.cases.find((found) => found.name === name)!;
      expect(disagree(item), name).toBe(false);
      expect(PINNED[name], name).not.toEqual(item.nodeTar.entries);
    }
  });

  it('lists the ignore files pacote renames only where tar.x writes them renamed', () => {
    for (const name of Object.keys(PACOTE)) {
      const item = oracle.cases.find((found) => found.name === name)!;
      expect(item.pacote.error, name).toBeUndefined();
      expect(written(item.pacote.entries ?? []), name).toEqual(
        written(PACOTE[name]!),
      );
      expect(written(PACOTE[name]!), name).not.toEqual(
        written(item.nodeTar.entries),
      );
    }
  });

  it.each(oracle.cases.map((item) => [item.name, item] as const))(
    '%s',
    async (name, item) => {
      const result = await opmReading(
        new Uint8Array(Buffer.from(item.bytes, 'base64')),
      );
      if (disagree(item)) {
        expect(result).toEqual({ code: REFUSED[name] });
      } else if (OVER_REFUSED[name] !== undefined) {
        expect(result).toEqual({ code: OVER_REFUSED[name] });
      } else {
        // The files node-tar reads (or the layout difference pinned), and its execute bits.
        expect(result).toEqual({
          entries: PINNED[name] ?? item.nodeTar.entries,
          executable: item.nodeTar.executable,
        });
      }
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

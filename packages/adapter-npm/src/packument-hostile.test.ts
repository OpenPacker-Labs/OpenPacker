import { describe, expect, it } from 'vitest';
import {
  FixtureHttpTransport,
  MetadataLimitError,
} from '@openpacker/adapter-core';
import { NpmRegistryProvider } from './index.js';
import {
  MAXIMUM_PACKUMENT_BYTES,
  PACKUMENT_LIMITS,
} from './packument-limits.js';

/**
 * The bound on a packument is 64 MiB, and a document of that many bytes can
 * hold far more values than any real one: `{},` is three bytes and an object,
 * `1,` two bytes and a number. A registry that sends the densest body the byte
 * bound allows must be refused when the parser reaches the value limit, not
 * after it has built every value in the body.
 *
 * Measured on the unfixed build (value limit checked after the parse), the
 * first body below took 50 s and 7.4 GB of RSS and the second 14 s and 2.6 GB
 * before being refused; the figures are in ADR 0044. What these tests hold is
 * that the parser stops: `visited` is the limit plus the one value it refused,
 * and `offset` is how much of the body it had read. Neither depends on how
 * busy the machine is.
 */

const ENDPOINT = 'https://registry.test';

/**
 * A packument of exactly `bytes` bytes whose `pad` member is `piece` repeated,
 * ending in `last`; whitespace takes up what the pieces do not divide evenly.
 */
function hostile(piece: string, last: string, bytes: number): Uint8Array {
  const prefix = '{"name":"hostile","dist-tags":{},"versions":{},"pad":[';
  const suffix = ']}';
  const fixed = prefix.length + last.length + suffix.length;
  const count = Math.floor((bytes - fixed) / piece.length);
  const slack = bytes - fixed - count * piece.length;
  return Buffer.from(
    prefix + piece.repeat(count) + last + ' '.repeat(slack) + suffix,
    'latin1',
  );
}

function providerFor(body: Uint8Array) {
  const transport = new FixtureHttpTransport(
    new Map([[`${ENDPOINT}/hostile`, { status: 200, headers: {}, body }]]),
  );
  return new NpmRegistryProvider(
    transport,
    { now: () => '2026-10-12T00:00:00Z' },
    ENDPOINT,
  );
}

describe(
  'a packument of the largest size, as dense as a document can be',
  { timeout: 120_000 },
  () => {
    it.each([
      ['empty objects, three bytes a value', '{},', '{}'],
      ['numbers, two bytes a value', '1,', '1'],
    ])('is refused at the value limit: %s', async (_, piece, last) => {
      const body = hostile(piece, last, MAXIMUM_PACKUMENT_BYTES);
      expect(body.length).toBe(MAXIMUM_PACKUMENT_BYTES);
      const error = await providerFor(body)
        .enumerate('pkg:npm/hostile')
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MetadataLimitError);
      const refusal = error as MetadataLimitError;
      const limit = PACKUMENT_LIMITS.maximumNodes!;
      expect(limit).toBe(4_194_304);
      expect(refusal).toMatchObject({
        code: 'INVALID_PROVIDER_METADATA',
        message: `The packument of hostile is not usable: Provider metadata exceeds ${limit} values`,
        limit: 'values',
        maximum: limit,
        documentLength: MAXIMUM_PACKUMENT_BYTES,
        // The limit's worth of values, and the one it refused.
        visited: limit + 1,
      });
      // Read a fraction of the body: the rest was never parsed.
      expect(refusal.offset).toBeLessThan(MAXIMUM_PACKUMENT_BYTES / 4);
    });
  },
);

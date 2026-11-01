import { describe, expect, it } from 'vitest';
import {
  FixtureHttpTransport,
  MetadataLimitError,
} from '@openpacker/adapter-core';
import { NpmRegistryProvider } from './index.js';
import { PARSE_COSTS } from '@openpacker/canonical';
import {
  MAXIMUM_PACKUMENT_BYTES,
  PACKUMENT_LIMITS,
} from './packument-limits.js';

/**
 * The bound on a packument is 64 MiB, and a document of that many bytes can
 * hold far more than any real one: `{},` is three bytes and an object that
 * takes about 200 to build, `1,` two bytes and a slot. A registry that sends
 * the densest body the byte bound allows must be refused when the parser
 * reaches the cost limit, not after it has built every part of the body.
 *
 * Measured on the build that counted values (4,194,304 of them, after the byte
 * bound), the first body below took 2.0 to 4.4 s and 1.1 GB before it was
 * refused, and a body of 3.7 million members, each an empty object, was
 * accepted and cost 2.1 to 2.6 GB; the figures are in ADR 0044. What these
 * tests hold is that the parser stops: `spent` is the limit plus the part it
 * refused, and `offset` is how much of the body it had read. Neither depends on
 * how busy the machine is.
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

/** The most one part of a tree can cost, and so the most a refusal can pass the limit by. */
const LARGEST_CHARGE =
  PARSE_COSTS.peak.element +
  PARSE_COSTS.peak.firstElement +
  PARSE_COSTS.peak.object;

/** Members of one object cost `bigMember` more past this many; 18 bytes each is the 12-character name. */
const members = (index: number) => `"${String(index).padStart(12, '0')}":{},`;

describe(
  'a packument of the largest size, as dense as a document can be',
  { timeout: 120_000 },
  () => {
    it.each([
      ['empty objects, three bytes a value', '{},', '{}', 6_000_000],
      ['numbers, two bytes a value', '1,', '1', 30_000_000],
    ])('is refused at the cost limit: %s', async (_, piece, last, readBy) => {
      const body = hostile(piece, last, MAXIMUM_PACKUMENT_BYTES);
      expect(body.length).toBe(MAXIMUM_PACKUMENT_BYTES);
      const error = await providerFor(body)
        .enumerate('pkg:npm/hostile')
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MetadataLimitError);
      const refusal = error as MetadataLimitError;
      const limit = PACKUMENT_LIMITS.maximumCost!;
      expect(limit).toBe(512 * 1024 * 1024);
      expect(refusal).toMatchObject({
        code: 'INVALID_PROVIDER_METADATA',
        message: `The packument of hostile is not usable: Provider metadata exceeds ${limit} bytes of parsed size`,
        limit: 'cost',
        maximum: limit,
        documentLength: MAXIMUM_PACKUMENT_BYTES,
      });
      // The limit's worth of tree, and the one part it refused.
      expect(refusal.spent).toBeGreaterThan(limit);
      expect(refusal.spent).toBeLessThanOrEqual(limit + LARGEST_CHARGE);
      // Read a part of the body: the rest was never parsed.
      expect(refusal.offset).toBeLessThan(readBy);
      expect(refusal.offset).toBeLessThan(MAXIMUM_PACKUMENT_BYTES / 2);
    });

    it('is refused when it is one object of members, each an empty object, which used to be accepted', async () => {
      // 18 bytes a member, 3.7 million of them: 4,194,304 values at most, so
      // the value limit let it through and it cost 2.1 to 2.6 GB.
      const prefix = '{"name":"hostile","dist-tags":{},"versions":{},"x":{';
      const parts: string[] = [];
      let bytes = prefix.length;
      for (
        let index = 0;
        bytes + 18 + 8 < MAXIMUM_PACKUMENT_BYTES;
        index += 1
      ) {
        parts.push(members(index));
        bytes += 18;
      }
      const text = `${prefix}${parts.join('')}"x":{}}}`;
      const body = Buffer.from(
        text + ' '.repeat(MAXIMUM_PACKUMENT_BYTES - text.length),
        'latin1',
      );
      expect(body.length).toBe(MAXIMUM_PACKUMENT_BYTES);
      const error = await providerFor(body)
        .enumerate('pkg:npm/hostile')
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MetadataLimitError);
      const refusal = error as MetadataLimitError;
      expect(refusal).toMatchObject({
        limit: 'cost',
        maximum: PACKUMENT_LIMITS.maximumCost,
      });
      // Each member costs 60, 400 more past the 4,096th, 42 for its name and
      // 240 for its object: about 0.7 million of them fit, not 3.7 million.
      expect(refusal.visited).toBeLessThan(1_000_000);
      expect(refusal.offset).toBeLessThan(MAXIMUM_PACKUMENT_BYTES / 4);
    });
  },
);

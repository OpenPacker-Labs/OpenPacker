import { describe, expect, it } from 'vitest';
import {
  FixtureHttpTransport,
  ProviderError,
  ResponseTooLargeError,
} from '@openpacker/adapter-core';
import { NpmRegistryProvider } from './index.js';
import {
  FULL_PACKUMENT_LIMITS,
  FULL_PACKUMENT_PARSE_COST,
  MAXIMUM_FULL_PACKUMENT_BYTES,
  MAXIMUM_PACKUMENT_BYTES,
  PACKUMENT_LIMITS,
  PACKUMENT_PARSE_COST,
  aboutPackument,
} from './packument-limits.js';

/**
 * `typescript` is 8.7 MB abbreviated and 260,520 values; `next` is 25.6 MB and
 * 846,076. The first bound was 8 MiB and 200,000 values, which refused both.
 * These documents are synthetic (a version and a padding member), but they have
 * the sizes of the real ones, which is what the bound looks at.
 */

const encoder = new TextEncoder();
const ENDPOINT = 'https://registry.test';
const MiB = 1024 * 1024;

const head = (name: string) => ({
  name,
  'dist-tags': { latest: '1.0.0' },
  modified: '2026-01-01T00:00:00.000Z',
  versions: {
    '1.0.0': {
      name,
      version: '1.0.0',
      dist: { tarball: `${ENDPOINT}/${name}/-/x-1.0.0.tgz` },
    },
  },
});

/** A packument of exactly `bytes` bytes, the rest a string no parser minds. */
function ofBytes(name: string, bytes: number): Uint8Array {
  const bare = encoder.encode(JSON.stringify({ ...head(name), pad: '' }));
  return encoder.encode(
    JSON.stringify({ ...head(name), pad: 'x'.repeat(bytes - bare.length) }),
  );
}

/** A packument of exactly `bytes` bytes holding at least `values` values. */
function holding(name: string, bytes: number, values: number): Uint8Array {
  const empties = Array.from({ length: values }, () => []);
  const make = (fill: number) =>
    encoder.encode(
      JSON.stringify({ ...head(name), empties, pad: 'x'.repeat(fill) }),
    );
  return make(bytes - make(0).length);
}

function providerFor(name: string, body: Uint8Array) {
  const transport = new FixtureHttpTransport(
    new Map([
      [
        `${ENDPOINT}/${encodeURIComponent(name)}`,
        { status: 200, headers: { etag: '"one"' }, body },
      ],
    ]),
  );
  const provider = new NpmRegistryProvider(
    transport,
    { now: () => '2026-10-12T00:00:00Z' },
    ENDPOINT,
  );
  return { provider, transport };
}

describe('the packument bound', { timeout: 30_000 }, () => {
  it('is set above the largest abbreviated packument found, with room', () => {
    // public-unscoped-test-package, 38,335,911 bytes on 2026-10-12; next is
    // 25,636,598 and @prisma/client 38,178,921.
    expect(MAXIMUM_PACKUMENT_BYTES).toBeGreaterThanOrEqual(1.5 * 38_335_911);
    // Never more bytes of the client's memory than a tarball may take.
    expect(MAXIMUM_PACKUMENT_BYTES).toBeLessThan(128 * MiB);
    expect(MAXIMUM_FULL_PACKUMENT_BYTES).toBeGreaterThan(
      MAXIMUM_PACKUMENT_BYTES,
    );
  });

  it('is set above the largest full packument found, which is over 64 MiB', () => {
    // @wix/wix-code-types, 76,503,820 bytes; @prisma/client, 68,527,188. Both
    // are over 64 MiB, so the full bound cannot be the abbreviated one.
    expect(MAXIMUM_FULL_PACKUMENT_BYTES).toBeGreaterThanOrEqual(
      1.25 * 76_503_820,
    );
  });

  it('limits what a parsed packument may cost, not how many values it holds', () => {
    // The cost of a tree follows what it allocates (ADR 0044); a count of
    // values is not applied to a packument, which would let `{},` and `1,`
    // through at four million of them.
    expect(PACKUMENT_LIMITS.maximumNodes).toBeUndefined();
    expect(FULL_PACKUMENT_LIMITS.maximumNodes).toBeUndefined();
    expect(PACKUMENT_LIMITS.maximumCost).toBe(PACKUMENT_PARSE_COST);
    expect(FULL_PACKUMENT_LIMITS.maximumCost).toBe(FULL_PACKUMENT_PARSE_COST);
    expect(PACKUMENT_PARSE_COST).toBe(512 * MiB);
    expect(FULL_PACKUMENT_PARSE_COST).toBe(720 * MiB);
    // The full document may cost more: it is several times the size.
    expect(FULL_PACKUMENT_PARSE_COST).toBeGreaterThan(PACKUMENT_PARSE_COST);
  });

  it.each([
    ['typescript', 8_728_082, 260_520],
    ['gatsby', 15_734_819, 512_428],
    ['next', 25_636_598, 846_076],
  ])('reads %s, %i bytes and %i values', async (name, bytes, values) => {
    const body = holding(name, bytes, values);
    expect(body.length).toBe(bytes);
    const { provider, transport } = providerFor(name, body);
    expect(await provider.enumerate(`pkg:npm/${name}`)).toEqual([
      `pkg:npm/${name}@1.0.0`,
    ]);
    expect(transport.requests[0]?.maximumBytes).toBe(MAXIMUM_PACKUMENT_BYTES);
  });

  it('reads a packument of 260,520 values that is a megabyte, which is values and not bytes', async () => {
    // Under 8 MiB, and still refused for holding more than 200,000 values.
    const body = holding('dense', MiB, 260_520);
    const { provider } = providerFor('dense', body);
    expect(await provider.enumerate('pkg:npm/dense')).toHaveLength(1);
  });

  it('reads a packument of one byte under the bound', async () => {
    const { provider } = providerFor(
      'large',
      ofBytes('large', MAXIMUM_PACKUMENT_BYTES - 1),
    );
    expect(await provider.enumerate('pkg:npm/large')).toHaveLength(1);
  });

  it('reads one of exactly the bound', async () => {
    const { provider } = providerFor(
      'exact',
      ofBytes('exact', MAXIMUM_PACKUMENT_BYTES),
    );
    expect(await provider.enumerate('pkg:npm/exact')).toHaveLength(1);
  });

  it('refuses one a byte over, naming the package, the size seen and the limit', async () => {
    const { provider } = providerFor(
      '@scope/huge',
      ofBytes('@scope/huge', MAXIMUM_PACKUMENT_BYTES + 1),
    );
    const error = await provider
      .enumerate('pkg:npm/%40scope/huge')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResponseTooLargeError);
    expect(error).toMatchObject({
      code: 'UPSTREAM_RESPONSE_TOO_LARGE',
      limitBytes: MAXIMUM_PACKUMENT_BYTES,
      observedBytes: MAXIMUM_PACKUMENT_BYTES + 1,
    });
    expect((error as Error).message).toBe(
      'The packument of @scope/huge is 67108865 bytes (64.00 MiB) and exceeds the ' +
        'limit of 67108864 bytes (64.00 MiB)',
    );
  });
});

describe('a packument that is not text', () => {
  it('is refused in terms of the package, as a document the parser could not use', async () => {
    const { provider } = providerFor(
      'binary',
      Uint8Array.of(0x5b, 0x22, 0xff, 0xfe, 0x22, 0x5d),
    );
    const error = await provider
      .enumerate('pkg:npm/binary')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      code: 'INVALID_PROVIDER_METADATA',
      message:
        'The packument of binary is not usable: The encoded data was not valid for encoding utf-8',
    });
  });
});

describe('a refusal is said in terms of the package', () => {
  it('renames a size refusal and leaves its numbers', () => {
    const renamed = aboutPackument(
      'vite',
      new ResponseTooLargeError(100, 250, 'streamed', 200),
    );
    expect(renamed).toBeInstanceOf(ResponseTooLargeError);
    expect((renamed as Error).message).toBe(
      'The packument of vite exceeds the limit of 100 bytes (0.00 MiB): ' +
        'stopped reading at 250 bytes (0.00 MiB)',
    );
  });

  it('names the package in a document the parser refused', () => {
    const renamed = aboutPackument(
      'vite',
      new ProviderError(
        'INVALID_PROVIDER_METADATA',
        'Provider metadata exceeds 536870912 bytes of parsed size',
      ),
    );
    expect(renamed).toMatchObject({
      code: 'INVALID_PROVIDER_METADATA',
      message:
        'The packument of vite is not usable: Provider metadata exceeds 536870912 bytes of parsed size',
    });
  });

  it('says a package name from a registry as plain text', () => {
    // A dependency's name comes out of a registry's document.
    const renamed = aboutPackument(
      'ev\u001b]0;pwned\u0007\u001b[31mil\nname',
      new ResponseTooLargeError(100, 250, 'streamed', 200),
    );
    expect((renamed as Error).message).toBe(
      'The packument of evilname exceeds the limit of 100 bytes (0.00 MiB): ' +
        'stopped reading at 250 bytes (0.00 MiB)',
    );
    expect(
      aboutPackument(
        '@scope/' + 'n'.repeat(300),
        new ProviderError('INVALID_PROVIDER_METADATA', 'x'),
      ).message.length,
    ).toBeLessThan(300);
  });

  it('leaves any other refusal as it came', () => {
    const offline = new ProviderError('OFFLINE', 'offline');
    expect(aboutPackument('vite', offline)).toBe(offline);
  });
});

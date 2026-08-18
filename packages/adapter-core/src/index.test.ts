import { describe, expect, it } from 'vitest';
import {
  assertBoundedProviderMetadata,
  compareParsedVersions,
  compareCodePoints,
  BoundedFetchTransport,
  evaluateRange,
  evaluateSemverRange,
  FixtureHttpTransport,
  formatPurl,
  header,
  isEcosystem,
  parsePurl,
  parseSemver,
  parseSemverRange,
  parseVers,
  packageNodeId,
  providerErrorForStatus,
  rangeToConstraint,
  renderRange,
  semanticLoss,
  sourceRef,
  text,
  verifyNativeDigest,
  json,
} from './index.js';

describe('PURL codec primitives', () => {
  it('canonicalizes encoding and qualifier order without losing identity', () => {
    const parsed = parsePurl(
      'pkg:NPM/%40OpenPacker/Demo@1.0.0?B=two&a=one#bin/tool',
    );
    expect(
      formatPurl({
        ...parsed,
        type: 'npm',
        ...(parsed.namespace === undefined
          ? {}
          : { namespace: parsed.namespace.toLowerCase() }),
        name: parsed.name.toLowerCase(),
      }),
    ).toBe('pkg:npm/%40openpacker/demo@1.0.0?a=one&b=two#bin/tool');
  });

  it('rejects duplicate qualifiers after case normalization', () => {
    expect(() => parsePurl('pkg:npm/demo?a=1&A=2')).toThrow(
      /Duplicate qualifier/,
    );
  });
});

describe('version primitives', () => {
  const compare = (left: string, right: string) =>
    compareParsedVersions(parseSemver(left), parseSemver(right));

  it('orders prereleases before stable versions', () => {
    expect(compare('1.0.0-beta.2', '1.0.0-beta.11')).toBeLessThan(0);
    expect(compare('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
  });

  it('evaluates explicit conjunctions', () => {
    const ast = {
      type: 'and' as const,
      items: [
        {
          type: 'comparison' as const,
          operator: '>=' as const,
          version: '1.0.0',
        },
        {
          type: 'comparison' as const,
          operator: '<' as const,
          version: '2.0.0',
        },
      ],
    };
    expect(evaluateRange('1.5.0', ast, compare)).toBe(true);
    expect(evaluateRange('2.0.0', ast, compare)).toBe(false);
  });

  it('parses and canonically serializes VERS expressions', () => {
    const parsed = parseVers('  vers:npm/>=1.0.0 | <2.0.0 || =3.0.0  ');
    expect(parsed.vers).toBe('vers:npm/>=1.0.0|<2.0.0||=3.0.0');
    expect(parseVers(parsed.vers!).vers).toBe(parsed.vers);
    expect(() => parseVers('vers:npm/>=1||')).toThrow(/Invalid VERS clause/);
  });

  it('covers native range forms and their portable constraint mapping', async () => {
    expect(isEcosystem('npm')).toBe(true);
    expect(isEcosystem('NPM')).toBe(false);
    expect(compareCodePoints('a', 'b')).toBeLessThan(0);
    const compareNative = (left: string, right: string) =>
      compareParsedVersions(parseSemver(left), parseSemver(right));
    const caret = parseSemverRange('^1.2.3', {
      scheme: 'npm',
      bare: 'caret',
      commaAnd: true,
      hyphenRanges: true,
    });
    expect(renderRange(caret.ast)).toBe('>=1.2.3 <2.0.0');
    expect(evaluateSemverRange('1.9.0', caret.ast, compareNative)).toBe(true);
    expect(rangeToConstraint(caret)).toMatchObject({
      reversible: false,
      semanticLoss: [{ code: 'NATIVE_RANGE_NOT_EXACTLY_REPRESENTABLE' }],
    });
    expect(
      parseSemverRange('1.2 - 1.4', {
        scheme: 'npm',
        bare: 'caret',
        hyphenRanges: true,
      }).normalized,
    ).toBe('>=1.2.0 <1.5.0');
    const prerelease = parseSemverRange('>=1.0.0-beta.1 <2.0.0', {
      scheme: 'npm',
      bare: 'caret',
    });
    expect(
      evaluateSemverRange('1.0.0-beta.2', prerelease.ast, compareNative),
    ).toBe(true);
    expect(semanticLoss('npm', 'LOSS', '/range', 'native').severity).toBe(
      'warning',
    );

    expect(providerErrorForStatus(404).code).toBe('PACKAGE_NOT_FOUND');
    expect(providerErrorForStatus(429).code).toBe('RATE_LIMITED');
    expect(providerErrorForStatus(500).code).toBe('UPSTREAM_UNAVAILABLE');
    const response = {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: new TextEncoder().encode('hello'),
      url: 'https://fixture.test',
    };
    expect(text(response)).toBe('hello');
    expect(header(response, 'content-type')).toBe('text/plain');
    expect(() => assertBoundedProviderMetadata({ a: { b: 1 } })).not.toThrow();
    expect(() => assertBoundedProviderMetadata({ a: { b: 1 } }, 1)).toThrow(
      /depth/u,
    );
    expect(
      await verifyNativeDigest(
        new TextEncoder().encode('abc'),
        'sha256',
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      ),
    ).toBe(true);
    expect(sourceRef('npm', 'https://registry.test').type).toBe('registry');
    expect(await packageNodeId({ exactPurl: 'pkg:npm/demo@1.0.0' })).toMatch(
      /^sha256:/u,
    );
  });
});

it('fixture transport is bounded and never performs network access', async () => {
  const transport = new FixtureHttpTransport(
    new Map([
      [
        'https://fixture.test/data',
        { status: 200, headers: {}, body: new Uint8Array([1, 2]) },
      ],
    ]),
  );
  await expect(
    transport.request({ url: 'https://fixture.test/data', maximumBytes: 1 }),
  ).rejects.toThrow(/exceeds/);
  expect(transport.requests).toHaveLength(1);
});

it('bounds redirects and retries while stripping cross-origin credentials', async () => {
  const calls: { url: string; headers: Headers }[] = [];
  const responses = [
    new Response(null, {
      status: 302,
      headers: { location: 'https://mirror.test/data' },
    }),
    new Response(null, { status: 503, headers: { 'retry-after': '0' } }),
    new Response('ok', { status: 200 }),
  ];
  const transport = new BoundedFetchTransport({
    allowedOrigins: ['https://registry.test', 'https://mirror.test'],
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return responses.shift()!;
    }) as typeof fetch,
    delay: async () => undefined,
  });
  const response = await transport.request({
    url: 'https://registry.test/data',
    headers: { authorization: 'Bearer secret', 'x-api-key': 'secret' },
  });
  expect(new TextDecoder().decode(response.body)).toBe('ok');
  expect(calls).toHaveLength(3);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer secret');
  expect(calls[1]!.headers.has('authorization')).toBe(false);
  expect(calls[1]!.headers.has('x-api-key')).toBe(false);
});

it('maps status, corruption, limits, and cancellation to stable failures', async () => {
  const notFound = new BoundedFetchTransport({
    allowedOrigins: ['https://fixture.test'],
    fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
  });
  await expect(
    notFound.request({ url: 'https://fixture.test/missing' }),
  ).rejects.toMatchObject({
    code: 'PACKAGE_NOT_FOUND',
    upstreamStatus: 404,
  });

  const oversized = new BoundedFetchTransport({
    allowedOrigins: ['https://fixture.test'],
    maximumBytes: 2,
    fetch: (async () => new Response('abc', { status: 200 })) as typeof fetch,
  });
  await expect(
    oversized.request({ url: 'https://fixture.test/large' }),
  ).rejects.toMatchObject({
    code: 'UPSTREAM_RESPONSE_TOO_LARGE',
  });

  expect(() =>
    json({
      status: 200,
      headers: {},
      body: new TextEncoder().encode('{broken'),
      url: 'https://fixture.test/broken',
    }),
  ).toThrowError(
    expect.objectContaining({ code: 'INVALID_PROVIDER_METADATA' }),
  );

  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await expect(
    oversized.request({
      url: 'https://fixture.test/cancelled',
      signal: controller.signal,
    }),
  ).rejects.toThrow('cancelled');
});

it('rejects unlisted initial and redirect origins before fetching them', async () => {
  const calls: string[] = [];
  const transport = new BoundedFetchTransport({
    allowedOrigins: ['https://registry.test'],
    fetch: (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/internal' },
      });
    }) as typeof fetch,
  });
  await expect(transport.request({ url: 'not a URL' })).rejects.toMatchObject({
    code: 'INVALID_PROVIDER_ENDPOINT',
  });
  await expect(
    transport.request({ url: 'http://127.0.0.1/internal' }),
  ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
  expect(calls).toEqual([]);
  await expect(
    transport.request({ url: 'https://registry.test/data' }),
  ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
  expect(calls).toEqual(['https://registry.test/data']);
});

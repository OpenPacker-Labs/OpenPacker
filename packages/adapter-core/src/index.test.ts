import { describe, expect, it } from 'vitest';
import {
  assertBoundedProviderMetadata,
  assertPackageIdentityMatchesRequest,
  compareParsedVersions,
  compareCodePoints,
  BoundedFetchTransport,
  evaluateRange,
  evaluateSemverRange,
  FixtureHttpTransport,
  formatPurl,
  header,
  isEcosystem,
  isPrivateAddress,
  normalizePinnedOrigin,
  parsePurl,
  parseSemver,
  parseSemverRange,
  parseVers,
  packageNodeId,
  providerErrorForStatus,
  redactUrl,
  type ProviderExecutable,
  type ProviderInspection,
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

  it('rejects provider identity substitution', () => {
    expect(() =>
      assertPackageIdentityMatchesRequest('pkg:npm/demo@1.0.0', {
        exactPurl: 'pkg:npm/other@1.0.0',
      }),
    ).toThrow(/does not match/u);
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
    headers: {
      accept: 'application/json',
      authorization: 'Bearer secret',
      'x-api-key': 'secret',
      'x-vendor-token': 'secret',
    },
  });
  expect(new TextDecoder().decode(response.body)).toBe('ok');
  expect(calls).toHaveLength(3);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer secret');
  expect(calls[1]!.headers.has('authorization')).toBe(false);
  expect(calls[1]!.headers.has('x-api-key')).toBe(false);
  expect(calls[1]!.headers.has('x-vendor-token')).toBe(false);
  expect(calls[1]!.headers.get('accept')).toBe('application/json');
});

it('enforces an intrinsic provider deadline through body consumption', async () => {
  const transport = new BoundedFetchTransport({
    allowedOrigins: ['https://fixture.test'],
    timeoutMilliseconds: 10,
    fetch: (async () =>
      new Response(
        new ReadableStream({ start: () => undefined }),
      )) as typeof fetch,
  });
  await expect(
    transport.request({ url: 'https://fixture.test/stalled' }),
  ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
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
  expect(() =>
    json({
      status: 200,
      headers: {},
      body: new TextEncoder().encode('{"version":"1","version":"2"}'),
      url: 'https://fixture.test/duplicate',
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

it('allows only credential-free loopback HTTP provider traffic', async () => {
  expect(
    () =>
      new BoundedFetchTransport({
        allowedOrigins: ['http://registry.example'],
      }),
  ).toThrowError(
    expect.objectContaining({ code: 'INVALID_PROVIDER_ENDPOINT' }),
  );

  const calls: string[] = [];
  const transport = new BoundedFetchTransport({
    allowedOrigins: ['http://127.0.0.1:7337'],
    fetch: (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('ok');
    }) as typeof fetch,
  });
  await expect(
    transport.request({
      url: 'http://127.0.0.1:7337/data',
      headers: { authorization: 'Bearer secret' },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
  expect(calls).toEqual([]);
});

it('preserves HEAD across a 303 serviceability redirect', async () => {
  const methods: string[] = [];
  const transport = new BoundedFetchTransport({
    allowedOrigins: ['https://registry.test'],
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      return methods.length === 1
        ? new Response(null, {
            status: 303,
            headers: { location: 'https://registry.test/final' },
          })
        : new Response(null, { status: 200 });
    }) as typeof fetch,
  });
  await transport.request({
    url: 'https://registry.test/start',
    method: 'HEAD',
  });
  expect(methods).toEqual(['HEAD', 'HEAD']);
});

it('ProviderInspection composes provider-declared executables', () => {
  const executables: readonly ProviderExecutable[] = [
    { name: 'demo', path: 'bin/demo.js' },
    {
      name: 'demo-py',
      path: 'bin/demo.py',
      interpreter: 'python',
      entry: 'demo.cli:main',
    },
    { name: 'demo-native', path: 'bin/demo', interpreter: 'native' },
  ];
  // The type carries provider metadata as declared; validation of the wire
  // rules lives at the trust boundary in plugin-host, not in this shape.
  const inspection: Pick<ProviderInspection, 'executables'> = { executables };
  expect(inspection.executables).toHaveLength(3);
  expect(inspection.executables?.[1]).toMatchObject({
    interpreter: 'python',
    entry: 'demo.cli:main',
  });
});

describe('classify-and-pin destination policy', () => {
  const origin = 'https://registry.test';

  function recordingFetch(): {
    calls: { url: string; init?: RequestInit }[];
    fetch: typeof fetch;
  } {
    const calls: { url: string; init?: RequestInit }[] = [];
    return {
      calls,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          ...(init === undefined ? {} : { init }),
        });
        return new Response('ok');
      }) as typeof fetch,
    };
  }

  it('refuses a hostname that rebinds to a private address before fetching', async () => {
    for (const address of [
      '10.0.0.1',
      '169.254.169.254',
      '::ffff:127.0.0.1',
      '64:ff9b::7f00:1',
    ]) {
      const { calls, fetch } = recordingFetch();
      const transport = new BoundedFetchTransport({
        allowedOrigins: [origin],
        destinationPolicy: 'classify-and-pin',
        lookup: async () => [
          { address, family: address.includes(':') ? 6 : 4 },
        ],
        fetch,
      });
      await expect(
        transport.request({ url: `${origin}/data` }),
      ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
      expect(calls).toEqual([]);
    }
  });

  it('refuses an empty lookup before fetching', async () => {
    const { calls, fetch } = recordingFetch();
    const transport = new BoundedFetchTransport({
      allowedOrigins: [origin],
      destinationPolicy: 'classify-and-pin',
      lookup: async () => [],
      fetch,
    });
    await expect(
      transport.request({ url: `${origin}/data` }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
    expect(calls).toEqual([]);
  });

  it('throws on an HTTP pin without echoing userinfo', () => {
    const secret = 'https://user:secret@127.0.0.1';
    expect(
      () =>
        new BoundedFetchTransport({
          allowedOrigins: [origin],
          destinationPolicy: 'classify-and-pin',
          pinnedOrigins: ['http://127.0.0.1'],
        }),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_PROVIDER_ENDPOINT' }),
    );
    expect(
      () =>
        new BoundedFetchTransport({
          allowedOrigins: [origin],
          destinationPolicy: 'classify-and-pin',
          pinnedOrigins: [secret],
        }),
    ).toThrowError(
      expect.objectContaining({ code: 'INVALID_PROVIDER_ENDPOINT' }),
    );
    try {
      new BoundedFetchTransport({
        allowedOrigins: [origin],
        destinationPolicy: 'classify-and-pin',
        pinnedOrigins: [secret],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toMatch(/user:secret/u);
      expect((error as Error).message).not.toMatch(/secret/u);
    }
    expect(() => normalizePinnedOrigin('http://127.0.0.1')).toThrowError(
      expect.objectContaining({ code: 'INVALID_PROVIDER_ENDPOINT' }),
    );
    expect(() => normalizePinnedOrigin(secret)).toThrowError(
      expect.objectContaining({ code: 'INVALID_PROVIDER_ENDPOINT' }),
    );
    try {
      normalizePinnedOrigin(secret);
    } catch (error) {
      expect((error as Error).message).not.toMatch(/user:secret/u);
      expect((error as Error).message).not.toMatch(/secret/u);
    }
  });

  it('does not call DNS in default origin-allowlist mode', async () => {
    let lookedUp = 0;
    const { calls, fetch } = recordingFetch();
    const transport = new BoundedFetchTransport({
      allowedOrigins: [origin],
      lookup: async () => {
        lookedUp += 1;
        return [{ address: '10.0.0.1', family: 4 }];
      },
      fetch,
    });
    const response = await transport.request({ url: `${origin}/data` });
    expect(new TextDecoder().decode(response.body)).toBe('ok');
    expect(lookedUp).toBe(0);
    expect(calls).toHaveLength(1);
    expect(
      (calls[0]!.init as { dispatcher?: unknown } | undefined)?.dispatcher,
    ).toBeUndefined();
  });

  it('skips the Agent dispatcher when fetch is injected', async () => {
    const { calls, fetch } = recordingFetch();
    const transport = new BoundedFetchTransport({
      allowedOrigins: [origin],
      destinationPolicy: 'classify-and-pin',
      pinnedOrigins: [origin],
      lookup: async () => [{ address: '10.0.0.1', family: 4 }],
      fetch,
    });
    await transport.request({ url: `${origin}/data` });
    expect(calls).toHaveLength(1);
    expect(
      (calls[0]!.init as { dispatcher?: unknown } | undefined)?.dispatcher,
    ).toBeUndefined();
  });

  it('classifies every redirect hop', async () => {
    const lookedUp: string[] = [];
    const responses = [
      new Response(null, {
        status: 302,
        headers: { location: `${origin}/next` },
      }),
      new Response('ok'),
    ];
    const transport = new BoundedFetchTransport({
      allowedOrigins: [origin],
      destinationPolicy: 'classify-and-pin',
      lookup: async (hostname) => {
        lookedUp.push(hostname);
        return [{ address: '1.1.1.1', family: 4 }];
      },
      fetch: (async () => responses.shift()!) as typeof fetch,
    });
    await transport.request({ url: `${origin}/start` });
    expect(lookedUp).toEqual(['registry.test', 'registry.test']);
  });
});

describe('pinned origin helpers', () => {
  it('classifies loopback, link-local, NAT64, and mapped addresses as private', () => {
    for (const address of [
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '::1',
      '::ffff:127.0.0.1',
      '64:ff9b::7f00:1',
    ])
      expect(isPrivateAddress(address)).toBe(true);
    expect(isPrivateAddress('1.1.1.1')).toBe(false);
  });

  it('redacts userinfo, query, and hash from URLs', () => {
    expect(
      redactUrl(new URL('https://user:secret@pinned.test/path?q=1#h')),
    ).toBe('https://pinned.test/path');
  });
});

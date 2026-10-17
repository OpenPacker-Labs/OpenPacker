import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertBoundedProviderMetadata,
  assertPackageIdentityMatchesRequest,
  compareParsedVersions,
  compareCodePoints,
  BoundedFetchTransport,
  createFirstPartyTransport,
  createPinnedFetch,
  evaluateRange,
  evaluateSemverRange,
  FixtureHttpTransport,
  formatPurl,
  header,
  isEcosystem,
  isPrivateAddress,
  firstPartyOriginPolicy,
  normalizePinnedOrigin,
  parseHttpsOriginList,
  parsePurl,
  parseSemver,
  parseSemverRange,
  parseVers,
  packageNodeId,
  providerErrorForStatus,
  redactUrl,
  type HostLookup,
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
        ...(!(parsed.namespace === undefined) && {
          namespace: parsed.namespace.toLowerCase(),
        }),
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
    // An npm range is read as node-semver reads it: `^1.2.3` excludes 2.0.0's
    // prereleases by its bound, `<2.0.0-0`.
    const caret = parseSemverRange('^1.2.3', {
      scheme: 'npm',
      bare: 'exact',
      hyphenRanges: true,
    });
    expect(renderRange(caret.ast)).toBe('>=1.2.3 <2.0.0-0');
    expect(evaluateSemverRange('1.9.0', caret.ast, compareNative)).toBe(true);
    expect(rangeToConstraint(caret)).toMatchObject({
      reversible: false,
      semanticLoss: [{ code: 'NATIVE_RANGE_NOT_EXACTLY_REPRESENTABLE' }],
    });
    expect(
      parseSemverRange('1.2 - 1.4', {
        scheme: 'npm',
        bare: 'exact',
        hyphenRanges: true,
      }).normalized,
    ).toBe('>=1.2.0 <1.5.0-0');
    const prerelease = parseSemverRange('>=1.0.0-beta.1 <2.0.0', {
      scheme: 'npm',
      bare: 'exact',
      hyphenRanges: true,
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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

  // Default origin-allowlist still serves RegistryClient loopback fixtures.
  const okCalls: { url: string; init?: RequestInit }[] = [];
  const loopback = new BoundedFetchTransport({
    allowedOrigins: ['http://127.0.0.1:7337'],
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      okCalls.push({
        url: String(input),
        ...(!(init === undefined) && { init }),
      });
      return new Response('ok');
    }) as typeof fetch,
  });
  const response = await loopback.request({
    url: 'http://127.0.0.1:7337/data',
  });
  expect(new TextDecoder().decode(response.body)).toBe('ok');
  expect(okCalls).toEqual([
    expect.objectContaining({ url: 'http://127.0.0.1:7337/data' }),
  ]);
  expect(okCalls[0]!.init?.credentials).not.toBe('include');
  expect(
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    (okCalls[0]!.init as { dispatcher?: unknown } | undefined)?.dispatcher,
  ).toBeUndefined();
});

it('preserves HEAD across a 303 serviceability redirect', async () => {
  const methods: string[] = [];
  const transport = new BoundedFetchTransport({
    allowedOrigins: ['https://registry.test'],
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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

  function recordingFetch() {
    const calls: { url: string; init?: RequestInit }[] = [];
    return {
      calls,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          ...(!(init === undefined) && { init }),
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
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      expect((error as Error).message).not.toMatch(/user:secret/u);
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      expect((error as Error).message).not.toMatch(/user:secret/u);
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async () => responses.shift()!) as typeof fetch,
    });
    await transport.request({ url: `${origin}/start` });
    expect(lookedUp).toEqual(['registry.test', 'registry.test']);
  });
});

describe('first-party origin policy', () => {
  it('unions artifact CDNs without pinning them on the public default', () => {
    expect(
      firstPartyOriginPolicy({
        endpoint: 'https://pypi.org/pypi',
        namedOrOverride: false,
        artifactOrigins: ['https://files.pythonhosted.org', 'https://pypi.org'],
      }),
    ).toEqual({
      allowedOrigins: ['https://pypi.org', 'https://files.pythonhosted.org'],
      pinnedOrigins: [],
    });
  });

  it('drops artifact CDNs on an operator-named override and pins that origin', () => {
    expect(
      firstPartyOriginPolicy({
        endpoint: 'https://pypi.internal.example',
        namedOrOverride: true,
        artifactOrigins: ['https://files.pythonhosted.org', 'https://pypi.org'],
        extraOrigins: ['https://files.pythonhosted.org'],
      }),
    ).toEqual({
      allowedOrigins: [
        'https://pypi.internal.example',
        'https://files.pythonhosted.org',
      ],
      pinnedOrigins: ['https://pypi.internal.example'],
    });
  });

  it('fails closed on duplicate extra origins and HTTP extras', () => {
    expect(() =>
      parseHttpsOriginList(
        'https://files.pythonhosted.org,https://files.pythonhosted.org',
        'OPM_REGISTRY_PYPI_ORIGINS',
      ),
    ).toThrow(/OPM_REGISTRY_PYPI_ORIGINS lists duplicate origin/u);
    expect(() =>
      parseHttpsOriginList(
        'http://cdn.internal.example',
        'OPM_REGISTRY_NPM_ORIGINS',
      ),
    ).toThrow(/HTTPS origin/u);
  });

  it('builds a classify-and-pin transport from the policy', async () => {
    const calls: string[] = [];
    const transport = createFirstPartyTransport({
      endpoint: 'https://registry.npmjs.org',
      namedOrOverride: false,
      artifactOrigins: ['https://registry.npmjs.org'],
      lookup: async () => [{ address: '10.0.0.1', family: 4 }],
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response('ok');
      }) as typeof fetch,
    });
    await expect(
      transport.request({ url: 'https://registry.npmjs.org/lodash' }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ENDPOINT' });
    expect(calls).toEqual([]);
  });
});

describe('createPinnedFetch', () => {
  const origin = 'https://registry-1.docker.io';

  it('refuses an unpinned private rebinding before calling fetch', async () => {
    const calls: string[] = [];
    const fetch = createPinnedFetch({
      allowedOrigins: [origin, 'https://ghcr.io'],
      lookup: async () => [{ address: '10.0.0.1', family: 4 }],
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response('ok');
      }) as typeof fetch,
    });
    await expect(fetch(`${origin}/v2/`)).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_ENDPOINT',
    });
    expect(calls).toEqual([]);
  });

  it('allows a pinned origin that resolves private', async () => {
    const fetch = createPinnedFetch({
      allowedOrigins: [origin],
      pinnedOrigins: [origin],
      lookup: async () => [{ address: '10.0.0.1', family: 4 }],
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async () => new Response('ok')) as typeof fetch,
    });
    const response = await fetch(`${origin}/v2/`);
    expect(await response.text()).toBe('ok');
  });

  it('preserves a 401 challenge instead of mapping it to an error', async () => {
    const fetch = createPinnedFetch({
      allowedOrigins: [origin],
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async () =>
        new Response('', {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer realm="https://auth.docker.io/token"',
          },
        })) as typeof fetch,
    });
    const response = await fetch(`${origin}/v2/`);
    expect(response.status).toBe(401);
  });

  it('refuses an origin outside the allowlist', async () => {
    const calls: string[] = [];
    const fetch = createPinnedFetch({
      allowedOrigins: [origin],
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response('ok');
      }) as typeof fetch,
    });
    await expect(fetch('https://ghcr.io/v2/')).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_ENDPOINT',
    });
    expect(calls).toEqual([]);
  });
});

describe('classify-and-pin per-hop bearer', () => {
  const originA = 'https://a.example';
  const originB = 'https://b.example';
  const TOKEN_A = 'PIN_TOKEN_A';
  const TOKEN_B = 'PIN_TOKEN_B';
  const publicLookup: HostLookup = async () => [
    { address: '1.1.1.1', family: 4 },
  ];

  afterEach(() => {
    delete process.env[TOKEN_A];
    delete process.env[TOKEN_B];
    delete process.env.OPM_HOST_FETCH_BEARER;
  });

  function requestAuthorization(
    init: RequestInit | undefined,
  ): string | undefined {
    if (init?.headers === undefined) return undefined;
    const headers = init.headers;
    if (headers instanceof Headers)
      return headers.get('authorization') ?? undefined;
    if (Array.isArray(headers)) {
      const hit = headers.find(
        ([name]) => name.toLowerCase() === 'authorization',
      );
      return hit?.[1];
    }
    for (const [name, value] of Object.entries(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      headers as Record<string, string>,
    )) {
      if (name.toLowerCase() === 'authorization') return value;
    }
    return undefined;
  }

  it('attaches a different bearer on each redirect hop', async () => {
    process.env[TOKEN_A] = 'tok68valueA';
    process.env[TOKEN_B] = 'tok68valueB';
    const calls: { url: string; authorization: string | undefined }[] = [];
    const responses = [
      new Response(null, {
        status: 302,
        headers: { location: `${originB}/next` },
      }),
      new Response('ok'),
    ];
    const lookedUp: string[] = [];
    const transport = new BoundedFetchTransport({
      allowedOrigins: [originA, originB],
      destinationPolicy: 'classify-and-pin',
      pinnedOrigins: [originA, originB],
      pinnedTokenEnvNames: new Map([
        [originA, TOKEN_A],
        [originB, TOKEN_B],
      ]),
      lookup: async (hostname) => {
        lookedUp.push(hostname);
        return [{ address: '1.1.1.1', family: 4 }];
      },
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          authorization: requestAuthorization(init),
        });
        return responses.shift()!;
      }) as typeof fetch,
    });
    await transport.request({ url: `${originA}/start` });
    expect(lookedUp).toEqual(['a.example', 'b.example']);
    expect(calls).toEqual([
      { url: `${originA}/start`, authorization: 'Bearer tok68valueA' },
      { url: `${originB}/next`, authorization: 'Bearer tok68valueB' },
    ]);
  });

  it('does not attach Authorization on an unpinned allowlisted hop', async () => {
    process.env[TOKEN_A] = 'tok68valueA';
    const calls: { url: string; authorization: string | undefined }[] = [];
    const responses = [
      new Response(null, {
        status: 302,
        headers: { location: `${originB}/public` },
      }),
      new Response('ok'),
    ];
    const transport = new BoundedFetchTransport({
      allowedOrigins: [originA, originB],
      destinationPolicy: 'classify-and-pin',
      pinnedOrigins: [originA],
      pinnedTokenEnvNames: new Map([[originA, TOKEN_A]]),
      lookup: publicLookup,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          authorization: requestAuthorization(init),
        });
        return responses.shift()!;
      }) as typeof fetch,
    });
    await transport.request({ url: `${originA}/start` });
    expect(calls).toEqual([
      { url: `${originA}/start`, authorization: 'Bearer tok68valueA' },
      { url: `${originB}/public`, authorization: undefined },
    ]);
  });

  it('refuses an HTTPS to HTTP redirect before attaching bearer on the failed hop', async () => {
    process.env[TOKEN_A] = 'tok68valueA';
    const calls: { url: string; authorization: string | undefined }[] = [];
    const transport = new BoundedFetchTransport({
      allowedOrigins: [originA, 'http://127.0.0.1'],
      destinationPolicy: 'classify-and-pin',
      pinnedOrigins: [originA],
      pinnedTokenEnvNames: new Map([[originA, TOKEN_A]]),
      lookup: publicLookup,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          authorization: requestAuthorization(init),
        });
        return new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/downgrade' },
        });
      }) as typeof fetch,
    });
    await expect(
      transport.request({ url: `${originA}/start` }),
    ).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      message: expect.stringMatching(/HTTPS downgrade/u),
    });
    expect(calls).toEqual([
      { url: `${originA}/start`, authorization: 'Bearer tok68valueA' },
    ]);
    expect(calls.some((call) => call.url.startsWith('http://'))).toBe(false);
  });

  it('strips leftover credentials then re-adds the hop bearer on same-origin 3xx', async () => {
    process.env[TOKEN_A] = 'tok68valueA';
    const calls: {
      authorization: string | undefined;
      cookie: string | undefined;
    }[] = [];
    const responses = [
      new Response(null, {
        status: 302,
        headers: { location: `${originA}/next` },
      }),
      new Response('ok'),
    ];
    const transport = new BoundedFetchTransport({
      allowedOrigins: [originA],
      destinationPolicy: 'classify-and-pin',
      pinnedOrigins: [originA],
      pinnedTokenEnvNames: new Map([[originA, TOKEN_A]]),
      lookup: publicLookup,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        const headers = init?.headers as Record<string, string> | undefined;
        calls.push({
          authorization: requestAuthorization(init),
          cookie: headers?.Cookie ?? headers?.cookie,
        });
        return responses.shift()!;
      }) as typeof fetch,
    });
    await transport.request({
      url: `${originA}/start`,
      headers: {
        Authorization: 'Bearer leftover',
        Cookie: 'session=1',
      },
    });
    expect(calls).toEqual([
      { authorization: 'Bearer tok68valueA', cookie: undefined },
      { authorization: 'Bearer tok68valueA', cookie: undefined },
    ]);
  });

  it('fails UNRESOLVABLE without fetching when the named env is missing', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        ...(!(init === undefined) && { init }),
      });
      return new Response('ok');
    }) as typeof fetch;
    const transport = new BoundedFetchTransport({
      allowedOrigins: [originA],
      destinationPolicy: 'classify-and-pin',
      pinnedOrigins: [originA],
      pinnedTokenEnvNames: new Map([[originA, TOKEN_A]]),
      lookup: publicLookup,
      fetch: fetchStub,
    });
    await expect(
      transport.request({ url: `${originA}/data` }),
    ).rejects.toMatchObject({
      code: 'UNRESOLVABLE',
      message: expect.stringContaining(TOKEN_A),
    });
    expect(calls).toEqual([]);
  });

  it('does not attach Authorization when OPM_HOST_FETCH_BEARER is set but the origin has no name', async () => {
    process.env.OPM_HOST_FETCH_BEARER = 'tok68ambient';
    const calls: { authorization: string | undefined }[] = [];
    const transport = new BoundedFetchTransport({
      allowedOrigins: [originA],
      destinationPolicy: 'classify-and-pin',
      pinnedOrigins: [originA],
      lookup: publicLookup,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ authorization: requestAuthorization(init) });
        return new Response('ok');
      }) as typeof fetch,
    });
    await transport.request({ url: `${originA}/data` });
    expect(calls).toEqual([{ authorization: undefined }]);
  });

  it('does not attach a bearer in origin-allowlist mode', async () => {
    process.env[TOKEN_A] = 'tok68valueA';
    const calls: { authorization: string | undefined }[] = [];
    const transport = new BoundedFetchTransport({
      allowedOrigins: [originA],
      pinnedOrigins: [originA],
      pinnedTokenEnvNames: new Map([[originA, TOKEN_A]]),
      lookup: publicLookup,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ authorization: requestAuthorization(init) });
        return new Response('ok');
      }) as typeof fetch,
    });
    await transport.request({ url: `${originA}/data` });
    expect(calls).toEqual([{ authorization: undefined }]);
  });
});

describe('classify-and-pin per-hop extra header', () => {
  const originA = 'https://a.example';
  const originB = 'https://b.example';
  const HEADER_ENV_A = 'PIN_HEADER_A';
  const HEADER_ENV_B = 'PIN_HEADER_B';
  const TOKEN_A = 'PIN_TOKEN_A';
  const publicLookup: HostLookup = async () => [
    { address: '1.1.1.1', family: 4 },
  ];

  afterEach(() => {
    delete process.env[HEADER_ENV_A];
    delete process.env[HEADER_ENV_B];
    delete process.env[TOKEN_A];
  });

  function requestHeader(
    init: RequestInit | undefined,
    headerName: string,
  ): string | undefined {
    if (init?.headers === undefined) return undefined;
    const headers = init.headers;
    const lower = headerName.toLowerCase();
    if (headers instanceof Headers) return headers.get(headerName) ?? undefined;
    if (Array.isArray(headers)) {
      const hit = headers.find(([name]) => name.toLowerCase() === lower);
      return hit?.[1];
    }
    for (const [name, value] of Object.entries(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      headers as Record<string, string>,
    )) {
      if (name.toLowerCase() === lower) return value;
    }
    return undefined;
  }

  function requestAuthorization(
    init: RequestInit | undefined,
  ): string | undefined {
    return requestHeader(init, 'authorization');
  }

  it('attaches an extra header only on a pinned origin', async () => {
    process.env[HEADER_ENV_A] = 'jfrog-key-a';
    const calls: {
      url: string;
      extra: string | undefined;
    }[] = [];
    const responses = [
      new Response(null, {
        status: 302,
        headers: { location: `${originB}/public` },
      }),
      new Response('ok'),
    ];
    const transport = new BoundedFetchTransport({
      allowedOrigins: [originA, originB],
      destinationPolicy: 'classify-and-pin',
      pinnedOrigins: [originA],
      pinnedExtraHeaders: new Map([
        [originA, { name: 'X-JFrog-Art-Api', envName: HEADER_ENV_A }],
      ]),
      lookup: publicLookup,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          extra: requestHeader(init, 'X-JFrog-Art-Api'),
        });
        return responses.shift()!;
      }) as typeof fetch,
    });
    await transport.request({ url: `${originA}/start` });
    expect(calls).toEqual([
      { url: `${originA}/start`, extra: 'jfrog-key-a' },
      { url: `${originB}/public`, extra: undefined },
    ]);
  });

  it('attaches Bearer and extra header independently on one origin', async () => {
    process.env[TOKEN_A] = 'tok68valueA';
    process.env[HEADER_ENV_A] = 'jfrog-key-a';
    const calls: {
      authorization: string | undefined;
      extra: string | undefined;
    }[] = [];
    const transport = new BoundedFetchTransport({
      allowedOrigins: [originA],
      destinationPolicy: 'classify-and-pin',
      pinnedOrigins: [originA],
      pinnedTokenEnvNames: new Map([[originA, TOKEN_A]]),
      pinnedExtraHeaders: new Map([
        [originA, { name: 'X-JFrog-Art-Api', envName: HEADER_ENV_A }],
      ]),
      lookup: publicLookup,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          authorization: requestAuthorization(init),
          extra: requestHeader(init, 'X-JFrog-Art-Api'),
        });
        return new Response('ok');
      }) as typeof fetch,
    });
    await transport.request({ url: `${originA}/data` });
    expect(calls).toEqual([
      { authorization: 'Bearer tok68valueA', extra: 'jfrog-key-a' },
    ]);
  });

  it('rebuilds a different extra header on each redirect hop', async () => {
    process.env[HEADER_ENV_A] = 'key-a';
    process.env[HEADER_ENV_B] = 'key-b';
    const calls: { url: string; extra: string | undefined }[] = [];
    const responses = [
      new Response(null, {
        status: 302,
        headers: { location: `${originB}/next` },
      }),
      new Response('ok'),
    ];
    const transport = new BoundedFetchTransport({
      allowedOrigins: [originA, originB],
      destinationPolicy: 'classify-and-pin',
      pinnedOrigins: [originA, originB],
      pinnedExtraHeaders: new Map([
        [originA, { name: 'X-JFrog-Art-Api', envName: HEADER_ENV_A }],
        [originB, { name: 'X-JFrog-Art-Api', envName: HEADER_ENV_B }],
      ]),
      lookup: publicLookup,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          extra: requestHeader(init, 'X-JFrog-Art-Api'),
        });
        return responses.shift()!;
      }) as typeof fetch,
    });
    await transport.request({ url: `${originA}/start` });
    expect(calls).toEqual([
      { url: `${originA}/start`, extra: 'key-a' },
      { url: `${originB}/next`, extra: 'key-b' },
    ]);
  });

  it('fails UNRESOLVABLE without fetching when extra-header env is missing', async () => {
    const calls: { url: string }[] = [];
    const transport = new BoundedFetchTransport({
      allowedOrigins: [originA],
      destinationPolicy: 'classify-and-pin',
      pinnedOrigins: [originA],
      pinnedExtraHeaders: new Map([
        [originA, { name: 'X-JFrog-Art-Api', envName: HEADER_ENV_A }],
      ]),
      lookup: publicLookup,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (input: RequestInfo | URL) => {
        calls.push({ url: String(input) });
        return new Response('ok');
      }) as typeof fetch,
    });
    await expect(
      transport.request({ url: `${originA}/data` }),
    ).rejects.toMatchObject({
      code: 'UNRESOLVABLE',
      message: expect.stringContaining(HEADER_ENV_A),
    });
    expect(calls).toEqual([]);
  });

  it('does not fail origin A when origin B extra-header env is unset', async () => {
    process.env[HEADER_ENV_A] = 'key-a';
    const calls: { url: string; extra: string | undefined }[] = [];
    const transport = new BoundedFetchTransport({
      allowedOrigins: [originA, originB],
      destinationPolicy: 'classify-and-pin',
      pinnedOrigins: [originA, originB],
      pinnedExtraHeaders: new Map([
        [originA, { name: 'X-JFrog-Art-Api', envName: HEADER_ENV_A }],
        [originB, { name: 'X-JFrog-Art-Api', envName: HEADER_ENV_B }],
      ]),
      lookup: publicLookup,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          extra: requestHeader(init, 'X-JFrog-Art-Api'),
        });
        return new Response('ok');
      }) as typeof fetch,
    });
    await transport.request({ url: `${originA}/data` });
    expect(calls).toEqual([{ url: `${originA}/data`, extra: 'key-a' }]);
  });

  it('fails UNRESOLVABLE without fetching CR or LF in the extra-header value', async () => {
    // process.env cannot store NUL (C strings truncate); CR/LF remain.
    for (const value of ['bad\rvalue', 'bad\nvalue']) {
      process.env[HEADER_ENV_A] = value;
      const calls: { url: string }[] = [];
      const transport = new BoundedFetchTransport({
        allowedOrigins: [originA],
        destinationPolicy: 'classify-and-pin',
        pinnedOrigins: [originA],
        pinnedExtraHeaders: new Map([
          [originA, { name: 'X-JFrog-Art-Api', envName: HEADER_ENV_A }],
        ]),
        lookup: publicLookup,
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        fetch: (async (input: RequestInfo | URL) => {
          calls.push({ url: String(input) });
          return new Response('ok');
        }) as typeof fetch,
      });
      try {
        await transport.request({ url: `${originA}/data` });
        throw new Error('expected UNRESOLVABLE');
      } catch (error) {
        expect(error).toMatchObject({
          code: 'UNRESOLVABLE',
          message: expect.stringContaining(HEADER_ENV_A),
        });
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        expect((error as Error).message).not.toMatch(/bad/u);
      }
      expect(calls).toEqual([]);
    }
  });

  it('does not attach an extra header in origin-allowlist mode', async () => {
    process.env[HEADER_ENV_A] = 'jfrog-key-a';
    const calls: { extra: string | undefined }[] = [];
    const transport = new BoundedFetchTransport({
      allowedOrigins: [originA],
      pinnedOrigins: [originA],
      pinnedExtraHeaders: new Map([
        [originA, { name: 'X-JFrog-Art-Api', envName: HEADER_ENV_A }],
      ]),
      lookup: publicLookup,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ extra: requestHeader(init, 'X-JFrog-Art-Api') });
        return new Response('ok');
      }) as typeof fetch,
    });
    await transport.request({ url: `${originA}/data` });
    expect(calls).toEqual([{ extra: undefined }]);
  });
});

describe('classify-and-pin ambient credentials', () => {
  const origin = 'https://registry.test';
  const TOKEN = 'PIN_AMBIENT_TOKEN';
  const HEADER_ENV = 'PIN_AMBIENT_HEADER';
  const publicLookup: HostLookup = async () => [
    { address: '1.1.1.1', family: 4 },
  ];

  afterEach(() => {
    delete process.env[TOKEN];
    delete process.env[HEADER_ENV];
  });

  function requestHeader(
    init: RequestInit | undefined,
    headerName: string,
  ): string | undefined {
    if (init?.headers === undefined) return undefined;
    const headers = init.headers;
    const lower = headerName.toLowerCase();
    if (headers instanceof Headers) return headers.get(headerName) ?? undefined;
    if (Array.isArray(headers)) {
      const hit = headers.find(([name]) => name.toLowerCase() === lower);
      return hit?.[1];
    }
    for (const [name, value] of Object.entries(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      headers as Record<string, string>,
    )) {
      if (name.toLowerCase() === lower) return value;
    }
    return undefined;
  }

  function ambientCall(init: RequestInit | undefined) {
    return {
      credentials: init?.credentials,
      cookie: requestHeader(init, 'cookie'),
      cookie2: requestHeader(init, 'cookie2'),
      authorization: requestHeader(init, 'authorization'),
    };
  }

  it('does not send credentials include or Cookie on a default GET', async () => {
    const calls: ReturnType<typeof ambientCall>[] = [];
    const transport = new BoundedFetchTransport({
      allowedOrigins: [origin],
      destinationPolicy: 'classify-and-pin',
      lookup: publicLookup,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(ambientCall(init));
        return new Response('ok');
      }) as typeof fetch,
    });
    await transport.request({ url: `${origin}/data` });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.credentials).not.toBe('include');
    expect(calls[0]!.cookie).toBeUndefined();
    expect(calls[0]!.cookie2).toBeUndefined();
    expect(calls[0]!.authorization).toBeUndefined();
  });

  it('does not attach Cookie when a hop bearer is present', async () => {
    process.env[TOKEN] = 'tok68valueA';
    const calls: ReturnType<typeof ambientCall>[] = [];
    const transport = new BoundedFetchTransport({
      allowedOrigins: [origin],
      destinationPolicy: 'classify-and-pin',
      pinnedOrigins: [origin],
      pinnedTokenEnvNames: new Map([[origin, TOKEN]]),
      lookup: publicLookup,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(ambientCall(init));
        return new Response('ok');
      }) as typeof fetch,
    });
    await transport.request({ url: `${origin}/data` });
    expect(calls).toEqual([
      {
        credentials: undefined,
        cookie: undefined,
        cookie2: undefined,
        authorization: 'Bearer tok68valueA',
      },
    ]);
    expect(calls[0]!.credentials).not.toBe('include');
  });

  it('does not attach Cookie when an extra operator header is present', async () => {
    process.env[HEADER_ENV] = 'jfrog-key';
    const calls: (ReturnType<typeof ambientCall> & {
      extra: string | undefined;
    })[] = [];
    const transport = new BoundedFetchTransport({
      allowedOrigins: [origin],
      destinationPolicy: 'classify-and-pin',
      pinnedOrigins: [origin],
      pinnedExtraHeaders: new Map([
        [origin, { name: 'X-JFrog-Art-Api', envName: HEADER_ENV }],
      ]),
      lookup: publicLookup,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          ...ambientCall(init),
          extra: requestHeader(init, 'X-JFrog-Art-Api'),
        });
        return new Response('ok');
      }) as typeof fetch,
    });
    await transport.request({ url: `${origin}/data` });
    expect(calls).toEqual([
      {
        credentials: undefined,
        cookie: undefined,
        cookie2: undefined,
        authorization: undefined,
        extra: 'jfrog-key',
      },
    ]);
    expect(calls[0]!.credentials).not.toBe('include');
  });
});

describe('BoundedFetchTransport gzip', () => {
  it('decompresses gzip on the native fetch path', async () => {
    const payload = Buffer.from('gzip-body-ok');
    const compressed = gzipSync(payload);
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-encoding': 'gzip',
        'content-length': String(compressed.byteLength),
      });
      res.end(compressed);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const { port } = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${port}`;
      const transport = new BoundedFetchTransport({
        allowedOrigins: [origin],
      });
      const response = await transport.request({ url: `${origin}/data` });
      expect(new TextDecoder().decode(response.body)).toBe('gzip-body-ok');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('does not disable decompression on the classify-and-pin Agent path', async () => {
    const origin = 'https://registry.test';
    const headers: string[] = [];
    const transport = new BoundedFetchTransport({
      allowedOrigins: [origin],
      destinationPolicy: 'classify-and-pin',
      lookup: async () => [{ address: '1.1.1.1', family: 4 }],
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const value = new Headers(init?.headers).get('accept-encoding');
        if (value !== null) headers.push(value);
        return new Response('ok');
      }) as typeof fetch,
    });
    await transport.request({ url: `${origin}/data` });
    expect(headers.some((value) => /identity/iu.test(value))).toBe(false);
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

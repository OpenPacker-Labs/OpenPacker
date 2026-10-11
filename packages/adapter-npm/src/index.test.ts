import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { FixtureHttpTransport, ProviderError } from '@openpacker/adapter-core';
import {
  NpmCodec,
  NpmRegistryProvider,
  classifyDependencySpec,
  npmRangeVers,
  type NpmPackument,
  type NpmVersionMetadata,
} from './index.js';

const encoder = new TextEncoder();
const packumentBytes = await readFile(
  new URL('../../../fixtures/catalogs/npm/packument.json', import.meta.url),
);
// SAFETY: The surrounding boundary establishes the asserted domain contract.
const packument = JSON.parse(packumentBytes.toString()) as NpmPackument;
const archive = await readFile(
  new URL(
    '../../../fixtures/catalogs/npm/demo-tool-1.1.0.tgz',
    import.meta.url,
  ),
);
const sha256Integrity = packument.versions['1.1.0']!.dist!.integrity!;

describe('npm codec', () => {
  const codec = new NpmCodec();

  it('normalizes scoped coordinates and implements npm ranges', () => {
    expect(
      codec.canonicalizePurl('pkg:NPM/%40OpenPacker/Demo-Tool@v1.0.0'),
    ).toBe('pkg:npm/%40openpacker/demo-tool@1.0.0');
    expect(codec.satisfies('1.9.9', '^1.2.3')).toBe(true);
    expect(codec.satisfies('2.0.0', '^1.2.3')).toBe(false);
    expect(codec.satisfies('1.3.0', '1.2.x || >=1.3.0 <2')).toBe(true);
  });

  it('captures package-lock v3 without executing lifecycle scripts', () => {
    const capture = codec.translateLockResult(
      {
        lockfileVersion: 3,
        packages: {
          'node_modules/@openpacker/demo-tool': {
            name: '@openpacker/demo-tool',
            version: '1.1.0',
            integrity: sha256Integrity,
            dependencies: { alpha: '^1' },
          },
        },
      },
      {
        providerId: 'fixture',
        endpoint: 'https://fixtures.test',
        retrievedAt: '2026-08-02T00:00:00Z',
        evaluationTime: '2026-08-02T00:00:00Z',
        metadataDigest: { algorithm: 'sha256', value: '1'.repeat(64) },
      },
    );
    expect(capture.packages[0]?.exactPurl).toBe(
      'pkg:npm/%40openpacker/demo-tool@1.1.0',
    );
    expect(capture.packages[0]?.native).toMatchObject({
      path: 'node_modules/@openpacker/demo-tool',
    });
  });
});

it('enumerates deterministic fixture metadata and keeps dist-tags mutable', async () => {
  const body = encoder.encode(JSON.stringify(packument));
  const transport = new FixtureHttpTransport(
    new Map([
      [
        'https://fixtures.test/%40openpacker%2Fdemo-tool',
        [
          { status: 200, headers: { etag: '"fixture-1"' }, body },
          {
            status: 304,
            headers: { etag: '"fixture-1"' },
            body: new Uint8Array(),
          },
        ],
      ],
      [
        'https://fixtures.openpacker.invalid/npm/demo-tool-1.1.0.tgz',
        { status: 200, headers: {}, body: archive },
      ],
    ]),
  );
  const provider = new NpmRegistryProvider(
    transport,
    { now: () => '2026-08-02T00:00:00Z' },
    'https://fixtures.test',
  );
  expect(await provider.enumerate('pkg:npm/%40openpacker/demo-tool')).toEqual([
    'pkg:npm/%40openpacker/demo-tool@1.0.0-beta.1',
    'pkg:npm/%40openpacker/demo-tool@1.0.0',
    'pkg:npm/%40openpacker/demo-tool@1.1.0',
  ]);
  await provider.enumerate('pkg:npm/%40openpacker/demo-tool');
  expect(transport.requests[1]?.headers?.['if-none-match']).toBe('"fixture-1"');
  const inspected = await provider.inspect(
    'pkg:npm/%40openpacker/demo-tool@1.0.0',
  );
  expect(inspected.package.semanticLoss.map((loss) => loss.code)).toContain(
    'NPM_LIFECYCLE_SCRIPTS_NOT_EXECUTED',
  );
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  expect((inspected.record.body as NpmPackument)['dist-tags']).toEqual({
    latest: '1.1.0',
  });
  const snapshot = await provider.snapshot('2026-08-02T00:00:00Z');
  expect(snapshot.etag).toBe('"fixture-1"');
  expect(snapshot.revision).toMatch(/^sha256:/);
  const artifact = await provider.fetchArtifactRecord(
    'pkg:npm/%40openpacker/demo-tool@1.1.0',
  );
  expect(artifact.rawBody).toEqual(archive);
  expect(artifact.body).toMatchObject({
    digest: {
      algorithm: 'sha256',
      value: 'e0f40f3850655f389d0492397db462d8709417351ff863f38ef0a1fd73e7ba2a',
    },
    size: 31,
    mediaType: 'application/gzip',
  });
  provider.invalidate('pkg:npm/%40openpacker/demo-tool');
});

it('rejects corrupt npm tarball bytes', async () => {
  const corruptArchive = Uint8Array.from(archive);
  corruptArchive[0] = corruptArchive[0]! ^ 1;
  const provider = new NpmRegistryProvider(
    new FixtureHttpTransport(
      new Map([
        [
          'https://fixtures.test/%40openpacker%2Fdemo-tool',
          { status: 200, headers: {}, body: packumentBytes },
        ],
        [
          'https://fixtures.openpacker.invalid/npm/demo-tool-1.1.0.tgz',
          {
            status: 200,
            headers: {},
            body: corruptArchive,
          },
        ],
      ]),
    ),
    { now: () => '2026-08-02T00:00:00Z' },
    'https://fixtures.test',
  );
  await expect(
    provider.fetchArtifactRecord('pkg:npm/%40openpacker/demo-tool@1.1.0'),
  ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
});

it('revalidates ETags and explicit invalidation forces a full fetch', async () => {
  const transport = new FixtureHttpTransport(
    new Map([
      [
        'https://fixtures.test/%40openpacker%2Fdemo-tool',
        [
          {
            status: 200,
            headers: { etag: '"fixture-1"' },
            body: packumentBytes,
          },
          {
            status: 304,
            headers: { etag: '"fixture-1"' },
            body: new Uint8Array(),
          },
          {
            status: 200,
            headers: { etag: '"fixture-2"' },
            body: packumentBytes,
          },
        ],
      ],
    ]),
  );
  const provider = new NpmRegistryProvider(
    transport,
    { now: () => '2026-08-02T00:00:00Z' },
    'https://fixtures.test',
  );
  await provider.enumerate('pkg:npm/%40openpacker/demo-tool');
  await provider.enumerate('pkg:npm/%40openpacker/demo-tool');
  provider.invalidate('pkg:npm/%40openpacker/demo-tool');
  await provider.enumerate('pkg:npm/%40openpacker/demo-tool');
  expect(transport.requests[1]?.headers?.['if-none-match']).toBe('"fixture-1"');
  expect(transport.requests[2]?.headers?.['if-none-match']).toBeUndefined();
  expect((await provider.snapshot('2026-08-02T00:00:00Z')).etag).toBe(
    '"fixture-2"',
  );
});

const provenance = {
  providerId: 'fixture',
  endpoint: 'https://fixtures.test',
  retrievedAt: '2026-08-02T00:00:00Z',
  evaluationTime: '2026-08-02T00:00:00Z',
  metadataDigest: { algorithm: 'sha256' as const, value: '1'.repeat(64) },
};

describe('dependency specifiers', () => {
  it.each([
    ['^1.2.3', 'range'],
    ['1.2.x || >=3', 'range'],
    ['*', 'range'],
    ['', 'range'],
    ['latest', 'tag'],
    ['next', 'tag'],
    ['npm:react-is@18.3.1', 'alias'],
    ['npm:@scope/name@^2', 'alias'],
    ['github:jonschlinkert/time-require', 'git'],
    ['git+https://example.test/repo.git#v1', 'git'],
    ['user/repo', 'git'],
    ['user/repo#semver:^1', 'git'],
    ['https://example.test/pkg.tgz', 'url'],
    ['file:../local', 'file'],
    ['link:../local', 'file'],
    ['workspace:*', 'workspace'],
  ] as const)('reads %j as %s', (spec, expected) => {
    expect(classifyDependencySpec(spec)).toBe(expected);
  });

  const translate = (metadata: Record<string, unknown>) =>
    new NpmCodec().translateMetadata(
      // SAFETY: a literal that carries the fields under test.
      { name: 'demo', version: '1.0.0', ...metadata } as NpmVersionMetadata,
      provenance,
    );

  it('inspects a package whose dev-time tooling uses specifiers no registry resolves', async () => {
    // @vitest/pretty-format, picomatch, std-env, tinyexec and fdir each failed
    // to inspect over exactly this, which dropped them out of the candidate set.
    const { instance } = await translate({
      devDependencies: {
        'react-is': 'npm:react-is@18.3.1',
        'time-require': 'github:jonschlinkert/time-require',
        'std-env': 'latest',
        tsc: 'npm:@typescript/typescript6@^6.0.2',
      },
    });
    expect(instance.requirements).toHaveLength(4);
    for (const requirement of instance.requirements) {
      expect(requirement.kind).toBe('development');
      expect(requirement.optional).toBe(true);
      // No version constraint: it must not read as "any registry version".
      expect(requirement.expression).not.toHaveProperty('vers');
      expect(requirement.semanticLoss.map((loss) => loss.code)).toEqual([
        'NPM_DEPENDENCY_SPEC_NOT_A_RANGE',
      ]);
      expect(requirement.semanticLoss[0]!.severity).toBe('info');
    }
  });

  it('keeps an unreadable optional peer without failing the package', async () => {
    const { instance } = await translate({
      peerDependencies: { host: 'latest' },
      peerDependenciesMeta: { host: { optional: true } },
    });
    expect(instance.requirements[0]).toMatchObject({
      kind: 'peer',
      optional: true,
    });
  });

  it.each([
    ['dependencies', { dependencies: { bar: 'github:user/bar' } }],
    ['dependencies', { dependencies: { bar: 'npm:baz@^1' } }],
    ['dependencies', { dependencies: { bar: 'latest' } }],
    ['peerDependencies', { peerDependencies: { bar: 'next' } }],
  ])('refuses %s it would have to guess at', async (_field, metadata) => {
    // Resolving "github:user/bar" as the registry's "bar" is how a dependency
    // confusion attack lands, so these fail by name instead.
    await expect(translate(metadata)).rejects.toMatchObject({
      code: 'UNSUPPORTED_DEPENDENCY_SPEC',
      message: expect.stringContaining('demo@1.0.0 depends on bar'),
    });
  });
});

describe('semantic loss that stays out of the way', () => {
  const translate = (metadata: Record<string, unknown>) =>
    new NpmCodec().translateMetadata(
      // SAFETY: a literal that carries the fields under test.
      { name: 'demo', version: '1.0.0', ...metadata } as NpmVersionMetadata,
      provenance,
    );

  it('treats engines as information, since npm only advises on them', async () => {
    const { instance } = await translate({ engines: { node: '>=22' } });
    const loss = instance.semanticLoss.find(
      ({ code }) => code === 'NPM_ENGINE_RANGE_NATIVE_ONLY',
    );
    expect(loss?.severity).toBe('info');
    expect(instance.nativeSemantics?.data).toMatchObject({
      engines: { node: '>=22' },
    });
  });

  it('keeps os, cpu and libc as a loss the policy decides about', async () => {
    const { instance } = await translate({
      os: ['linux'],
      cpu: ['x64'],
      libc: ['glibc'],
    });
    const loss = instance.semanticLoss.find(
      ({ code }) => code === 'NPM_PACKAGE_TARGET_PREDICATE_ARTIFACT_ONLY',
    );
    expect(loss?.severity).toBe('error');
    expect(instance.nativeSemantics?.data).toMatchObject({
      targetPredicate: {
        type: 'allOf',
        predicates: [
          { type: 'in', path: 'os', values: ['linux'] },
          { type: 'in', path: 'architecture', values: ['x64'] },
          { type: 'in', path: 'libc', values: ['glibc'] },
        ],
      },
    });
  });

  it('reports an install script the abbreviated packument only flags', async () => {
    const { instance } = await translate({ hasInstallScript: true });
    expect(instance.semanticLoss.map((loss) => loss.code)).toContain(
      'NPM_LIFECYCLE_SCRIPTS_NOT_EXECUTED',
    );
  });
});

describe('libc from the version document', () => {
  const abbreviated = {
    name: '@scope/binding',
    'dist-tags': { latest: '1.0.0' },
    modified: '2026-01-01T00:00:00.000Z',
    versions: {
      '1.0.0': {
        name: '@scope/binding',
        version: '1.0.0',
        os: ['linux'],
        cpu: ['x64'],
      },
      '1.0.1': {
        name: '@scope/binding',
        version: '1.0.1',
        os: ['darwin'],
        cpu: ['arm64'],
      },
    },
  };
  const packumentUrl = 'https://fixtures.test/%40scope%2Fbinding';
  const body = (value: unknown) => encoder.encode(JSON.stringify(value));

  it('completes a linux package, once, from the per-version document', async () => {
    const transport = new FixtureHttpTransport(
      new Map([
        [packumentUrl, { status: 200, headers: {}, body: body(abbreviated) }],
        [
          `${packumentUrl}/1.0.0`,
          {
            status: 200,
            headers: {},
            body: body({ ...abbreviated.versions['1.0.0'], libc: ['musl'] }),
          },
        ],
      ]),
    );
    const provider = new NpmRegistryProvider(
      transport,
      { now: () => '2026-08-02T00:00:00Z' },
      'https://fixtures.test',
    );
    const first = await provider.inspect('pkg:npm/%40scope/binding@1.0.0');
    await provider.inspect('pkg:npm/%40scope/binding@1.0.0');
    expect(first.package.nativeSemantics?.data).toMatchObject({
      libc: ['musl'],
    });
    expect(first.warnings).toEqual([]);
    expect(
      transport.requests.filter((request) => request.url.endsWith('/1.0.0')),
    ).toHaveLength(1);
  });

  it('does not ask about a package that is not linux-only', async () => {
    const transport = new FixtureHttpTransport(
      new Map([
        [packumentUrl, { status: 200, headers: {}, body: body(abbreviated) }],
      ]),
    );
    const provider = new NpmRegistryProvider(
      transport,
      { now: () => '2026-08-02T00:00:00Z' },
      'https://fixtures.test',
    );
    await provider.inspect('pkg:npm/%40scope/binding@1.0.1');
    expect(transport.requests).toHaveLength(1);
  });

  it('inspects with a warning when the version document cannot be had', async () => {
    const provider = new NpmRegistryProvider(
      new FixtureHttpTransport(
        new Map([
          [packumentUrl, { status: 200, headers: {}, body: body(abbreviated) }],
        ]),
      ),
      { now: () => '2026-08-02T00:00:00Z' },
      'https://fixtures.test',
    );
    const inspected = await provider.inspect('pkg:npm/%40scope/binding@1.0.0');
    expect(inspected.warnings.map((warning) => warning.code)).toEqual([
      'NPM_LIBC_NOT_CAPTURED',
    ]);
    expect(inspected.package.nativeSemantics?.data).toMatchObject({
      targetPredicate: { type: 'allOf' },
    });
  });
});

describe('publish time evidence', () => {
  const url = 'https://fixtures.test/demo';
  const versions = {
    '1.0.0': { name: 'demo', version: '1.0.0' },
    '1.1.0': { name: 'demo', version: '1.1.0' },
  };
  const time = {
    created: '2026-01-01T00:00:00.000Z',
    '1.0.0': '2026-01-02T03:04:05.000Z',
    '1.1.0': '2026-02-03T04:05:06.000Z',
  };
  const abbreviated = (modified: string, withTime = false) => ({
    name: 'demo',
    modified,
    versions,
    ...(withTime && { time }),
  });
  const full = {
    name: 'demo',
    modified: '2026-03-01T00:00:00.000Z',
    versions,
    time,
  };
  const bytes = (value: unknown) => encoder.encode(JSON.stringify(value));

  /** One URL, two document shapes, told apart by `accept` as npmjs.org does. */
  function registry(options: { abbreviated: unknown; full?: unknown }): {
    provider: NpmRegistryProvider;
    accepts: (string | undefined)[];
  } {
    const accepts: (string | undefined)[] = [];
    const transport = {
      async request(request: {
        url: string;
        headers?: Readonly<Record<string, string>>;
      }) {
        accepts.push(request.headers?.accept);
        const isAbbreviated =
          request.headers?.accept?.includes('vnd.npm.install-v1') === true;
        const document = isAbbreviated ? options.abbreviated : options.full;
        if (document === undefined)
          throw new ProviderError('UPSTREAM_ERROR', 'no full document here');
        return {
          status: 200,
          headers: {},
          body: bytes(document),
          url: request.url,
        };
      },
    };
    return {
      provider: new NpmRegistryProvider(
        transport,
        { now: () => '2026-08-02T00:00:00Z' },
        'https://fixtures.test',
      ),
      accepts,
    };
  }

  const settledBefore = '2026-07-01T00:00:00.000Z';

  it('takes the time from the abbreviated document when a registry supplies it', async () => {
    const { provider, accepts } = registry({
      abbreviated: abbreviated('2026-07-30T00:00:00.000Z', true),
    });
    expect(
      await provider.publishTime('pkg:npm/demo@1.1.0', { settledBefore }),
    ).toEqual({
      publishedAt: '2026-02-03T04:05:06.000Z',
      source: 'packument-time',
    });
    expect(accepts).toHaveLength(1);
  });

  it('settles from `modified` alone, with no request beyond the packument', async () => {
    const { provider, accepts } = registry({
      abbreviated: abbreviated('2026-02-10T00:00:00.000Z'),
    });
    // The document has not changed since 2026-02-10, so no version in it was
    // published after that, and that is before the cutoff.
    expect(
      await provider.publishTime('pkg:npm/demo@1.0.0', { settledBefore }),
    ).toEqual({
      publishedNoLaterThan: '2026-02-10T00:00:00.000Z',
      source: 'packument-modified',
    });
    expect(accepts).toEqual(['application/vnd.npm.install-v1+json']);
  });

  it('reads the full document for a package changed since the cutoff, once', async () => {
    const { provider, accepts } = registry({
      abbreviated: abbreviated('2026-07-30T00:00:00.000Z'),
      full,
    });
    expect(
      await provider.publishTime('pkg:npm/demo@1.0.0', { settledBefore }),
    ).toEqual({
      publishedAt: '2026-01-02T03:04:05.000Z',
      source: 'full-packument',
    });
    expect(
      (await provider.publishTime('pkg:npm/demo@1.1.0', { settledBefore }))
        ?.publishedAt,
    ).toBe('2026-02-03T04:05:06.000Z');
    expect(
      accepts.filter((accept) => accept === 'application/json'),
    ).toHaveLength(1);
  });

  it('wants the exact time when it is not told what would be enough', async () => {
    const { provider } = registry({
      abbreviated: abbreviated('2026-02-10T00:00:00.000Z'),
      full,
    });
    expect(await provider.publishTime('pkg:npm/demo@1.0.0')).toMatchObject({
      publishedAt: '2026-01-02T03:04:05.000Z',
      source: 'full-packument',
    });
  });

  it('says nothing rather than guess when the exact time cannot be had', async () => {
    const { provider } = registry({
      abbreviated: abbreviated('2026-07-30T00:00:00.000Z'),
    });
    expect(
      await provider.publishTime('pkg:npm/demo@1.0.0', { settledBefore }),
    ).toBeUndefined();
  });

  it('ignores a time that is not a timestamp', async () => {
    const { provider } = registry({
      abbreviated: abbreviated('not a date'),
      full: { ...full, time: { '1.0.0': 'yesterday' } },
    });
    expect(
      await provider.publishTime('pkg:npm/demo@1.0.0', { settledBefore }),
    ).toBeUndefined();
  });

  it('uses the packument URL for the full document, so origin rules still apply', async () => {
    const seen: string[] = [];
    const provider = new NpmRegistryProvider(
      {
        async request(request: { url: string }) {
          seen.push(request.url);
          return {
            status: 200,
            headers: {},
            body: bytes(full),
            url: request.url,
          };
        },
      },
      { now: () => '2026-08-02T00:00:00Z' },
      'https://fixtures.test',
    );
    await provider.publishTime('pkg:npm/demo@1.0.0', {
      settledBefore: '2026-01-01T00:00:00.000Z',
    });
    expect(new Set(seen)).toEqual(new Set([url]));
  });
});

describe('ranges the solver can enforce', () => {
  const vers = (range: string) =>
    npmRangeVers(new NpmCodec().parseNativeRange(range).ast);

  it.each([
    ['^2.9.0', 'vers:npm/>=2.9.0|<3.0.0'],
    ['~1.2.3', 'vers:npm/>=1.2.3|<1.3.0'],
    ['>=1 <2', 'vers:npm/>=1.0.0|<2.0.0'],
    ['^1 || ^2', 'vers:npm/>=1.0.0|<2.0.0||>=2.0.0|<3.0.0'],
    ['1.2.3', 'vers:npm/=1.2.3'],
  ])('renders %s as %s', (range, expected) => {
    expect(vers(range)).toBe(expected);
  });

  it.each(['*', '', '^1 || *'])('leaves %j unconstrained', (range) => {
    expect(vers(range)).toBeUndefined();
  });

  it('puts the constraint on the requirement, and says it is a superset', async () => {
    // Before this a caret range reached the solver as "any version".
    const { instance } = await new NpmCodec().translateMetadata(
      // SAFETY: a literal that carries the fields under test.
      {
        name: 'demo',
        version: '1.0.0',
        dependencies: { tinybench: '^2.9.0' },
      } as NpmVersionMetadata,
      provenance,
    );
    const [requirement] = instance.requirements;
    expect(requirement!.expression).toMatchObject({
      purl: 'pkg:npm/tinybench',
      vers: 'vers:npm/>=2.9.0|<3.0.0',
    });
    expect(requirement!.semanticLoss[0]).toMatchObject({
      code: 'NATIVE_RANGE_NOT_EXACTLY_REPRESENTABLE',
      severity: 'warning',
      representedMeaning: expect.stringContaining('superset'),
    });
  });
});

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '@openpacker/packslip';
import { detectHost } from '@openpacker/packslip';
import {
  FakeWeb,
  buildList,
  buildRelease,
  fakeFetch,
  generateTestKey,
  generateTestLog,
  githubWorld,
  type BuildOptions,
  type TestKey,
} from '@openpacker/packslip-testkit';
import {
  ResolutionCache,
  providerForContext,
  trustTierFor,
  withoutRef,
  type PackslipProvider,
} from '../src/index.js';

const NOW = '2026-10-11T00:00:00.000Z';
const PROJECT = 'github.com/acme/tool';
const BASE = 'pkg:packslip/github.com/acme/tool';
const host = detectHost({
  platform: 'linux',
  arch: 'x64',
  glibcVersion: '2.36',
  kernelRelease: '6.1.0',
  env: {},
});

let key: TestKey;
let web: FakeWeb;
/** One network per world: providers that share it share verified resolutions. */
let network: ReturnType<typeof fakeFetch>;

const release = (version: string, over: Partial<BuildOptions> = {}) =>
  buildRelease({
    project: PROJECT,
    version,
    key,
    baseUrl: `https://github.com/acme/tool/releases/download/v${version}`,
    ...over,
  });

function trust(extra: JsonObject = {}): JsonObject {
  return {
    trust: {
      [PROJECT]: {
        public_key: key.publicKeyFile,
        allow_unlogged: true,
        ...extra,
      },
    },
  };
}

function provider(
  over: {
    settings?: JsonObject;
    prior?: JsonObject;
    trustedRoot?: string;
  } = {},
): PackslipProvider {
  return providerForContext(
    {
      fetch: network,
      now: () => NOW,
      settings: over.settings ?? trust(),
      ...(over.prior !== undefined && { priorAttestations: over.prior }),
    },
    {
      host,
      lookup: async () => [{ address: '140.82.112.3', family: 4 }],
      ...(over.trustedRoot !== undefined && { trustedRoot: over.trustedRoot }),
    },
  );
}

function publish(
  versions: string[],
  over: { latestTag?: string; list?: Uint8Array } = {},
) {
  const built = versions.map((version) => release(version));
  githubWorld(web, {
    repo: 'acme/tool',
    releases: built.map((entry, index) => ({
      tag: `v${versions[index]}`,
      release: entry,
    })),
    ...over,
  });
  return built;
}

/** A fresh world is a fresh network, so nothing verified in the last one carries over. */
function newWorld(): void {
  web = new FakeWeb();
  network = fakeFetch(web);
}

beforeEach(() => {
  key = generateTestKey();
  newWorld();
});

describe('enumerating versions', () => {
  it('lists eligible stable versions oldest first, the best one last', async () => {
    publish(['1.0.0', '1.10.0', '1.9.0', '2.0.0-rc.1']);
    expect(await provider().enumerate(BASE)).toEqual([
      `${BASE}@1.0.0`,
      `${BASE}@1.9.0`,
      `${BASE}@1.10.0`,
    ]);
  });

  it('puts the vendor’s recommended release last even when a newer one exists', async () => {
    const [a, b] = publish(['1.0.0', '2.0.0']);
    web.set(
      'https://raw.githubusercontent.com/acme/tool/HEAD/.well-known/packslip.json',
      buildList({
        project: PROJECT,
        key,
        sequence: 1,
        latest: '1.0.0',
        entries: [
          {
            version: '1.0.0',
            tag: 'v1.0.0',
            url: 'https://github.com/acme/tool/releases/download/v1.0.0/packslip.sigstore.json',
            release: a!,
          },
          {
            version: '2.0.0',
            tag: 'v2.0.0',
            url: 'https://github.com/acme/tool/releases/download/v2.0.0/packslip.sigstore.json',
            release: b!,
          },
        ],
      }),
    );
    expect(await provider().enumerate(BASE)).toEqual([
      `${BASE}@2.0.0`,
      `${BASE}@1.0.0`,
    ]);
  });

  it('leaves withdrawn releases out', async () => {
    const [a, b] = publish(['1.0.0', '2.0.0']);
    web.set(
      'https://raw.githubusercontent.com/acme/tool/HEAD/.well-known/packslip.json',
      buildList({
        project: PROJECT,
        key,
        sequence: 1,
        entries: [
          {
            version: '1.0.0',
            url: 'https://github.com/acme/tool/releases/download/v1.0.0/packslip.sigstore.json',
            release: a!,
          },
          {
            version: '2.0.0',
            url: 'https://github.com/acme/tool/releases/download/v2.0.0/packslip.sigstore.json',
            release: b!,
            yanked: true,
          },
        ],
      }),
    );
    expect(await provider().enumerate(BASE)).toEqual([`${BASE}@1.0.0`]);
  });

  it('keeps the variant qualifier on every version it lists', async () => {
    publish(['1.0.0']);
    expect(await provider().enumerate(`${BASE}?variant=fips`)).toEqual([
      `${BASE}@1.0.0?variant=fips`,
    ]);
  });

  it('does not download a bundle to list versions', async () => {
    publish(['1.0.0', '1.1.0']);
    await provider().enumerate(BASE);
    expect(
      web.requests.filter((url) => url.endsWith('packslip.sigstore.json')),
    ).toEqual([]);
  });

  it('reports a project with no releases as having no versions', async () => {
    githubWorld(web, { repo: 'acme/tool', releases: [] });
    expect(await provider().enumerate(BASE)).toEqual([]);
  });
});

describe('inspecting a release', () => {
  it('describes the verified release as a package with a native executable', async () => {
    publish(['1.2.3']);
    const inspection = await provider().inspect(`${BASE}@1.2.3`);
    const { package: pkg } = inspection;
    expect(pkg.identity).toMatchObject({
      exactPurl: `${BASE}@1.2.3`,
      purlType: 'packslip',
      version: '1.2.3',
    });
    expect(pkg.nativeVersion).toBe('1.2.3');
    expect(pkg.lifecycle).toMatchObject({
      status: 'published',
      eligible: true,
    });
    expect(pkg.requirements).toEqual([]);
    expect(pkg.artifacts).toHaveLength(1);
    expect(pkg.artifacts[0]).toMatchObject({
      nativeRole: 'package-archive',
      mediaType: 'application/gzip',
      locations: [
        {
          transport: 'https',
          uri: expect.stringContaining('/releases/download/v1.2.3/'),
        },
      ],
    });
    expect(pkg.artifacts[0]?.digest.value).toMatch(/^[0-9a-f]{64}$/u);
    expect(inspection.executables).toEqual([
      { name: 'tool', path: 'tool/bin/tool', interpreter: 'native' },
    ]);
    expect(inspection.record.body).toMatchObject({
      version: '1.2.3',
      project: PROJECT,
      tag: 'v1.2.3',
    });
  });

  it('reports what was verified as attestation evidence', async () => {
    publish(['1.2.3']);
    const { attestation } = await provider().inspect(`${BASE}@1.2.3`);
    expect(attestation).toMatchObject({
      kind: 'packslip',
      signerIdentity: key.keyId,
      signedAt: '2026-09-01T00:00:00Z',
      signedAtVerified: false,
      trustTier: 'registry-attested',
      // A pinned key is the project's anchor, not Sigstore's: no `sigstore`.
      evidence: ['packslip'],
    });
    expect(attestation?.record).toMatchObject({
      project: PROJECT,
      version: '1.2.3',
      attested_by: 'vendor',
      logged: false,
      signer: { scheme: 'sigstore-key', identity: key.keyId },
    });
    expect(attestation?.record.bundle_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('offers the log’s time as the release time, and the signer’s own only as a claim', async () => {
    // The signer wrote 2020; the log signed 2026-10-10. A minimum release age is
    // measured from what was proven, so that is the only `publishedAt` offered.
    const log = generateTestLog();
    const built = release('1.2.3', {
      publishedAt: '2020-01-01T00:00:00Z',
      logged: { log, integratedTime: new Date('2026-10-10T00:00:00Z') },
    });
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.2.3', release: built }],
    });
    const inspection = await provider({
      settings: trust({ allow_unlogged: false }),
      trustedRoot: log.trustedRoot,
    }).inspect(`${BASE}@1.2.3`);
    expect(inspection.record.body).toMatchObject({
      publishedAt: '2026-10-10T00:00:00.000Z',
      statedPublishedAt: '2020-01-01T00:00:00Z',
    });
    expect(inspection.attestation).toMatchObject({
      signedAt: '2026-10-10T00:00:00.000Z',
      signedAtVerified: true,
      evidence: ['packslip', 'sigstore-transparency'],
      trustTier: 'registry-attested',
    });
  });

  it('offers no release time at all when nothing verified one', async () => {
    const built = release('1.2.3', { publishedAt: '2020-01-01T00:00:00Z' });
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.2.3', release: built }],
    });
    const inspection = await provider().inspect(`${BASE}@1.2.3`);
    expect(inspection.record.body).not.toHaveProperty('publishedAt');
    expect(inspection.record.body).toMatchObject({
      statedPublishedAt: '2020-01-01T00:00:00Z',
    });
    expect(inspection.attestation?.signedAtVerified).toBe(false);
  });

  it('carries a list sequence into the record when a signed list was used', async () => {
    const [a] = publish(['1.0.0']);
    web.set(
      'https://raw.githubusercontent.com/acme/tool/HEAD/.well-known/packslip.json',
      buildList({
        project: PROJECT,
        key,
        sequence: 9,
        entries: [
          {
            version: '1.0.0',
            url: 'https://github.com/acme/tool/releases/download/v1.0.0/packslip.sigstore.json',
            release: a!,
          },
        ],
      }),
    );
    expect(
      (await provider().inspect(`${BASE}@1.0.0`)).attestation?.record.list,
    ).toEqual({ sequence: 9 });
  });

  it('declares honestly what opm does not do with a release’s resources and provenance', async () => {
    const built = release('1.0.0', {
      resources: [{ kind: 'man', archive: 'tool/share/man/man1/tool.1' }],
      artifacts: [
        {
          os: 'linux',
          arch: 'x86_64',
          libc: 'gnu',
          provenance: ['https://example.test/attestation'],
          files: [
            {
              path: 'tool/bin/tool',
              contents: '#!/bin/sh\n',
              executable: true,
            },
            { path: 'tool/share/man/man1/tool.1', contents: '.TH T 1' },
          ],
        },
      ],
    });
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.0.0', release: built }],
    });
    const { package: pkg } = await provider().inspect(`${BASE}@1.0.0`);
    expect(pkg.semanticLoss.map((loss) => [loss.code, loss.severity])).toEqual([
      ['PACKSLIP_PROVENANCE_NOT_VERIFIED', 'info'],
      ['PACKSLIP_RESOURCES_NOT_INSTALLED', 'info'],
    ]);
  });

  it('warns when the host cannot be checked, and when a release declares no executables', async () => {
    const built = release('1.0.0', {
      artifacts: [
        {
          os: 'linux',
          arch: 'x86_64',
          libc: 'gnu',
          bin: [],
          requires: { bin: [{ name: 'java', min: '17' }] },
        },
      ],
    });
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.0.0', release: built }],
    });
    const { warnings, executables } = await provider().inspect(`${BASE}@1.0.0`);
    expect(executables).toEqual([]);
    expect(warnings.map((warning) => warning.code).sort()).toEqual([
      'PACKSLIP_HOST_REQUIREMENT',
      'PACKSLIP_NO_EXECUTABLES',
    ]);
  });

  it('shares one verification between the calls opm makes about the same release', async () => {
    publish(['1.0.0']);
    const subject = provider();
    await subject.inspect(`${BASE}@1.0.0`);
    await subject.inspect(`${BASE}@1.0.0`);
    await subject.fetchArtifactRecord(`${BASE}@1.0.0`);
    expect(
      web.requests.filter((url) => url.endsWith('packslip.sigstore.json')),
    ).toHaveLength(1);
    // A different provider instance in the same world shares the work too.
    await provider().inspect(`${BASE}@1.0.0`);
    expect(
      web.requests.filter((url) => url.endsWith('packslip.sigstore.json')),
    ).toHaveLength(1);
  });

  it('does not remember a failure: a retry asks again', async () => {
    const [built] = publish(['1.0.0']);
    web.set(
      'https://github.com/acme/tool/releases/download/v1.0.0/packslip.sigstore.json',
      'busy',
      503,
    );
    const subject = provider();
    await expect(subject.inspect(`${BASE}@1.0.0`)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    web.set(
      'https://github.com/acme/tool/releases/download/v1.0.0/packslip.sigstore.json',
      built!.bundle,
    );
    await expect(subject.inspect(`${BASE}@1.0.0`)).resolves.toBeDefined();
  });

  it('needs an exact version and an exact match', async () => {
    publish(['1.0.0']);
    await expect(provider().inspect(BASE)).rejects.toMatchObject({
      code: 'VERSION_NOT_FOUND',
    });
    await expect(provider().inspect(`${BASE}@9.9.9`)).rejects.toMatchObject({
      code: 'VERSION_NOT_FOUND',
    });
    await expect(provider().inspect(`${BASE}@1.0`)).rejects.toMatchObject({
      code: 'INVALID_PURL',
    });
  });

  it('selects the variant a PURL asks for', async () => {
    const built = release('1.0.0', {
      artifacts: [
        { os: 'linux', arch: 'x86_64', libc: 'gnu' },
        {
          os: 'linux',
          arch: 'x86_64',
          libc: 'gnu',
          variant: 'fips',
          bin: ['tool/bin/tool-fips'],
        },
      ],
    });
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.0.0', release: built }],
    });
    const plain = await provider().inspect(`${BASE}@1.0.0`);
    const fips = await provider().inspect(`${BASE}@1.0.0?variant=fips`);
    expect(plain.executables?.[0]?.path).toBe('tool/bin/tool');
    expect(fips.executables?.[0]?.path).toBe('tool/bin/tool-fips');
    expect(fips.package.identity.exactPurl).toBe(`${BASE}@1.0.0?variant=fips`);
    expect(fips.package.nodeId).not.toBe(plain.package.nodeId);
  });
});

describe('fetching the artifact', () => {
  it('returns the verified archive bytes and a descriptor of them', async () => {
    const [built] = publish(['1.0.0']);
    const record = await provider().fetchArtifactRecord(`${BASE}@1.0.0`);
    const [name, bytes] = [...built!.archives][0]!;
    expect(Buffer.from(record.rawBody).equals(Buffer.from(bytes))).toBe(true);
    expect(record.endpoint).toBe(
      `https://github.com/acme/tool/releases/download/v1.0.0/${name}`,
    );
    expect(record.body).toMatchObject({
      nativeRole: 'package-archive',
      size: bytes.byteLength,
      mediaType: 'application/gzip',
    });
  });

  it('refuses bytes that are not the bytes the signer described', async () => {
    const [built] = publish(['1.0.0']);
    const [name, bytes] = [...built!.archives][0]!;
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    web.set(built!.urls.get(name)!, tampered);
    await expect(
      provider().fetchArtifactRecord(`${BASE}@1.0.0`),
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
  });

  it('refuses an archive larger than opm can unpack, before downloading it', async () => {
    const big = buildRelease({
      project: PROJECT,
      version: '1.0.0',
      key,
      baseUrl: 'https://github.com/acme/tool/releases/download/v1.0.0',
    });
    // Rewrite the statement to claim a huge size, and re-sign it.
    const parsed = JSON.parse(
      Buffer.from(
        JSON.parse(Buffer.from(big.bundle).toString()).dsseEnvelope.payload,
        'base64',
      ).toString(),
    );
    parsed.predicate.artifacts[0].size = 65 * 1024 * 1024;
    const { signBundle } = await import('@openpacker/packslip-testkit');
    githubWorld(web, { repo: 'acme/tool', releases: [{ tag: 'v1.0.0' }] });
    web.set(
      'https://github.com/acme/tool/releases/download/v1.0.0/packslip.sigstore.json',
      signBundle(parsed, key),
    );
    await expect(
      provider().fetchArtifactRecord(`${BASE}@1.0.0`),
    ).rejects.toMatchObject({ code: 'ARTIFACT_TOO_LARGE' });
    expect(web.requests.filter((url) => url.endsWith('.tar.gz'))).toEqual([]);
  });

  it('derives a GitHub download URL when the statement declares none', async () => {
    const built = release('1.0.0');
    const parsed = JSON.parse(
      Buffer.from(
        JSON.parse(Buffer.from(built.bundle).toString()).dsseEnvelope.payload,
        'base64',
      ).toString(),
    );
    const [name, bytes] = [...built.archives][0]!;
    delete parsed.predicate.artifacts[0].url;
    const { signBundle } = await import('@openpacker/packslip-testkit');
    githubWorld(web, { repo: 'acme/tool', releases: [{ tag: 'v1.0.0' }] });
    web.set(
      'https://github.com/acme/tool/releases/download/v1.0.0/packslip.sigstore.json',
      signBundle(parsed, key),
    );
    web.set(
      `https://github.com/acme/tool/releases/download/v1.0.0/${name}`,
      bytes,
    );
    const record = await provider().fetchArtifactRecord(`${BASE}@1.0.0`);
    expect(record.endpoint).toBe(
      `https://github.com/acme/tool/releases/download/v1.0.0/${name}`,
    );
  });
});

describe('refusing what cannot be trusted, with codes opm already reports', () => {
  it('reports a forged release as a signature failure', async () => {
    const forged = buildRelease({
      project: PROJECT,
      version: '1.0.0',
      key: generateTestKey(),
      baseUrl: 'https://github.com/acme/tool/releases/download/v1.0.0',
    });
    githubWorld(web, {
      repo: 'acme/tool',
      releases: [{ tag: 'v1.0.0', release: forged }],
    });
    await expect(provider().inspect(`${BASE}@1.0.0`)).rejects.toMatchObject({
      code: 'SIGNATURE_VERIFICATION_FAILED',
    });
  });

  it('reports a missing signer configuration as invalid input, not as a crash', async () => {
    publish(['1.0.0']);
    // The project is on GitHub, so its issuer is derived — but a key-signed release needs its key.
    await expect(
      provider({ settings: {} }).inspect(`${BASE}@1.0.0`),
    ).rejects.toMatchObject({
      code: 'SIGNATURE_VERIFICATION_FAILED',
    });
  });

  it('refuses bad configuration before any request', async () => {
    publish(['1.0.0']);
    expect(() =>
      provider({ settings: { trust: { [PROJECT]: { pins: ['x'] } } } }),
    ).toThrow(
      expect.objectContaining({
        code: 'INVALID_PACKSLIP_INPUT',
        message: expect.stringMatching(/unknown key "pins"/u),
      }),
    );
    expect(web.requests).toEqual([]);
  });

  it('refuses an unreadable lock record instead of forgetting what it held', async () => {
    publish(['1.0.0']);
    expect(() => provider({ prior: { [BASE]: { signer: 'nope' } } })).toThrow(
      expect.objectContaining({
        code: 'INVALID_PACKSLIP_INPUT',
        message: expect.stringMatching(/lock attestation/u),
      }),
    );
  });
});

describe('continuity through the lock', () => {
  it('notices a changed signer from what the lock kept, and accepts it once approved', async () => {
    publish(['1.0.0']);
    const first = await provider().inspect(`${BASE}@1.0.0`);
    const record = first.attestation?.record ?? {};

    // The vendor rotates its key and re-signs.
    newWorld();
    const rotated = generateTestKey();
    const old = key;
    key = rotated;
    publish(['1.0.0', '1.1.0']);
    const settings = trust();
    const prior = { [BASE]: record };
    const error = await provider({ settings, prior })
      .inspect(`${BASE}@1.1.0`)
      .then(
        () => undefined,
        (caught: Error) => caught,
      );
    expect(error).toMatchObject({ code: 'TRUST_CHANGE_REQUIRES_APPROVAL' });
    const id = /proposal ([0-9a-f]{16})/u.exec(error?.message ?? '')?.[1];
    expect(id).toBeDefined();
    expect(error?.message).toContain('key');

    const approved = await provider({
      settings: { ...settings, approvals: [id ?? ''] },
      prior,
    }).inspect(`${BASE}@1.1.0`);
    expect(approved.attestation?.signerIdentity).toBe(rotated.keyId);
    expect(approved.attestation?.signerIdentity).not.toBe(old.keyId);
  });

  it('accepts the same signer on the next release', async () => {
    publish(['1.0.0', '1.1.0']);
    const first = await provider().inspect(`${BASE}@1.0.0`);
    const next = await provider({
      prior: { [BASE]: first.attestation?.record ?? {} },
    }).inspect(`${BASE}@1.1.0`);
    expect(next.package.nativeVersion).toBe('1.1.0');
  });
});

describe('identifying a package', () => {
  it.each([
    [
      'pkg:packslip/github.com/jdx/hk@2.5.0',
      'pkg:packslip/github.com/jdx/hk@2.5.0',
    ],
    [
      'packslip:github.com/jdx/hk@2.5.0',
      'pkg:packslip/github.com/jdx/hk@2.5.0',
    ],
    ['packslip:github.com/jdx/hk', 'pkg:packslip/github.com/jdx/hk'],
    ['jdx/hk', 'pkg:packslip/github.com/jdx/hk'],
    ['github.com/jdx/hk@2.5.0', 'pkg:packslip/github.com/jdx/hk@2.5.0'],
    ['packslip:mise.jdx.dev', 'pkg:packslip/mise.jdx.dev'],
  ])('reads %s', async (query, purl) => {
    const [identity] = await provider().identify(query);
    expect(identity?.exactPurl ?? identity?.canonicalPurl).toBe(purl);
  });

  it('refuses what is not a project, with an error code opm reports', async () => {
    for (const query of ['hk', '', 'packslip:']) {
      await expect(provider().identify(query)).rejects.toMatchObject({
        code: 'INVALID_PACKSLIP_INPUT',
      });
    }
  });
});

describe('what a signer’s identity is called', () => {
  it.each([
    [
      'https://github.com/jdx/hk/.github/workflows/release.yml@refs/tags/v2.5.0',
      'https://github.com/jdx/hk/.github/workflows/release.yml',
    ],
    [
      'https://gitlab.com/group/proj//.gitlab-ci.yml@refs/heads/main',
      'https://gitlab.com/group/proj//.gitlab-ci.yml',
    ],
    // An email is whole. Cutting it at its `@` would let an allow-list entry
    // for "alice" match every alice@anywhere.
    ['alice@example.com', 'alice@example.com'],
    [
      'https://github.com/o/r/.github/workflows/w.yml',
      'https://github.com/o/r/.github/workflows/w.yml',
    ],
  ])('drops only a trailing ref: %s', (identity, expected) => {
    expect(withoutRef(identity)).toBe(expected);
  });
});

describe('the trust tier', () => {
  const strongest = {
    keyless: true,
    logged: true,
    repositoryId: '922514152',
    attestedBy: 'vendor' as const,
  };

  it('is trusted-publisher only for a logged, repository-bound CI identity vouching for its own release', () => {
    expect(trustTierFor(strongest)).toBe('trusted-publisher');
  });

  it.each([
    ['a key the project pinned', { keyless: false }],
    ['an unlogged signature', { logged: false }],
    ['an identity with no repository behind it', { repositoryId: undefined }],
    ['a repackager vouching for it', { attestedBy: 'repackager' as const }],
  ])('is registry-attested for %s', (_name, change) => {
    expect(trustTierFor({ ...strongest, ...change })).toBe('registry-attested');
  });
});

describe('snapshots', () => {
  it('summarize the releases a provider has resolved, and change when they do', async () => {
    publish(['1.0.0', '1.1.0']);
    const subject = provider();
    const empty = await subject.snapshot(NOW);
    await subject.inspect(`${BASE}@1.0.0`);
    const one = await subject.snapshot(NOW);
    await subject.inspect(`${BASE}@1.1.0`);
    const two = await subject.snapshot(NOW);
    expect(
      new Set([empty.snapshotId, one.snapshotId, two.snapshotId]).size,
    ).toBe(3);
    expect(two).toMatchObject({
      providerType: 'packslip-release',
      evaluationTime: NOW,
    });
  });
});

describe('snapshots do not depend on who warmed the cache', () => {
  it('are the same whether the verification was made by this provider or found already made', async () => {
    publish(['1.0.0']);
    const first = provider();
    await first.inspect(`${BASE}@1.0.0`);
    // Same world, so the second provider finds the verification in the shared
    // cache and makes none of its own.
    const second = provider();
    await second.inspect(`${BASE}@1.0.0`);
    expect(await second.snapshot(NOW)).toEqual(await first.snapshot(NOW));
  });
});

describe('the resolution cache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // The cache never looks inside a resolution; a stand-in is enough to count makes.
  const resolution = (n: number) => Promise.resolve({ n } as never);

  it('shares one resolution per key and does not remember a failure', async () => {
    const cache = new ResolutionCache();
    let made = 0;
    const make = () => {
      made += 1;
      return resolution(made);
    };
    await cache.get('a', make);
    await cache.get('a', make);
    expect(made).toBe(1);
    const failing = () => {
      made += 1;
      return Promise.reject(new Error('down'));
    };
    await expect(cache.get('b', failing)).rejects.toThrow('down');
    await expect(cache.get('b', failing)).rejects.toThrow('down');
    expect(made).toBe(3);
  });

  it('keeps only the newest few, so a long-lived host does not hold every archive it ever fetched', async () => {
    const cache = new ResolutionCache();
    let made = 0;
    const make = () => {
      made += 1;
      return resolution(made);
    };
    for (let key = 0; key < 20; key += 1) await cache.get(`k${key}`, make);
    expect(made).toBe(20);
    await cache.get('k19', make); // newest: still held
    expect(made).toBe(20);
    await cache.get('k0', make); // oldest: long gone
    expect(made).toBe(21);
  });

  it('drops what has expired', async () => {
    vi.useFakeTimers();
    const cache = new ResolutionCache();
    let made = 0;
    const make = () => {
      made += 1;
      return resolution(made);
    };
    await cache.get('a', make);
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    await cache.get('a', make);
    expect(made).toBe(2);
  });
});

describe('a real keyless release (jdx/hk 2.5.0)', () => {
  // A bundle jdx's CI signed and Rekor logged, unmodified: verified offline
  // against the Sigstore trusted root opm ships.
  const hkBundle = readFileSync(
    new URL(
      '../../packslip/test/fixtures/real/hk-2.5.0.sigstore.json',
      import.meta.url,
    ),
  );
  const HK = 'pkg:packslip/github.com/jdx/hk';
  const hkHost = detectHost({
    platform: 'linux',
    arch: 'x64',
    glibcVersion: '2.36',
    kernelRelease: '6.1.0',
    env: {},
  });

  function hkProvider(
    over: { settings?: JsonObject; prior?: JsonObject } = {},
  ): PackslipProvider {
    return providerForContext(
      {
        fetch: network,
        now: () => NOW,
        settings: over.settings ?? {},
        ...(over.prior !== undefined && { priorAttestations: over.prior }),
      },
      {
        host: {
          ...hkHost,
          facts: { ...hkHost.facts, hasLibrary: () => true },
        },
        lookup: async () => [{ address: '140.82.112.3', family: 4 }],
      },
    );
  }

  beforeEach(() => {
    githubWorld(web, {
      repo: 'jdx/hk',
      releases: [{ tag: 'v2.5.0' }],
      latestTag: 'v2.5.0',
    });
    web.set(
      'https://github.com/jdx/hk/releases/download/v2.5.0/packslip.sigstore.json',
      hkBundle,
    );
  });

  it('is trusted on the project name alone: GitHub says who may sign', async () => {
    expect(await hkProvider().enumerate(HK)).toEqual([`${HK}@2.5.0`]);
    const inspection = await hkProvider().inspect(`${HK}@2.5.0`);
    expect(inspection.package.nativeVersion).toBe('2.5.0');
    expect(inspection.executables).toEqual([
      { name: 'hk', path: 'hk', interpreter: 'native' },
    ]);
  });

  it('reports a CI identity in a transparency log as the strongest evidence', async () => {
    const { attestation } = await hkProvider().inspect(`${HK}@2.5.0`);
    expect(attestation).toMatchObject({
      kind: 'packslip',
      signerIdentity: 'https://github.com/jdx/hk/.github/workflows/release.yml',
      issuer: 'https://token.actions.githubusercontent.com',
      signedAtVerified: true,
      trustTier: 'trusted-publisher',
      evidence: ['packslip', 'sigstore', 'sigstore-transparency'],
    });
    expect(attestation?.record).toMatchObject({
      signer: { scheme: 'sigstore-oidc', repository_id: '922514152' },
      logged: true,
    });
  });

  it('keeps the same signer across resolutions', async () => {
    const first = await hkProvider().inspect(`${HK}@2.5.0`);
    const record = first.attestation?.record ?? {};
    const again = await hkProvider({ prior: { [HK]: record } }).inspect(
      `${HK}@2.5.0`,
    );
    expect(again.attestation?.record).toEqual(record);
  });

  it('finds what the lock remembered however the host spelled the key', async () => {
    const first = await hkProvider().inspect(`${HK}@2.5.0`);
    const record = first.attestation?.record ?? {};
    const signer = record.signer as JsonObject;
    const moved = {
      ...record,
      signer: { ...signer, identity: '.github/workflows/old.yml' },
    };
    // A versioned key is the same package as the versionless one.
    await expect(
      hkProvider({ prior: { [`${HK}@2.4.0`]: moved } }).inspect(`${HK}@2.5.0`),
    ).rejects.toMatchObject({ code: 'TRUST_CHANGE_REQUIRES_APPROVAL' });
  });

  it('refuses outright a release from a different repository than the one remembered', async () => {
    const first = await hkProvider().inspect(`${HK}@2.5.0`);
    const record = first.attestation?.record ?? {};
    const signer = record.signer as JsonObject;
    // The lock says repository 1 signed the last release: a recreated name.
    const error = await hkProvider({
      prior: { [HK]: { ...record, signer: { ...signer, repository_id: '1' } } },
    })
      .inspect(`${HK}@2.5.0`)
      .then(
        () => undefined,
        (caught: Error) => caught,
      );
    expect(error).toMatchObject({ code: 'SIGNATURE_VERIFICATION_FAILED' });
    expect(error?.message).toMatch(/different repository/u);
  });

  it('asks a person to approve a signer that moved to another workflow, and accepts once approved', async () => {
    const first = await hkProvider().inspect(`${HK}@2.5.0`);
    const record = first.attestation?.record ?? {};
    const signer = record.signer as JsonObject;
    const prior = {
      [HK]: {
        ...record,
        signer: { ...signer, identity: '.github/workflows/old-release.yml' },
      },
    };
    const error = await hkProvider({ prior })
      .inspect(`${HK}@2.5.0`)
      .then(
        () => undefined,
        (caught: Error) => caught,
      );
    expect(error).toMatchObject({ code: 'TRUST_CHANGE_REQUIRES_APPROVAL' });
    expect(error?.message).toMatch(/workflow/u);
    const id = /proposal ([0-9a-f]{16})/u.exec(error?.message ?? '')?.[1];
    expect(id).toBeDefined();

    const approved = await hkProvider({
      prior,
      settings: { approvals: [id ?? ''] },
    }).inspect(`${HK}@2.5.0`);
    expect(approved.attestation?.record).toEqual(record);
  });

  it('applies a pin however the project name’s case was written', async () => {
    // GitHub names are case-insensitive. A pin that was only matched exactly
    // would be skipped without a word and the release accepted on forge trust.
    for (const spelling of ['github.com/jdx/HK', 'github.com/Jdx/hk']) {
      await expect(
        hkProvider({
          settings: {
            trust: { [spelling]: { pin: ['ps1_kwhjac5qpc45qetfh6ppwisi6a'] } },
          },
        }).inspect(`${HK}@2.5.0`),
      ).rejects.toMatchObject({ code: 'SIGNATURE_VERIFICATION_FAILED' });
    }
  });

  it('refuses a signer pin that names someone else, before trusting the release', async () => {
    await expect(
      hkProvider({
        settings: {
          trust: {
            'github.com/jdx/hk': { pin: ['ps1_kwhjac5qpc45qetfh6ppwisi6a'] },
          },
        },
      }).inspect(`${HK}@2.5.0`),
    ).rejects.toMatchObject({ code: 'SIGNATURE_VERIFICATION_FAILED' });
  });
});

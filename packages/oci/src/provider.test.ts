import { describe, expect, it } from 'vitest';
import { OciRegistryProvider, parseOciPurl } from './provider.js';

/**
 * The registry is faked, so these pin the decisions rather than the network:
 * how a PURL becomes a registry address, what is refused, and that a tag never
 * becomes identity.
 */

const INDEX = {
  schemaVersion: 2,
  manifests: [
    {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: `sha256:${'a'.repeat(64)}`,
      size: 100,
    },
  ],
};

function registry(
  body: unknown = INDEX,
  contentType = 'application/vnd.oci.image.index.v1+json',
) {
  const requests: string[] = [];
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const fetchImplementation = (async (url: URL | string) => {
    const href = String(url);
    requests.push(href);
    if (href.endsWith('/tags/list'))
      return new Response(JSON.stringify({ tags: ['1.0', '2.0'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': contentType },
    });
  }) as unknown as typeof fetch;
  return { requests, fetchImplementation };
}

describe('addressing', () => {
  it('reads a bare name as a Docker Hub official image', () => {
    // `docker pull alpine` means library/alpine; a CLI that required the
    // qualifier for that would be unusable by hand.
    expect(parseOciPurl('pkg:oci/alpine')).toMatchObject({
      registry: 'registry-1.docker.io',
      repository: 'library/alpine',
    });
    expect(parseOciPurl('pkg:oci/library/alpine').repository).toBe(
      'library/alpine',
    );
  });

  it('honours repository_url for any registry', () => {
    expect(
      parseOciPurl('pkg:oci/jq?repository_url=ghcr.io/homebrew/core/jq'),
    ).toMatchObject({ registry: 'ghcr.io', repository: 'homebrew/core/jq' });
  });

  it('refuses a repository_url that could redirect or leak credentials', () => {
    // This value becomes the origin of an outbound request, so it is validated
    // rather than trusted.
    for (const bad of [
      'pkg:oci/x?repository_url=http://ghcr.io/a/b',
      'pkg:oci/x?repository_url=https://user:pass@ghcr.io/a/b',
      'pkg:oci/x?repository_url=https://ghcr.io/a/b?next=evil',
      'pkg:oci/x?repository_url=https://ghcr.io/A/B',
    ])
      expect(() => parseOciPurl(bad), bad).toThrow();
  });

  it('refuses a version that is not a manifest digest', () => {
    // Invariant 1: a tag locates a history, a digest identifies bytes.
    expect(() => parseOciPurl('pkg:oci/alpine@3.19')).toThrow(/digest/u);
    expect(() => parseOciPurl('pkg:oci/alpine@sha256:short')).toThrow();
  });

  it('refuses a malformed tag', () => {
    expect(() => parseOciPurl('pkg:oci/alpine?tag=-bad')).toThrow(/tag/u);
    expect(() =>
      parseOciPurl(`pkg:oci/alpine?tag=${'a'.repeat(200)}`),
    ).toThrow();
  });
});

describe('browsing and pinning', () => {
  it('lists tags as browsable references', async () => {
    const { fetchImplementation } = registry();
    const provider = new OciRegistryProvider({ fetch: fetchImplementation });
    const found = await provider.enumerate('pkg:oci/library/alpine');
    expect(found).toHaveLength(2);
    for (const purl of found) expect(purl).toContain('tag=');
  });

  it('resolves a tag to a digest, and the digest is the version', async () => {
    const { fetchImplementation } = registry();
    const provider = new OciRegistryProvider({ fetch: fetchImplementation });
    const inspection = await provider.inspect(
      'pkg:oci/library/alpine?tag=3.19',
    );
    // The mutable tag must not survive into identity.
    expect(inspection.package.nativeVersion).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(inspection.package.identity.exactPurl).not.toContain('tag=');
    expect(inspection.package.identity.exactPurl).toContain('sha256');
  });

  it('accepts an index whose body omits mediaType', async () => {
    // The OCI specification carries mediaType on the response; ghcr.io omits
    // it from the document. Validating on the body alone rejected real tags.
    const { fetchImplementation } = registry(INDEX);
    const provider = new OciRegistryProvider({ fetch: fetchImplementation });
    await expect(
      provider.inspect('pkg:oci/library/alpine?tag=3.19'),
    ).resolves.toBeTruthy();
  });

  it('rejects a document that contradicts the type it was served as', async () => {
    const { fetchImplementation } = registry(
      { ...INDEX, mediaType: 'application/vnd.oci.image.manifest.v1+json' },
      'application/vnd.oci.image.index.v1+json',
    );
    const provider = new OciRegistryProvider({ fetch: fetchImplementation });
    await expect(
      provider.inspect('pkg:oci/library/alpine?tag=3.19'),
    ).rejects.toThrow(/served as/u);
  });

  it('needs a tag or a digest to inspect', async () => {
    const { fetchImplementation } = registry();
    const provider = new OciRegistryProvider({ fetch: fetchImplementation });
    await expect(provider.inspect('pkg:oci/library/alpine')).rejects.toThrow(
      /neither a tag nor a digest/u,
    );
  });
});

describe('materialise image layout', () => {
  const configBytes = new TextEncoder().encode(
    '{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}',
  );
  const layerBytes = new TextEncoder().encode('layer-bytes');
  // Digests pinned so a fixture drift fails loudly rather than silently.
  const configDigest =
    'sha256:c5b1d63604f273462ef36fadac3182d43ae6a6138731cf594b314835cf1c034f';
  const layerDigest =
    'sha256:d50fdce899b75695aa4d7bfb84396fbe2fdee1c92f0dd621d245156cad6f51c0';
  const manifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: {
      mediaType: 'application/vnd.oci.image.config.v1+json',
      digest: configDigest,
      size: configBytes.byteLength,
    },
    layers: [
      {
        mediaType: 'application/vnd.oci.image.layer.v1.tar',
        digest: layerDigest,
        size: layerBytes.byteLength,
      },
    ],
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));

  function materializeFetch(): typeof fetch {
    return (async (url: URL | string) => {
      const href = String(url);
      if (href.includes('/manifests/'))
        return new Response(manifestBytes, {
          status: 200,
          headers: {
            'content-type': 'application/vnd.oci.image.manifest.v1+json',
          },
        });
      if (href.includes(`/blobs/${encodeURIComponent(configDigest)}`))
        return new Response(configBytes, { status: 200 });
      if (href.includes(`/blobs/${encodeURIComponent(layerDigest)}`))
        return new Response(layerBytes, { status: 200 });
      return new Response('missing', { status: 404 });
    }) as unknown as typeof fetch;
  }

  it('pulls config and layers into a digest-verified OCI layout tar', async () => {
    const provider = new OciRegistryProvider({ fetch: materializeFetch() });
    const record = await provider.fetchArtifactRecord(
      'pkg:oci/library/demo?tag=1.0',
    );
    const body = record.body as {
      digest: { algorithm: string; value: string };
      mediaType: string;
      imageDigest: string;
      size: number;
    };
    expect(body.mediaType).toBe('application/vnd.oci.image.layout.v1.tar');
    expect(body.digest.algorithm).toBe('sha256');
    expect(body.size).toBe(record.rawBody.byteLength);
    // Layout tar digest is over the packed bytes, not the image digest.
    expect(body.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(body.digest.value).not.toBe(
      body.imageDigest.slice('sha256:'.length),
    );

    // The tar must contain the layout markers and every blob by digest.
    const text = new TextDecoder().decode(record.rawBody);
    expect(text).toContain('oci-layout');
    expect(text).toContain('index.json');
    expect(text).toContain(configDigest.slice('sha256:'.length));
    expect(text).toContain(layerDigest.slice('sha256:'.length));
  });

  it('selects the host platform from a multi-arch index', async () => {
    const { selectPlatformManifest, hostPlatform } = await import(
      './provider.js'
    );
    const host = hostPlatform();
    const otherOs = host.os === 'linux' ? 'windows' : 'linux';
    const chosen = selectPlatformManifest([
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: `sha256:${'1'.repeat(64)}`,
        size: 1,
        platform: { os: otherOs, architecture: host.architecture },
      },
      {
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        digest: `sha256:${'2'.repeat(64)}`,
        size: 1,
        platform: {
          os: host.os,
          architecture: host.architecture,
        },
      },
    ]);
    expect(chosen?.digest).toBe(`sha256:${'2'.repeat(64)}`);
  });

  it('refuses an index with no matching platform when several are published', async () => {
    const { selectPlatformManifest } = await import('./provider.js');
    expect(
      selectPlatformManifest([
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: `sha256:${'1'.repeat(64)}`,
          size: 1,
          platform: { os: 'windows', architecture: 'amd64' },
        },
        {
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          digest: `sha256:${'2'.repeat(64)}`,
          size: 1,
          platform: { os: 'windows', architecture: 'arm64' },
        },
      ]),
    ).toBeUndefined();
  });
});

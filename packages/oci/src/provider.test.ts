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

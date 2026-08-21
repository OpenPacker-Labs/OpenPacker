import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalBytes } from '@openpacker/canonical';
import type { JsonValue, PackReceipt } from '@openpacker/contracts';
import { PACK_RECEIPT } from '../src/pack.js';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  publishPackedArtifact,
  yankRegistryVersion,
} from '../src/publish-client.js';
import { OpmError } from '../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function packedDir(bytes = new TextEncoder().encode('packed-bytes')) {
  const root = await mkdtemp(join(tmpdir(), 'opm-publish-client-'));
  roots.push(root);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const fileName = 'demo-1.0.0.tgz';
  await writeFile(join(root, fileName), bytes);
  const receipt: PackReceipt = {
    packReceiptVersion: '1',
    strategy: 'standard',
    target: {
      purlType: 'npm',
      identifier: 'demo',
      version: '1.0.0',
    },
    normalizedManifestDigest: {
      algorithm: 'sha256',
      value: 'b'.repeat(64),
    },
    commands: [],
    artifacts: [
      {
        descriptorId: `sha256:${digest}`,
        digest: { algorithm: 'sha256', value: digest },
        size: bytes.byteLength,
        mediaType: 'application/vnd.npm.package+gzip',
        artifactType: 'application/vnd.npm.package+gzip',
        fileName,
        nativeRole: 'distribution',
        locations: [],
        referrers: [],
        externalRefs: [],
      },
    ],
    semanticLoss: [],
  };
  await writeFile(
    join(root, PACK_RECEIPT),
    canonicalBytes(receipt as unknown as JsonValue),
  );
  return { root, bytes, digest, receipt };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(canonicalBytes(body as JsonValue), {
    status,
    headers: {
      'content-type': 'application/json',
      'prex-version': '1.0-draft',
    },
  });
}

describe('publishPackedArtifact', () => {
  it('refuses --offline before any fetch', async () => {
    const { root } = await packedDir();
    let fetched = false;
    await expect(
      publishPackedArtifact({
        from: root,
        registry: 'http://127.0.0.1:7337/',
        offline: true,
        fetch: async () => {
          fetched = true;
          return jsonResponse({});
        },
      }),
    ).rejects.toMatchObject({
      name: 'OpmError',
      code: 'OFFLINE',
    } satisfies Partial<OpmError>);
    expect(fetched).toBe(false);
  });

  it('refuses npmjs, PyPI, and crates.io origins', async () => {
    const { root } = await packedDir();
    for (const registry of [
      'https://registry.npmjs.org/',
      'https://pypi.org/simple',
      'https://crates.io/api/v1/crates',
      'https://www.pypi.org/',
    ]) {
      await expect(
        publishPackedArtifact({
          from: root,
          registry,
          fetch: async () => jsonResponse({}),
        }),
      ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    }
  });

  it('requires a PREX registry URL', async () => {
    const { root } = await packedDir();
    await expect(
      publishPackedArtifact({ from: root, env: {} }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('POSTs a PublishRequest for packed native bytes to the PREX registry', async () => {
    const { root, digest, bytes } = await packedDir();
    const posted: { url?: string; body?: unknown } = {};
    const result = await publishPackedArtifact({
      from: root,
      registry: 'http://127.0.0.1:17337/',
      fetch: async (input, init) => {
        posted.url = String(input);
        posted.body = JSON.parse(
          new TextDecoder().decode(init?.body as Uint8Array),
        );
        return jsonResponse(posted.body);
      },
    });
    expect(posted.url).toBe('http://127.0.0.1:17337/v1/openpacker/publish');
    expect(posted.body).toEqual(
      expect.objectContaining({
        descriptor: expect.objectContaining({
          digest: { algorithm: 'sha256', value: digest },
          size: bytes.byteLength,
          nativeRole: 'distribution',
        }),
        location: expect.objectContaining({
          transport: 'file',
          annotations: expect.objectContaining({
            'openpacker.package.name': 'demo',
            'openpacker.package.version': '1.0.0',
          }),
        }),
      }),
    );
    expect(result.response.descriptor.digest.value).toBe(digest);
  });

  it('reuses packProject when packing before publish', async () => {
    configureDefaultAdapters();
    const root = await mkdtemp(join(tmpdir(), 'opm-publish-pack-'));
    roots.push(root);
    await writeFile(
      join(root, 'package.json'),
      '{"name":"demo","version":"1.0.0"}\n',
    );
    await writeFile(join(root, 'index.js'), 'export const value = 1;\n');
    const posted: { url?: string } = {};
    const result = await publishPackedArtifact({
      pack: {
        root,
        ecosystem: 'npm',
        version: '1.0.0',
        name: 'demo',
        outputDirectory: join(root, 'out'),
      },
      registry: 'http://127.0.0.1:17337/',
      fetch: async (input, init) => {
        posted.url = String(input);
        const body = JSON.parse(
          new TextDecoder().decode(init?.body as Uint8Array),
        );
        return jsonResponse(body);
      },
    });
    expect(posted.url).toBe('http://127.0.0.1:17337/v1/openpacker/publish');
    expect(result.request.location.annotations).toEqual(
      expect.objectContaining({
        'openpacker.package.name': 'demo',
        'openpacker.package.version': '1.0.0',
      }),
    );
  });
});

describe('yankRegistryVersion', () => {
  it('refuses --offline, native registries, and wildcard versions', async () => {
    await expect(
      yankRegistryVersion({
        purl: 'pkg:npm/demo@1.0.0',
        registry: 'http://127.0.0.1:7337/',
        offline: true,
      }),
    ).rejects.toMatchObject({ code: 'OFFLINE' });
    await expect(
      yankRegistryVersion({
        purl: 'pkg:npm/demo@1.0.0',
        registry: 'https://registry.npmjs.org/',
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(
      yankRegistryVersion({
        purl: 'pkg:npm/demo',
        registry: 'http://127.0.0.1:7337/',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SPEC' });
    await expect(
      yankRegistryVersion({
        purl: 'pkg:npm/demo@*',
        registry: 'http://127.0.0.1:7337/',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SPEC' });
  });

  it('POSTs a yanked lifecycle apply for an exact name+version', async () => {
    const posted: { url?: string; body?: unknown } = {};
    const applied = {
      eventVersion: '1' as const,
      eventId: 'yank-1',
      subject: {
        canonicalPurl: 'pkg:npm/demo',
        exactPurl: 'pkg:npm/demo@1.0.0',
        purlType: 'npm',
        name: 'demo',
        version: '1.0.0',
        qualifiers: {},
        nativeCoordinates: [],
        aliases: [],
        sourceRefs: [],
        publisherRefs: [],
        externalRefs: [],
      },
      action: 'yanked' as const,
      effectiveAt: '2026-08-20T00:00:00Z',
      issuedAt: '2026-08-20T00:00:00Z',
      actor: { type: 'uri' as const, value: 'urn:openpacker:opm' },
      authority: 'registry' as const,
      reasonCode: 'YANKED',
      replacementRefs: [],
      sourceSnapshot: { algorithm: 'sha256' as const, value: 'c'.repeat(64) },
      evidenceRefs: [],
      externalRefs: [],
    };
    const result = await yankRegistryVersion({
      purl: 'pkg:npm/demo@1.0.0',
      registry: 'http://127.0.0.1:17337/',
      reason: 'security',
      fetch: async (input, init) => {
        posted.url = String(input);
        posted.body = JSON.parse(
          new TextDecoder().decode(init?.body as Uint8Array),
        );
        return jsonResponse({ applied });
      },
    });
    expect(posted.url).toBe(
      'http://127.0.0.1:17337/v1/openpacker/lifecycle/apply',
    );
    expect(posted.body).toEqual(
      expect.objectContaining({
        action: 'yanked',
        reason: 'security',
        subject: expect.objectContaining({
          exactPurl: 'pkg:npm/demo@1.0.0',
          name: 'demo',
          version: '1.0.0',
        }),
      }),
    );
    expect(result.applied.action).toBe('yanked');
  });
});

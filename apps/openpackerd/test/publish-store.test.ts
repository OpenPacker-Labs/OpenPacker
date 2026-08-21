import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalBytes, canonicalDigest } from '@openpacker/canonical';
import type {
  ArtifactDescriptor,
  JsonValue,
  PackageManifest,
  PublishRequest,
  RegistryPublishRequest,
} from '@openpacker/contracts';
import { OperationError } from '../src/operations.js';
import { createStandaloneReferenceOperations } from '../src/reference.js';
import {
  createFilesystemPublishStore,
  type OperationContextLike,
} from '../src/publish-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function context(): OperationContextLike {
  return {
    signal: new AbortController().signal,
    correlationId: 'test',
    offline: false,
  };
}

async function artifactPublish(
  storeRoot: string,
  bytes: Uint8Array,
  name = 'demo',
  version = '1.0.0',
): Promise<{ request: PublishRequest; artifactPath: string; hex: string }> {
  const hex = digestOf(bytes);
  const artifactPath = join(storeRoot, 'incoming.tgz');
  await writeFile(artifactPath, bytes);
  const location = {
    transport: 'file' as const,
    uri: pathToFileURL(artifactPath).href,
    priority: 0,
    rangeSupported: true,
    annotations: {
      'openpacker.package.name': name,
      'openpacker.package.version': version,
      'openpacker.package.purlType': 'npm',
    },
  };
  const descriptor: ArtifactDescriptor = {
    descriptorId: `sha256:${hex}`,
    digest: { algorithm: 'sha256', value: hex },
    size: bytes.byteLength,
    mediaType: 'application/vnd.npm.package+gzip',
    artifactType: 'application/vnd.npm.package+gzip',
    fileName: 'demo-1.0.0.tgz',
    nativeRole: 'distribution',
    locations: [location],
    referrers: [],
    externalRefs: [],
  };
  return {
    request: { descriptor, location },
    artifactPath,
    hex,
  };
}

describe('filesystem publish store', () => {
  it('publishes bytes then reads them back by digest from the store directory', async () => {
    const root = await tempDir('openpackerd-publish-');
    const store = createFilesystemPublishStore({ root });
    const bytes = new TextEncoder().encode('native-artifact');
    const { request, hex } = await artifactPublish(root, bytes);
    await store.publish(request, context());
    const stored = await readFile(join(root, 'blobs', 'sha256', hex));
    expect(Buffer.from(stored)).toEqual(Buffer.from(bytes));
    expect(
      Buffer.from(await store.readBlob(request.descriptor.digest)),
    ).toEqual(Buffer.from(bytes));
  });

  it('treats identical re-publish of the same version as idempotent', async () => {
    const root = await tempDir('openpackerd-publish-idem-');
    const store = createFilesystemPublishStore({ root });
    const bytes = new TextEncoder().encode('same-bytes');
    const { request } = await artifactPublish(root, bytes);
    const first = await store.publish(request, context());
    const second = await store.publish(request, context());
    expect(second).toEqual(first);
  });

  it('rejects a digest-changing re-publish of the same name and version', async () => {
    const root = await tempDir('openpackerd-publish-conflict-');
    const store = createFilesystemPublishStore({ root });
    const first = await artifactPublish(
      root,
      new TextEncoder().encode('first-bytes'),
    );
    await store.publish(first.request, context());
    const second = await artifactPublish(
      root,
      new TextEncoder().encode('other-bytes'),
    );
    await expect(
      store.publish(second.request, context()),
    ).rejects.toMatchObject({
      name: 'OperationError',
      code: 'DIGEST_MISMATCH',
    } satisfies Partial<OperationError>);
  });

  it('yanks a published version so the store marks it ineligible', async () => {
    const root = await tempDir('openpackerd-publish-yank-');
    const store = createFilesystemPublishStore({ root });
    const { request } = await artifactPublish(
      root,
      new TextEncoder().encode('yank-me'),
    );
    await store.publish(request, context());
    const before = await store.getRecord('demo', '1.0.0');
    expect(before?.lifecycle.eligible).toBe(true);
    expect(before?.lifecycle.status).toBe('published');
    await store.lifecycleApply(
      {
        eventVersion: '1',
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
        action: 'yanked',
        effectiveAt: '2026-08-20T00:00:00Z',
        issuedAt: '2026-08-20T00:00:00Z',
        actor: { type: 'uri', value: 'urn:openpacker:opm' },
        authority: 'registry',
        reasonCode: 'YANKED',
        reason: 'security',
        replacementRefs: [],
        sourceSnapshot: { algorithm: 'sha256', value: 'd'.repeat(64) },
        evidenceRefs: [],
        externalRefs: [],
      },
      context(),
    );
    const after = await store.getRecord('demo', '1.0.0');
    expect(after?.lifecycle.status).toBe('yanked');
    expect(after?.lifecycle.eligible).toBe(false);
  });

  it('re-derives a RegistryPublishRequest digest and refuses a caller lie', async () => {
    const root = await tempDir('openpackerd-publish-manifest-');
    const store = createFilesystemPublishStore({ root });
    const manifest: PackageManifest = {
      packageManifestVersion: '1',
      name: 'demo',
      version: '2.0.0',
      distributions: [
        { purlType: 'npm', identifier: 'demo', version: '2.0.0' },
      ],
    };
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const real = await canonicalDigest(manifest as unknown as JsonValue);
    const request: RegistryPublishRequest = {
      manifest,
      manifestDigest: { algorithm: 'sha256', value: '0'.repeat(64) },
    };
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const bytes = canonicalBytes(request as unknown as JsonValue);
    const hex = digestOf(bytes);
    const path = join(root, 'manifest-publish.json');
    await writeFile(path, bytes);
    const location = {
      transport: 'file' as const,
      uri: pathToFileURL(path).href,
      priority: 0,
      rangeSupported: true,
    };
    await expect(
      store.publish(
        {
          descriptor: {
            descriptorId: `sha256:${hex}`,
            digest: { algorithm: 'sha256', value: hex },
            size: bytes.byteLength,
            mediaType: 'application/json',
            artifactType: 'application/vnd.prex.registry-publish-request+json',
            nativeRole: 'manifest',
            locations: [location],
            referrers: [],
            externalRefs: [],
          },
          location,
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
    expect(real.value).toHaveLength(64);
  });

  it('refuses offline publish and locations without identity', async () => {
    const root = await tempDir('openpackerd-publish-offline-');
    const store = createFilesystemPublishStore({ root });
    const { request } = await artifactPublish(
      root,
      new TextEncoder().encode('offline'),
    );
    await expect(
      store.publish(request, { ...context(), offline: true }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    const noIdentity = {
      ...request,
      location: {
        transport: request.location.transport,
        uri: request.location.uri,
        priority: request.location.priority,
        rangeSupported: request.location.rangeSupported,
      },
    };
    await expect(store.publish(noIdentity, context())).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
});

describe('reference daemon publish opt-in', () => {
  it('refuses a relative OPENPACKER_PUBLISH_STORE', async () => {
    expect(() =>
      createFilesystemPublishStore({ root: 'relative-store' }),
    ).toThrow(/absolute directory/u);
    await expect(
      createStandaloneReferenceOperations(undefined, {
        env: { OPENPACKER_PUBLISH_STORE: 'relative-store' },
      }),
    ).rejects.toThrow(/absolute directory/u);
  });

  it('stays unavailable without OPENPACKER_PUBLISH_STORE', async () => {
    const operations = await createStandaloneReferenceOperations(undefined, {
      env: {},
    });
    await expect(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      operations.publish({} as never, context() as never),
    ).rejects.toMatchObject({
      code: 'PROVIDER_CAPABILITY_MISSING',
      status: 501,
    });
    await expect(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      operations.lifecycleApply({} as never, context() as never),
    ).rejects.toMatchObject({
      code: 'PROVIDER_CAPABILITY_MISSING',
    });
  });

  it('publishes when OPENPACKER_PUBLISH_STORE is an absolute directory', async () => {
    const root = await tempDir('openpackerd-publish-env-');
    const operations = await createStandaloneReferenceOperations(undefined, {
      env: { OPENPACKER_PUBLISH_STORE: root },
    });
    const bytes = new TextEncoder().encode('from-env');
    const { request, hex } = await artifactPublish(root, bytes);
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    await operations.publish(request, context() as never);
    const stored = await readFile(join(root, 'blobs', 'sha256', hex));
    expect(Buffer.from(stored)).toEqual(Buffer.from(bytes));
  });
});

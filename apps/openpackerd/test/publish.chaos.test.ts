import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactDescriptor } from '@openpacker/contracts';
import { createFilesystemPublishStore } from '../src/publish-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('publish store chaos', () => {
  it('leaves no published version when killed after blob put and before commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openpackerd-publish-chaos-'));
    roots.push(root);
    const bytes = new TextEncoder().encode('partial-publish');
    const hex = createHash('sha256').update(bytes).digest('hex');
    const artifactPath = join(root, 'incoming.tgz');
    await writeFile(artifactPath, bytes);
    const location = {
      transport: 'file' as const,
      uri: pathToFileURL(artifactPath).href,
      priority: 0,
      rangeSupported: true,
      annotations: {
        'openpacker.package.name': 'demo',
        'openpacker.package.version': '1.0.0',
        'openpacker.package.purlType': 'npm',
      },
    };
    const descriptor: ArtifactDescriptor = {
      descriptorId: `sha256:${hex}`,
      digest: { algorithm: 'sha256', value: hex },
      size: bytes.byteLength,
      mediaType: 'application/octet-stream',
      artifactType: 'application/octet-stream',
      fileName: 'demo.tgz',
      nativeRole: 'distribution',
      locations: [location],
      referrers: [],
      externalRefs: [],
    };
    const killed = createFilesystemPublishStore({
      root,
      afterBlobBeforeCommit: () => {
        throw new Error('killed mid-put');
      },
    });
    await expect(
      killed.publish(
        { descriptor, location },
        {
          signal: new AbortController().signal,
          correlationId: 'chaos',
          offline: false,
        },
      ),
    ).rejects.toThrow(/killed mid-put/u);
    const retry = createFilesystemPublishStore({ root });
    expect(await retry.getRecord('demo', '1.0.0')).toBeUndefined();
    await retry.publish(
      { descriptor, location },
      {
        signal: new AbortController().signal,
        correlationId: 'retry',
        offline: false,
      },
    );
    const record = await retry.getRecord('demo', '1.0.0');
    expect(record?.lifecycle.status).toBe('published');
    expect(record?.artifactDigest.value).toBe(hex);
  });
});

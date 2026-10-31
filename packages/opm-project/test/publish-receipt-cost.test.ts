import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PACK_RECEIPT } from '../src/pack.js';
import { publishPackedArtifact } from '../src/publish-client.js';

/**
 * A pack receipt is read of at most 4 MiB, and its parse may cost what an
 * honest document of that many bytes may (`documentParseLimits`: 64 MiB). The
 * directory is the one `--from` names, and `{"1023":0}` is 10 bytes and an
 * elements store of 40 KB (ADR 0044, "Documents other than packuments").
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('the pack receipt opm publish reads', () => {
  it('is refused when it would cost more to hold than such a receipt may', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-receipt-cost-'));
    roots.push(root);
    // 10,000 objects in 110 KB, charged 400 MB.
    await writeFile(
      join(root, PACK_RECEIPT),
      JSON.stringify({
        artifacts: Array.from({ length: 10_000 }, () => ({ '1023': 0 })),
      }),
    );
    let fetched = false;
    await expect(
      publishPackedArtifact({
        from: root,
        registry: 'http://127.0.0.1:7337/',
        fetch: async () => {
          fetched = true;
          return new Response('{}');
        },
      }),
    ).rejects.toMatchObject({
      name: 'OpmError',
      code: 'INVALID_SPEC',
      message:
        'Invalid pack receipt: JSON document exceeds 67108864 bytes of parsed size',
    });
    expect(fetched).toBe(false);
  });
});

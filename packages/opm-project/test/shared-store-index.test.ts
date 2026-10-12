import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packTarGzip } from '@openpacker/project-io';
import { adoptSharedEntry, publishSharedEntry } from '../src/shared-store.js';
import {
  INTEGRITY_INDEX,
  lookupArchiveDigest,
  recordArchiveDigest,
} from '../src/shared-store-index.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'store-index-'));
  temps.push(dir);
  return dir;
}

const KEY = `sha512-${'ab'.repeat(64)}`;
const DIGEST = `sha256:${'cd'.repeat(32)}`;

describe('the integrity index', () => {
  it('finds nothing in a store that has no index yet', async () => {
    expect(await lookupArchiveDigest(await root(), KEY)).toBeUndefined();
  });

  it('remembers which archive digest an integrity key names', async () => {
    const dir = await root();
    await recordArchiveDigest(dir, KEY, DIGEST);
    expect(await lookupArchiveDigest(dir, KEY)).toBe(DIGEST);
    expect(
      await lookupArchiveDigest(dir, `sha512-${'ee'.repeat(64)}`),
    ).toBeUndefined();
  });

  it('records the same thing twice without complaint', async () => {
    const dir = await root();
    await recordArchiveDigest(dir, KEY, DIGEST);
    await expect(
      recordArchiveDigest(dir, KEY, DIGEST),
    ).resolves.toBeUndefined();
  });

  it('treats a malformed record as a miss, so the archive is fetched again', async () => {
    const dir = await root();
    await recordArchiveDigest(dir, KEY, DIGEST);
    await writeFile(join(dir, INTEGRITY_INDEX, KEY), 'not a digest');
    expect(await lookupArchiveDigest(dir, KEY)).toBeUndefined();
  });

  it('will not turn a key into a path', async () => {
    const dir = await root();
    for (const bad of ['../x', 'sha512-zz', 'sha512-ab/../../x', ''])
      await expect(lookupArchiveDigest(dir, bad), bad).rejects.toMatchObject({
        code: 'INVALID_DIGEST',
      });
    await expect(
      recordArchiveDigest(dir, '../x', DIGEST),
    ).rejects.toMatchObject({
      code: 'INVALID_DIGEST',
    });
  });
});

describe('publishing and adopting a shared entry', () => {
  const archive = () => {
    const bytes = packTarGzip([
      {
        path: 'package/package.json',
        contents: new TextEncoder().encode('{}'),
      },
    ]);
    return {
      bytes,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    };
  };

  it('adopts what was published, and nothing that was not', async () => {
    const dir = await root();
    const { bytes, digest } = archive();
    expect(await adoptSharedEntry(dir, digest)).toBeUndefined();
    const published = await publishSharedEntry({
      sharedRoot: dir,
      digest,
      format: 'tar+gzip',
      bytes,
    });
    expect(await adoptSharedEntry(dir, digest)).toEqual(published);
  });

  it('seals what it publishes unless asked not to', async () => {
    const dir = await root();
    const sealed = archive();
    const entry = await publishSharedEntry({
      sharedRoot: dir,
      digest: sealed.digest,
      format: 'tar+gzip',
      bytes: sealed.bytes,
    });
    expect(
      (await stat(join(entry.path, 'package/package.json'))).mode & 0o222,
    ).toBe(0);

    const scratch = await root();
    const open = await publishSharedEntry({
      sharedRoot: scratch,
      digest: sealed.digest,
      format: 'tar+gzip',
      bytes: sealed.bytes,
      seal: false,
    });
    expect(
      (await stat(join(open.path, 'package/package.json'))).mode & 0o200,
    ).not.toBe(0);
  });

  it('refuses bytes that are not the digest named', async () => {
    const dir = await root();
    const { bytes } = archive();
    await expect(
      publishSharedEntry({
        sharedRoot: dir,
        digest: DIGEST,
        format: 'tar+gzip',
        bytes,
      }),
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
    expect(
      (await readdir(dir)).filter((name) => !name.startsWith('.')),
    ).toEqual([]);
  });
});

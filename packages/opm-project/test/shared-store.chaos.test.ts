import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packTarGzip } from '@openpacker/project-io';
import { storeKeyFromDigest } from '../src/index.js';
import {
  materializeThroughSharedStore,
  sharedStoreRoot,
} from '../src/shared-store.js';

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function fixtureArchive(): Uint8Array {
  return packTarGzip([
    {
      path: 'package/index.js',
      contents: new TextEncoder().encode('export const chaos = true;\n'),
    },
  ]);
}

function archiveDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

describe('shared store chaos', () => {
  it('retries after a kill between shared write and project link without refetching', async () => {
    const sharedHome = await tempDir('opm-shared-kill-');
    const projectRoot = await tempDir('opm-proj-kill-');
    const bytes = fixtureArchive();
    const digest = archiveDigest(bytes);
    const projectStorePath = join(projectRoot, storeKeyFromDigest(digest));
    let fetches = 0;
    const load = async (): Promise<Uint8Array> => {
      fetches += 1;
      return bytes;
    };

    await expect(
      materializeThroughSharedStore({
        digest,
        projectStorePath,
        bytes: load,
        format: 'tar+gzip',
        env: { OPM_STORE_HOME: sharedHome },
        linkFile: async () => {
          throw new Error('killed after shared write');
        },
      }),
    ).rejects.toThrow(/killed after shared write/u);

    const sharedEntry = join(sharedHome, storeKeyFromDigest(digest));
    expect((await lstat(sharedEntry)).isDirectory()).toBe(true);
    expect(fetches).toBe(1);

    const retryPath = join(
      await tempDir('opm-proj-kill-retry-'),
      storeKeyFromDigest(digest),
    );
    const retried = await materializeThroughSharedStore({
      digest,
      projectStorePath: retryPath,
      bytes: load,
      format: 'tar+gzip',
      env: { OPM_STORE_HOME: sharedHome },
    });
    expect(retried.shared).toBe(true);
    expect(fetches).toBe(1);
  });

  it('fails closed when the shared root is read-only and leaves no trusted digest dir', async () => {
    const sharedHome = await tempDir('opm-shared-ro-');
    await chmod(sharedHome, 0o555);
    const bytes = fixtureArchive();
    const digest = archiveDigest(bytes);
    const projectStorePath = join(
      await tempDir('opm-proj-ro-'),
      storeKeyFromDigest(digest),
    );

    await expect(
      materializeThroughSharedStore({
        digest,
        projectStorePath,
        bytes,
        format: 'tar+gzip',
        env: { OPM_STORE_HOME: sharedHome },
      }),
    ).rejects.toThrow();

    const leftover = join(sharedHome, storeKeyFromDigest(digest));
    await expect(lstat(leftover)).rejects.toMatchObject({ code: 'ENOENT' });
    await chmod(sharedHome, 0o755);
  });

  it('refuses a symlink as a shared store entry', async () => {
    const sharedHome = await tempDir('opm-shared-link-');
    const bytes = fixtureArchive();
    const digest = archiveDigest(bytes);
    const storeKey = storeKeyFromDigest(digest);
    const decoy = join(sharedHome, 'decoy');
    await mkdir(decoy);
    await writeFile(join(decoy, 'evil.js'), 'pwned\n');
    await symlink(decoy, join(sharedHome, storeKey));

    const projectStorePath = join(await tempDir('opm-proj-link-'), storeKey);
    await expect(
      materializeThroughSharedStore({
        digest,
        projectStorePath,
        bytes: async () => {
          throw new Error('must not fetch a linked store entry');
        },
        format: 'tar+gzip',
        env: { OPM_STORE_HOME: sharedHome },
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('refuses a symlink inside an otherwise named shared tree', async () => {
    const sharedHome = await tempDir('opm-shared-inner-link-');
    const projectRoot = await tempDir('opm-proj-inner-link-');
    const bytes = fixtureArchive();
    const digest = archiveDigest(bytes);
    const env = { OPM_STORE_HOME: sharedHome };

    await materializeThroughSharedStore({
      digest,
      projectStorePath: join(projectRoot, storeKeyFromDigest(digest)),
      bytes,
      format: 'tar+gzip',
      env,
    });

    const sharedEntry = join(sharedHome, storeKeyFromDigest(digest));
    await symlink('/etc/passwd', join(sharedEntry, 'package', 'shadow'));

    await expect(
      materializeThroughSharedStore({
        digest,
        projectStorePath: join(
          await tempDir('opm-proj-inner-link2-'),
          storeKeyFromDigest(digest),
        ),
        bytes: async () => {
          throw new Error('must not fetch a tree that contains a symlink');
        },
        format: 'tar+gzip',
        env,
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('does not leave a digest dir after a failed first materialize', async () => {
    const sharedHome = await tempDir('opm-shared-fail-');
    const digest = archiveDigest(new Uint8Array([1, 2, 3, 4]));
    expect(sharedStoreRoot({ OPM_STORE_HOME: sharedHome })).toBe(sharedHome);

    await expect(
      materializeThroughSharedStore({
        digest,
        projectStorePath: join(
          await tempDir('opm-proj-fail-'),
          storeKeyFromDigest(digest),
        ),
        bytes: new Uint8Array([1, 2, 3, 4]),
        format: 'tar+gzip',
        env: { OPM_STORE_HOME: sharedHome },
      }),
    ).rejects.toThrow();

    await expect(
      lstat(join(sharedHome, storeKeyFromDigest(digest))),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

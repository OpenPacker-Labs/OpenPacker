/**
 * Collection of a provider's output through the directory handle the host
 * retained. `pack-provider.libc-at.test.ts` runs this file with every POSIX
 * child operation routed through the libc `*at()` backend, which is what macOS
 * uses; there `/dev/fd/N/<name>` names nothing (ADR 0045).
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DelegatedPackHostPlan } from '@openpacker/contracts';
import { openStablePath } from '@openpacker/project-io';
import {
  collectArtifacts,
  handleRelativeReads,
  type CollectionLimits,
} from './collect.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function output(): Promise<string> {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'op-pack-collect-'),
  );
  roots.push(root);
  const directory = join(root, 'out');
  await mkdir(directory);
  return directory;
}

const limits: CollectionLimits = {
  outputEntries: 64,
  artifacts: 16,
  artifactBytes: 1_024n,
  totalArtifactBytes: 4_096n,
  readChunkBytes: 7,
};

function plan(): DelegatedPackHostPlan {
  // SAFETY: only `artifacts` is read by a collection; the cast names that.
  return {
    artifacts: [
      {
        suffix: '.test',
        mediaType: 'application/x-test',
        nativeRole: 'distribution',
      },
      {
        basename: 'exact.bin',
        mediaType: 'application/octet-stream',
        nativeRole: 'metadata',
      },
    ],
  } as unknown as DelegatedPackHostPlan;
}

const sha256 = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

async function collect(
  directory: string,
  options: Partial<CollectionLimits> = {},
  reads = handleRelativeReads,
) {
  const handle = await openStablePath(directory);
  try {
    return await collectArtifacts(
      handle,
      directory,
      plan(),
      { ...limits, ...options },
      reads,
    );
  } finally {
    await handle.close();
  }
}

describe('collectArtifacts', () => {
  it('reports what it reported before collection was handle-relative', async () => {
    // Five artifacts, one of them 3 MiB, unicode names, and a directory and a
    // symlink that must be skipped. The expected digests were recorded from the
    // implementation that read /proc/self/fd/N paths, so this is the byte for
    // byte comparison, not a re-derivation: the archives are digest-pinned.
    const directory = await output();
    const big = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let index = 0; index < big.length; index += 1)
      big[index] = (index * 31 + 7) & 0xff;
    await writeFile(join(directory, 'big.test'), big);
    await writeFile(join(directory, 'z.test'), 'ascii');
    await writeFile(join(directory, 'ä.test'), 'umlaut');
    await writeFile(join(directory, 'empty.test'), '');
    await writeFile(
      join(directory, 'exact.bin'),
      Buffer.from([0, 1, 2, 3, 255]),
    );
    await writeFile(join(directory, 'ignored.txt'), 'not an artifact');
    await mkdir(join(directory, 'dir.test'));
    await symlink(join(directory, 'z.test'), join(directory, 'link.test'));
    const handle = await openStablePath(directory);
    try {
      const found = await collectArtifacts(handle, '/reported/out', plan(), {
        outputEntries: 4_096,
        artifacts: 256,
        artifactBytes: 1_073_741_824n,
        totalArtifactBytes: 2_147_483_648n,
        readChunkBytes: 64 * 1_024,
      });
      const row = (
        outputName: string,
        size: number,
        digest: string,
        mediaType: string,
        nativeRole: string,
      ) => ({
        outputName,
        size,
        digest: `sha256:${digest}`,
        mediaType,
        nativeRole,
        path: `/reported/out/${outputName}`,
      });
      expect(found).toEqual([
        row(
          'big.test',
          3_145_745,
          '27f3f0120d4a72b66e7b58152c631644bd689231ebd4487469b59226f1be13af',
          'application/x-test',
          'distribution',
        ),
        row(
          'empty.test',
          0,
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          'application/x-test',
          'distribution',
        ),
        row(
          'exact.bin',
          5,
          'ff5d8507b6a72bee2debce2c0054798deaccdc5d8a1b945b6280ce8aa9cba52e',
          'application/octet-stream',
          'metadata',
        ),
        row(
          'z.test',
          5,
          'c543ece81605c7d202121c62080a0db4020fc2c75bfac35d101d7f3e93c93949',
          'application/x-test',
          'distribution',
        ),
        row(
          'ä.test',
          6,
          '46265dd2e7076be5d1b793a7042ca66a0e7cbea186cdf38c335d6425ab6e01b4',
          'application/x-test',
          'distribution',
        ),
      ]);
    } finally {
      await handle.close();
    }
  });

  it('hashes the declared artifacts, in canonical order, and nothing else', async () => {
    const directory = await output();
    await writeFile(join(directory, 'z.test'), 'ascii');
    await writeFile(join(directory, 'ä.test'), 'umlaut');
    await writeFile(join(directory, 'exact.bin'), 'bytes');
    await writeFile(join(directory, 'ignored.txt'), 'no');
    await mkdir(join(directory, 'folder.test'));
    await symlink(join(directory, 'z.test'), join(directory, 'link.test'));
    const found = await collect(directory);
    expect(found.map((artifact) => artifact.outputName)).toEqual([
      'exact.bin',
      'z.test',
      'ä.test',
    ]);
    expect(found[1]).toEqual({
      path: join(directory, 'z.test'),
      mediaType: 'application/x-test',
      size: 5,
      digest: sha256('ascii'),
      nativeRole: 'distribution',
      outputName: 'z.test',
    });
    expect(found[0]).toMatchObject({
      nativeRole: 'metadata',
      digest: sha256('bytes'),
    });
  });

  it('keeps reading the retained directory after its pathname is replaced', async () => {
    const directory = await output();
    await writeFile(join(directory, 'stale.test'), 'stale');
    const handle = await openStablePath(directory);
    try {
      await rename(directory, `${directory}-moved`);
      await mkdir(directory);
      await writeFile(join(directory, 'replacement.test'), 'replacement');
      const found = await collectArtifacts(handle, directory, plan(), limits);
      expect(found.map((artifact) => artifact.outputName)).toEqual([
        'stale.test',
      ]);
      expect(found[0]?.digest).toBe(sha256('stale'));
    } finally {
      await handle.close();
    }
  });

  it('reads the listing with the entry bound, never the whole directory', async () => {
    const directory = await output();
    let asked: number | undefined;
    await collect(
      directory,
      { outputEntries: 9 },
      {
        ...handleRelativeReads,
        list: async (handle, limit) => {
          asked = limit;
          return handleRelativeReads.list(handle, limit);
        },
      },
    );
    expect(asked).toBe(9);
  });

  it('refuses a directory with more entries than the bound', async () => {
    const directory = await output();
    for (const name of ['a', 'b', 'c'])
      await writeFile(join(directory, `${name}.tmp`), '');
    await expect(collect(directory, { outputEntries: 2 })).rejects.toThrow(
      /exceeds 2 entries/u,
    );
  });

  it('refuses the host receipt name', async () => {
    const directory = await output();
    await writeFile(join(directory, 'opm-pack-receipt.json'), '{}');
    await expect(collect(directory)).rejects.toThrow(/host receipt/u);
  });

  it('refuses too many artifacts and too many bytes, single and total', async () => {
    const directory = await output();
    for (const name of ['a', 'b', 'c'])
      await writeFile(join(directory, `${name}.test`), '1234');
    await expect(collect(directory, { artifacts: 2 })).rejects.toThrow(
      /exceeds 2 artifacts/u,
    );
    await expect(collect(directory, { artifactBytes: 3n })).rejects.toThrow(
      /exceeds 3 bytes: a\.test/u,
    );
    await expect(
      collect(directory, { artifactBytes: 4n, totalArtifactBytes: 11n }),
    ).rejects.toThrow(/exceed 11 total bytes/u);
  });

  it('refuses a name listed as a file that has become a symlink', async () => {
    const directory = await output();
    await writeFile(join(directory, 'real'), 'secret');
    await symlink(join(directory, 'real'), join(directory, 'demo.test'));
    const listed = (
      await handleRelativeReads.list(await openStablePath(directory), 8)
    ).entries.map((entry) =>
      entry.name === 'demo.test'
        ? Object.assign(Object.create(entry), {
            name: 'demo.test',
            isFile: () => true,
          })
        : entry,
    );
    await expect(
      collect(
        directory,
        {},
        {
          ...handleRelativeReads,
          list: async () => ({ entries: listed, exceeded: false }),
        },
      ),
    ).rejects.toThrow(/not a regular file: demo\.test/u);
  });

  it('refuses a file replaced between the listing and the open', async () => {
    const directory = await output();
    await writeFile(join(directory, 'demo.test'), 'first');
    // Keep the first file's inode alive, so the replacement cannot reuse it.
    await link(join(directory, 'demo.test'), `${directory}-kept`);
    let swapped = false;
    await expect(
      collect(
        directory,
        {},
        {
          ...handleRelativeReads,
          open: async (handle, name) => {
            if (!swapped) {
              swapped = true;
              await rm(join(directory, name));
              await writeFile(join(directory, name), 'second');
            }
            return handleRelativeReads.open(handle, name);
          },
        },
      ),
    ).rejects.toThrow(/changed while opening: demo\.test/u);
  });

  it('refuses a file that grows while it is read', async () => {
    const directory = await output();
    await writeFile(join(directory, 'demo.test'), Buffer.alloc(1_024));
    let grown = false;
    await expect(
      collect(
        directory,
        { artifactBytes: 1_024n, readChunkBytes: 1 },
        {
          ...handleRelativeReads,
          open: async (handle, name) => {
            const file = await handleRelativeReads.open(handle, name);
            if (!grown) {
              grown = true;
              const writer = await open(
                join(directory, name),
                constants.O_WRONLY | constants.O_APPEND,
              );
              await writer.write('x');
              await writer.close();
            }
            return file;
          },
        },
      ),
    ).rejects.toThrow(/exceeds 1024 bytes while hashing: demo\.test/u);
  });
});

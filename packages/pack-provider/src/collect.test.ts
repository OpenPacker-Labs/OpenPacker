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

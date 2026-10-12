import {
  appendFile,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_LIMITS,
  WorkspaceError,
  compileWorkspacePatterns,
} from '@openpacker/adapter-core';
import { openChild, readDirChildWithTypes } from '@openpacker/project-io';
import { openStableDirectory } from '../src/paths.js';
import { walkMembers, type WalkIo } from '../src/workspace/walk.js';
import { cleanup, scratch } from './workspace-tree.js';

afterEach(cleanup);

/**
 * Walk `patterns` over `root` with the real calls, except as `io` replaces them.
 * The replacements change the tree at the one moment that matters: after a
 * directory has been listed and before its entries are opened.
 */
async function walk(
  root: string,
  patterns: string[],
  io: Partial<WalkIo> = {},
) {
  const handle = await openStableDirectory(root);
  try {
    return await walkMembers(
      handle,
      compileWorkspacePatterns(patterns, 'npm', DEFAULT_WORKSPACE_LIMITS),
      'npm',
      DEFAULT_WORKSPACE_LIMITS,
      { list: readDirChildWithTypes, open: openChild, ...io },
    );
  } catch (error) {
    if (error instanceof WorkspaceError) return error;
    throw error;
  } finally {
    await handle.close();
  }
}

/** A listing that runs `change` once, right after the `at`th directory has been listed. */
function listingThen(at: number, change: () => Promise<void>): WalkIo['list'] {
  let listed = 0;
  return async (directory) => {
    const entries = await readDirChildWithTypes(directory);
    listed += 1;
    if (listed === at) await change();
    return entries;
  };
}

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe('a directory that changes between the listing and the open', () => {
  const tree = async () => {
    const root = await scratch({
      'p/a/package.json': { name: 'a' },
      'p/b/package.json': { name: 'b' },
    });
    const outside = await scratch({
      'a/package.json': { name: 'escaped-a' },
      'b/package.json': { name: 'escaped-b' },
    });
    return { root, outside };
  };

  it('is refused when it was swapped for a link out of the root', async () => {
    const { root, outside } = await tree();
    const found = await walk(root, ['p/*'], {
      list: listingThen(1, async () => {
        await rm(join(root, 'p'), { recursive: true });
        await symlink(outside, join(root, 'p'));
      }),
    });
    expect(found).toBeInstanceOf(WorkspaceError);
    expect(found).toMatchObject({
      code: 'WORKSPACE_SYMLINK',
      subjects: ['p'],
    });
  });

  it('is refused at every depth, not only the first', async () => {
    const { root, outside } = await tree();
    const found = await walk(root, ['p/*'], {
      // The second listing is p's: its entry a is swapped before a is opened.
      list: listingThen(2, async () => {
        await rm(join(root, 'p/a'), { recursive: true });
        await symlink(join(outside, 'a'), join(root, 'p/a'));
      }),
    });
    expect(found).toMatchObject({
      code: 'WORKSPACE_SYMLINK',
      subjects: ['p/a'],
    });
  });

  it('is refused when it was swapped for a file, and says it stopped being a directory', async () => {
    const { root } = await tree();
    const found = await walk(root, ['p/*'], {
      list: listingThen(1, async () => {
        await rm(join(root, 'p'), { recursive: true });
        await writeFile(join(root, 'p'), 'not a directory');
      }),
    });
    expect(found).toMatchObject({ code: 'WORKSPACE_SYMLINK' });
    expect((found as WorkspaceError).message).toMatch(
      /p stopped being a directory while the workspace was read/u,
    );
  });

  it('is passed over when it was removed', async () => {
    const { root } = await tree();
    const found = await walk(root, ['p/*'], {
      list: listingThen(2, () => rm(join(root, 'p/a'), { recursive: true })),
    });
    expect(found).not.toBeInstanceOf(WorkspaceError);
    expect(
      'found' in found ? found.found.map((entry) => entry.dir) : [],
    ).toEqual(['p/b']);
  });

  it('is refused as a link where the platform reports the open of a link as ELOOP', async () => {
    const { root } = await tree();
    const found = await walk(root, ['p/*'], {
      open: async (directory, name, flags) => {
        if (name === 'p') throw errno('ELOOP');
        return openChild(directory, name, flags);
      },
    });
    expect(found).toMatchObject({ code: 'WORKSPACE_SYMLINK' });
    expect((found as WorkspaceError).message).toMatch(
      /p is a symbolic link on the path of a workspace pattern/u,
    );
  });

  it('is reported as it failed when the open fails for another reason', async () => {
    const { root } = await tree();
    const found = await walk(root, ['p/*'], {
      open: async (directory, name, flags) => {
        if (name === 'p') throw errno('EACCES');
        return openChild(directory, name, flags);
      },
    }).catch((error: unknown) => error);
    expect(found).not.toBeInstanceOf(WorkspaceError);
    expect(found).toMatchObject({ code: 'EACCES' });
  });
});

/**
 * `handle` as far as reading a manifest uses it (measure, read, close), with
 * `before` run ahead of the read and `after` behind it.
 */
function disturbed(
  handle: FileHandle,
  before: () => Promise<void>,
  after: () => Promise<void>,
): FileHandle {
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'stat') return target.stat.bind(target);
      if (property === 'close') return target.close.bind(target);
      if (property === 'read')
        return async (
          buffer: Buffer,
          offset: number,
          length: number,
          position: number,
        ) => {
          await before();
          const result = await target.read(buffer, offset, length, position);
          await after();
          return result;
        };
      return undefined;
    },
  });
}

describe('a manifest that changes while it is read', () => {
  const manifest = (root: string) => join(root, 'p/a/package.json');
  const SIZE = JSON.stringify({ name: 'a' }).length;
  // A whole number of seconds is a time the file system keeps exactly, so a
  // change can be undone to the nanosecond and leave the size as the only sign.
  const PINNED = 1_000_000_000;
  const MOVED = 2_000_000_000;
  const pin = (root: string) => utimes(manifest(root), PINNED, PINNED);
  const read = async (
    before: (root: string) => Promise<void>,
    after: (root: string) => Promise<void>,
  ) => {
    const root = await scratch({ 'p/a/package.json': { name: 'a' } });
    await pin(root);
    return walk(root, ['p/*'], {
      open: async (directory, name, flags) => {
        const file = await openChild(directory, name, flags);
        return name === 'package.json'
          ? disturbed(
              file,
              () => before(root),
              () => after(root),
            )
          : file;
      },
    });
  };
  const nothing = async () => {};
  const changed = (found: Awaited<ReturnType<typeof read>>) => {
    expect(found).toMatchObject({ code: 'WORKSPACE_MANIFEST_INVALID' });
    expect((found as WorkspaceError).message).toBe(
      'p/a/package.json changed while it was read',
    );
  };

  it('is read when nothing changes it (the control)', async () => {
    const found = await read(nothing, nothing);
    expect(found).not.toBeInstanceOf(WorkspaceError);
    expect('found' in found && found.found.map((entry) => entry.dir)).toEqual([
      'p/a',
    ]);
  });

  it('is refused when only its modification time moved', async () => {
    changed(
      await read(nothing, (root) => utimes(manifest(root), MOVED, MOVED)),
    );
  });

  it('is refused when only its size changed', async () => {
    changed(
      await read(nothing, async (root) => {
        await appendFile(manifest(root), ' ');
        await pin(root);
      }),
    );
  });

  it('is refused when the read came up short and the file was made whole again', async () => {
    changed(
      await read(
        (root) => truncate(manifest(root), 3),
        async (root) => {
          await truncate(manifest(root), SIZE);
          await pin(root);
        },
      ),
    );
  });

  it('is refused when it was appended to, which moves both', async () => {
    changed(await read(nothing, (root) => appendFile(manifest(root), ' ')));
  });
});

describe('links met while a ** searches', () => {
  it('are listed up to a bound, and the walk goes on past it', async () => {
    const extra = 5;
    const count = 1000 + extra;
    const root = await scratch({
      'real/package.json': { name: 'real' },
      'p/m/package.json': { name: 'm' },
    });
    for (let at = 0; at < count; at += 1)
      await symlink('../real', join(root, `p/l${String(at).padStart(4, '0')}`));
    const found = await walk(root, ['p/**']);
    if (found instanceof WorkspaceError) throw found;
    expect(found.skippedLinks).toHaveLength(1000);
    expect(found.skippedLinks[0]).toBe('p/l0000');
    expect(found.skippedLinks.at(-1)).toBe('p/l0999');
    expect(found.found.map((entry) => entry.dir)).toEqual(['p/m']);
  });
});

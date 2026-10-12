/**
 * What a walk of a node_modules does and does not ask of the system when a
 * member link is in it, seen from the libc backend's side on Linux: the calls
 * are recorded as they are made, so "never opened" is a fact about the calls
 * and not about how long a test took.
 */

import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChildBackend } from './handle-libc.js';
import { useChildBackendForTesting } from './handle-path.js';
import { glibcBackend, glibcLinux } from './handle-test-support.js';
import type { RecordedLinks } from './layout-links.js';
import { collectTree } from './layout-collect.js';
import { placeMemberLink } from './member-link.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** The glibc backend, noting each operation by name; `after` can act on one. */
function recording(after?: (operation: string, name: string) => Promise<void>) {
  const inner = glibcBackend();
  const calls: string[] = [];
  const note = async (operation: string, name: string): Promise<void> => {
    calls.push(`${operation}:${name}`);
    await after?.(operation, name);
  };
  const backend: ChildBackend = {
    id: inner.id,
    openChild: async (parent, name, flags, mode) => {
      const handle = await inner.openChild(parent, name, flags, mode);
      await note('open', name);
      return handle;
    },
    mkdirChild: inner.mkdirChild,
    renameChild: inner.renameChild,
    removeChild: inner.removeChild,
    lstatChild: async (parent, name) => {
      const info = await inner.lstatChild(parent, name);
      await note('lstat', name);
      return info;
    },
    readDirChild: inner.readDirChild,
    readDirChildWithTypes: inner.readDirChildWithTypes,
    symlinkChild: inner.symlinkChild,
    readlinkChild: async (parent, name) => {
      const text = await inner.readlinkChild(parent, name);
      await note('readlink', name);
      return text;
    },
  };
  return { backend, calls };
}

async function project() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'member-spy-')));
  temps.push(root);
  const member = join(root, 'packages', 'pkg');
  await mkdir(join(member, 'deep', 'er'), { recursive: true });
  for (let index = 0; index < 200; index += 1)
    await writeFile(join(member, 'deep', 'er', `f${index}`), 'x');
  const modules = join(root, 'node_modules');
  await mkdir(join(modules, 'registry'), { recursive: true });
  await writeFile(join(modules, 'registry', 'package.json'), '{}');
  await placeMemberLink(root, 'node_modules/pkg', '../packages/pkg');
  const record = (target: string): RecordedLinks => ({
    projectRoot: root,
    base: 'node_modules',
    links: new Map([['pkg', target]]),
  });
  return { root, member, modules, record };
}

describe.skipIf(!glibcLinux())('a walk meeting a recorded member link', () => {
  it('only looks at the link: lstat and readlink, never an open of its name', async () => {
    const p = await project();
    const { backend, calls } = recording();
    const restore = useChildBackendForTesting(backend);
    try {
      const tree = await collectTree(p.modules, '', {
        memberLinks: p.record('../packages/pkg'),
      });
      expect(tree.links).toEqual([{ path: 'pkg', target: '../packages/pkg' }]);
    } finally {
      restore();
    }

    expect(calls.filter((call) => call.endsWith(':pkg'))).toEqual(
      expect.arrayContaining(['lstat:pkg', 'readlink:pkg']),
    );
    expect(calls.filter((call) => call === 'open:pkg')).toEqual([]);
    // Nothing under the member was reached by name either.
    expect(calls.filter((call) => /:(deep|er|f\d+)$/u.test(call))).toEqual([]);
  });

  it('refuses a link swapped for a new one with the same text while the tree is walked', async () => {
    const p = await project();
    let swapped = false;
    const { backend } = recording(async (operation, name) => {
      if (operation !== 'readlink' || name !== 'pkg' || swapped) return;
      swapped = true;
      // A new link with the very same text, put in place atomically: a new inode.
      await symlink('../packages/pkg', join(p.modules, '.swap'));
      await rename(join(p.modules, '.swap'), join(p.modules, 'pkg'));
    });
    const restore = useChildBackendForTesting(backend);
    try {
      const refusal = await collectTree(p.modules, '', {
        memberLinks: p.record('../packages/pkg'),
      }).catch((error: NodeJS.ErrnoException) => error);

      expect(refusal).toMatchObject({ code: 'UNSAFE_PATH' });
    } finally {
      restore();
    }
    expect(swapped).toBe(true);
  });

  it('refuses a link repointed while the tree is walked', async () => {
    const p = await project();
    let swapped = false;
    const { backend } = recording(async (operation, name) => {
      if (operation !== 'readlink' || name !== 'pkg' || swapped) return;
      swapped = true;
      await symlink('../packages/other', join(p.modules, '.swap'));
      await rename(join(p.modules, '.swap'), join(p.modules, 'pkg'));
    });
    const restore = useChildBackendForTesting(backend);
    try {
      const refusal = await collectTree(p.modules, '', {
        memberLinks: p.record('../packages/pkg'),
      }).catch((error: NodeJS.ErrnoException) => error);

      expect(refusal).toMatchObject({ code: 'UNSAFE_PATH' });
    } finally {
      restore();
    }
  });
});

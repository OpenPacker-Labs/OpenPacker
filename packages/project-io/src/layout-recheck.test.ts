import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * `materialiseTree` publishes a staged tree by removing the previous
 * destination and renaming staging into its place, and it checks the tree it
 * staged again twice: after the removal, before the rename, and after the
 * rename. A tree that changed in either window is refused, and nothing changed
 * stays published. Each test changes it in one window, from inside the step
 * that opens it, so the order of events is the code's, not a timer's.
 */

async function withTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'project-io-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('materialiseTree publication', () => {
  it('rechecks staging after removing the previous destination', async () => {
    await withTemp(async (dir) => {
      const { materialiseTree } = await import('./layout.js');
      const handlePath = await import('./handle-path.js');
      const source = join(dir, 'source');
      const root = join(dir, 'out');
      const destination = join(root, 'pkg');
      const old = join(destination, 'old');
      await mkdir(source);
      await mkdir(old, { recursive: true });
      await writeFile(join(source, 'package.json'), '{}');
      await Promise.all(
        Array.from({ length: 50 }, async (_, index) =>
          writeFile(join(old, String(index)), 'old'),
        ),
      );

      // Add a file to the staging directory right after the previous
      // destination has been removed and before materialiseTree looks at
      // staging again, from inside the removal itself. An earlier version
      // polled for the moment half of the old tree was gone and wrote through
      // the staging name; a poll starved by load wrote after the rename had
      // moved staging away (ENOENT), and the test failed for a race of its own.
      let mutated = false;
      const removeChild = handlePath.removeChild;
      const spy = vi
        .spyOn(handlePath, 'removeChild')
        .mockImplementation(async (parent, name, options) => {
          await removeChild(parent, name, options);
          if (name === 'pkg' && !mutated) {
            mutated = true;
            const staging = (await readdir(root)).find((entry) =>
              entry.startsWith('.pkg.openpacker-'),
            );
            if (staging === undefined)
              throw new Error('staging was gone before the recheck');
            await writeFile(join(root, staging, 'attacker'), 'late mutation');
          }
        });
      // The recheck before the rename refuses it: the changed staging is never
      // published, not published and then taken back by the later check.
      const renames = vi.spyOn(handlePath, 'renameChild');
      try {
        await expect(
          materialiseTree(source, destination, root),
        ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
        expect(mutated).toBe(true);
        expect(renames).not.toHaveBeenCalled();
        await expect(lstat(destination)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        spy.mockRestore();
        renames.mockRestore();
      }
    });
  });

  it('rechecks what it published after the rename, and takes it back', async () => {
    await withTemp(async (dir) => {
      const { materialiseTree } = await import('./layout.js');
      const handlePath = await import('./handle-path.js');
      const source = join(dir, 'source');
      const root = join(dir, 'out');
      const destination = join(root, 'pkg');
      await mkdir(source);
      await writeFile(join(source, 'package.json'), '{}');

      // A file added to the tree in the moment between its rename into place
      // and the check of what was published.
      let mutated = false;
      const renameChild = handlePath.renameChild;
      const spy = vi
        .spyOn(handlePath, 'renameChild')
        .mockImplementation(async (parent, from, to) => {
          await renameChild(parent, from, to);
          if (to === 'pkg' && !mutated) {
            mutated = true;
            await writeFile(join(destination, 'attacker'), 'late mutation');
          }
        });
      try {
        await expect(
          materialiseTree(source, destination, root),
        ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
        expect(mutated).toBe(true);
        await expect(lstat(destination)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});

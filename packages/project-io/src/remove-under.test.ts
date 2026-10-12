/**
 * Removing a directory below the project root without following a link on the
 * way: a member's `node_modules`, named by a lock.
 */

import {
  lstat,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, failure, project, remember } from './member-link-support.js';
import { removeBelow } from './remove-under.js';

afterEach(cleanup);

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

describe('removeBelow', () => {
  it('removes the directory, and what is in it, and says it did', async () => {
    const p = await project();
    const inner = join(p.member, 'node_modules', 'a', 'node_modules', 'b');
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, 'index.js'), 'x');
    expect(await removeBelow(p.root, 'packages/pkg/node_modules')).toBe(true);
    expect(await exists(join(p.member, 'node_modules'))).toBe(false);
    // The member's own files are not what was named.
    expect(await readFile(join(p.member, 'sentinel'), 'utf8')).toBe('keep');
  });

  it('says so when there was nothing to remove, even a whole branch of nothing', async () => {
    const p = await project();
    expect(await removeBelow(p.root, 'packages/pkg/node_modules')).toBe(false);
    expect(await removeBelow(p.root, 'packages/none/node_modules')).toBe(false);
    expect(await removeBelow(p.root, 'nowhere/at/all/node_modules')).toBe(
      false,
    );
  });

  it('does not follow a link on the way, and removes nothing it points at', async () => {
    const p = await project();
    const elsewhere = join(p.root, '..', `elsewhere-${Date.now()}`);
    remember(elsewhere);
    await mkdir(join(elsewhere, 'node_modules'), { recursive: true });
    await writeFile(join(elsewhere, 'node_modules', 'precious'), 'mine');
    await symlink(elsewhere, join(p.root, 'packages', 'linked'));

    const error = await failure(() =>
      removeBelow(p.root, 'packages/linked/node_modules'),
    );
    expect(error).toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readdir(join(elsewhere, 'node_modules'))).toEqual([
      'precious',
    ]);
  });

  it('does not walk through a file', async () => {
    const p = await project();
    await writeFile(join(p.root, 'packages', 'file'), 'x');
    expect(
      await failure(() => removeBelow(p.root, 'packages/file/node_modules')),
    ).toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('takes a link in the last place away as the link it is', async () => {
    const p = await project();
    const target = join(p.root, 'target-of-link');
    await mkdir(target);
    await writeFile(join(target, 'keep'), 'kept');
    await symlink(target, join(p.member, 'node_modules'));
    expect(await removeBelow(p.root, 'packages/pkg/node_modules')).toBe(true);
    expect(await exists(join(p.member, 'node_modules'))).toBe(false);
    expect(await readFile(join(target, 'keep'), 'utf8')).toBe('kept');
  });

  it.each(['', '.', '..', '../x', 'a//b', 'a/../b', './a', 'a/', '/abs'])(
    'does not take %j for a path below the root',
    async (path) => {
      const p = await project();
      expect(await failure(() => removeBelow(p.root, path))).toMatchObject({
        code: 'UNSAFE_PATH',
      });
      expect(await exists(p.member)).toBe(true);
    },
  );
});

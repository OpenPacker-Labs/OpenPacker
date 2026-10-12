import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readMemberPackage } from '../src/commands/run-member-files.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tree() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opm-member-')));
  temps.push(root);
  await mkdir(join(root, 'packages', 'a'), { recursive: true });
  await writeFile(
    join(root, 'packages', 'a', 'package.json'),
    JSON.stringify({
      name: '@s/a',
      version: '1.2.3',
      scripts: { build: 'echo hi' },
    }),
  );
  return root;
}

describe('readMemberPackage', () => {
  it('reads the name, version and scripts of a member', async () => {
    const root = await tree();
    const pkg = await readMemberPackage(root, 'packages/a');
    expect(pkg?.name).toBe('@s/a');
    expect(pkg?.version).toBe('1.2.3');
    expect([...(pkg?.scripts ?? [])]).toEqual([['build', 'echo hi']]);
  });

  it('reads the root with an empty directory', async () => {
    const root = await tree();
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root' }),
    );
    expect((await readMemberPackage(root, ''))?.name).toBe('root');
  });

  it('says nothing for a member that has gone', async () => {
    const root = await tree();
    expect(await readMemberPackage(root, 'packages/gone')).toBeUndefined();
    await mkdir(join(root, 'packages', 'empty'));
    expect(await readMemberPackage(root, 'packages/empty')).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a member directory that is a symbolic link',
    async () => {
      const root = await tree();
      const outside = await realpath(
        await mkdtemp(join(tmpdir(), 'opm-outside-')),
      );
      temps.push(outside);
      await writeFile(
        join(outside, 'package.json'),
        JSON.stringify({ scripts: { build: 'echo pwned' } }),
      );
      await symlink(outside, join(root, 'packages', 'evil'));
      await expect(
        readMemberPackage(root, 'packages/evil'),
      ).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
        message: expect.stringContaining('packages/evil'),
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a directory above the member that is a symbolic link',
    async () => {
      const root = await tree();
      const outside = await realpath(
        await mkdtemp(join(tmpdir(), 'opm-outside-')),
      );
      temps.push(outside);
      await mkdir(join(outside, 'a'));
      await writeFile(
        join(outside, 'a', 'package.json'),
        JSON.stringify({ scripts: { x: 'y' } }),
      );
      await symlink(outside, join(root, 'linked'));
      await expect(readMemberPackage(root, 'linked/a')).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a package.json that is a symbolic link',
    async () => {
      const root = await tree();
      await mkdir(join(root, 'packages', 'b'));
      const outside = await realpath(
        await mkdtemp(join(tmpdir(), 'opm-outside-')),
      );
      temps.push(outside);
      await writeFile(join(outside, 'package.json'), '{"scripts":{"x":"y"}}');
      await symlink(
        join(outside, 'package.json'),
        join(root, 'packages', 'b', 'package.json'),
      );
      await expect(readMemberPackage(root, 'packages/b')).rejects.toMatchObject(
        { code: 'UNSAFE_PATH' },
      );
    },
  );

  it('refuses a package.json that is not JSON, naming the file', async () => {
    const root = await tree();
    await writeFile(join(root, 'packages', 'a', 'package.json'), '{nope');
    await expect(readMemberPackage(root, 'packages/a')).rejects.toMatchObject({
      code: 'INVALID_MANIFEST',
      message: expect.stringContaining(join('packages', 'a', 'package.json')),
    });
  });

  it('refuses scripts that are not an object, and a package.json that is a directory', async () => {
    const root = await tree();
    await writeFile(
      join(root, 'packages', 'a', 'package.json'),
      '{"scripts":[]}',
    );
    await expect(readMemberPackage(root, 'packages/a')).rejects.toMatchObject({
      code: 'INVALID_MANIFEST',
    });
    await mkdir(join(root, 'packages', 'd', 'package.json'), {
      recursive: true,
    });
    await expect(readMemberPackage(root, 'packages/d')).rejects.toMatchObject({
      code: 'INVALID_MANIFEST',
    });
  });
});

import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanup,
  exists,
  setup,
  standard,
  temps,
  type World,
} from './frozen-workspace-fixture.js';

afterEach(cleanup);

describe('installFrozen refuses, before it fetches or writes anything', () => {
  async function refused(w: World, code: string, text: RegExp) {
    await mkdir(join(w.dir, 'node_modules/keep'), { recursive: true });
    await expect(w.install()).rejects.toMatchObject({
      code,
      message: expect.stringMatching(text),
    });
    expect(w.registry.requests).toEqual([]);
    expect(await exists(join(w.dir, 'node_modules/keep'))).toBe(true);
    expect(await exists(join(w.dir, 'node_modules/one'))).toBe(false);
  }

  it('a link to a place outside the project', async () => {
    const w = await standard((x) =>
      x.raw('node_modules/evil', { resolved: '../outside', link: true }),
    );
    await w.write();
    await refused(
      w,
      'UNSUPPORTED_LOCK',
      /node_modules\/evil: a link that points at \.\.\/outside, which leaves the project root/u,
    );
  });

  it("a member's own link that points outside the project", async () => {
    const w = await standard((x) =>
      x.raw('node_modules/one', { resolved: '../../outside', link: true }),
    );
    await w.write();
    await refused(
      w,
      'UNSUPPORTED_LOCK',
      /node_modules\/one: a link that points at \.\.\/\.\.\/outside, which leaves the project root/u,
    );
  });

  it("a member's own link that points at a directory no pattern selects", async () => {
    const w = await standard((x) => {
      x.raw('node_modules/one', { resolved: 'vendor/one', link: true });
      x.raw('vendor/one', { name: 'one', version: '1.0.0' });
    });
    await w.write();
    await refused(
      w,
      'UNSUPPORTED_LOCK',
      /node_modules\/one: a link to vendor\/one, which is not a workspace member/u,
    );
  });

  it('a link to a directory the workspaces do not select', async () => {
    const w = await standard((x) => {
      x.raw('node_modules/vendored', {
        resolved: 'vendor/vendored',
        link: true,
      });
      x.raw('vendor/vendored', { name: 'vendored', version: '1.0.0' });
    });
    await w.write();
    await refused(
      w,
      'UNSUPPORTED_LOCK',
      /vendor\/vendored: not a workspace member/u,
    );
  });

  it("a link under a name that is not the member's", async () => {
    const w = await standard((x) =>
      x.raw('node_modules/alias', { resolved: 'packages/one', link: true }),
    );
    await w.write();
    await refused(
      w,
      'UNSUPPORTED_LOCK',
      /node_modules\/alias: a link named alias to the member one/u,
    );
  });

  it('a package bundled in a member', async () => {
    const w = await standard((x) =>
      x.place(
        'packages/one/node_modules/bundled',
        { name: 'bundled', version: '1.0.0' },
        { inBundle: true },
      ),
    );
    await w.write();
    await refused(
      w,
      'UNSUPPORTED_LOCK',
      /bundled@1\.0\.0 is bundled in the workspace member packages\/one/u,
    );
  });

  it('a lock that lists a member the disk does not have', async () => {
    const w = await standard();
    await w.write();
    await rm(join(w.dir, 'packages/two'), { recursive: true });
    await refused(
      w,
      'INVALID_LOCK',
      /the lock lists the members packages\/one, packages\/two; the project declares the members packages\/one; packages\/two \(two\) is a member in the lock and is not on disk/su,
    );
  });

  it('a member on disk that the lock does not have', async () => {
    const w = await standard();
    await w.write();
    await mkdir(join(w.dir, 'packages/three'));
    await writeFile(
      join(w.dir, 'packages/three/package.json'),
      '{"name":"three","version":"1.0.0"}',
    );
    await refused(
      w,
      'INVALID_LOCK',
      /packages\/three \(three\) is a member on disk and is not in the lock/u,
    );
  });

  it('two members on disk with one name', async () => {
    const w = await standard();
    await w.write();
    await mkdir(join(w.dir, 'packages/dup'));
    await writeFile(
      join(w.dir, 'packages/dup/package.json'),
      '{"name":"one","version":"1.0.0"}',
    );
    await refused(
      w,
      'INVALID_MANIFEST',
      /Two workspace members are named "one"/u,
    );
  });

  it('two members in the lock with one name', async () => {
    const w = await standard();
    w.root.workspaces = ['packages/*', 'tools/*'];
    await w.write({
      lockMembers: {
        'packages/one': { name: 'one', version: '1.0.0' },
        'tools/one': { name: 'one', version: '1.0.0' },
        'packages/two': { name: 'two', version: '1.0.0' },
      },
    });
    await refused(
      w,
      'INVALID_LOCK',
      /Two workspace members are named "one": packages\/one, tools\/one/u,
    );
  });

  it('a member whose manifest lists a dependency the lock lacks', async () => {
    const w = await standard();
    await w.write();
    const manifest = JSON.parse(await w.read('packages/two/package.json'));
    manifest.dependencies.missing = '^1.0.0';
    await writeFile(
      join(w.dir, 'packages/two/package.json'),
      JSON.stringify(manifest),
    );
    await refused(
      w,
      'INVALID_LOCK',
      /packages\/two: dependencies\.missing is in package\.json and not in the lock/u,
    );
  });

  it('a member whose lock entry names a dependency the lock has no entry for', async () => {
    const w = await standard();
    const broken = {
      'packages/one': {
        name: 'one',
        version: '1.0.0',
        dependencies: { left: '^0.9.0', two: '^1.0.0', a: '^1.0.0', gone: '1' },
      },
      'packages/two': {
        name: 'two',
        version: '1.0.0',
        dependencies: { b: '^1.0.0' },
        devDependencies: { dd: '^1.0.0' },
        bin: { two: 'bin/two.js' },
      },
    };
    await w.write({ lockMembers: broken });
    const manifest = JSON.parse(await w.read('packages/one/package.json'));
    manifest.dependencies.gone = '1';
    await writeFile(
      join(w.dir, 'packages/one/package.json'),
      JSON.stringify(manifest),
    );
    await refused(
      w,
      'INVALID_LOCK',
      /packages\/one: gone \(dependencies\) has no entry in the lock/u,
    );
  });

  it('a workspace reached through a link', async () => {
    const w = await standard();
    await w.write();
    const real = join(w.dir, '..', `real-packages-${Date.now()}`);
    temps.push(real);
    await mkdir(dirname(real), { recursive: true });
    await rm(join(w.dir, 'packages'), { recursive: true });
    await mkdir(join(real, 'one'), { recursive: true });
    await writeFile(
      join(real, 'one/package.json'),
      '{"name":"one","version":"1.0.0"}',
    );
    await symlink(real, join(w.dir, 'packages'));
    await refused(w, 'UNSAFE_PATH', /packages/u);
  });

  // The plan of the lock's places is knowable from the lock alone, so a place
  // that cannot be written is refused here, with the project's node_modules
  // (the `keep` the helper puts there) still in place.
  it.each([
    ['the project', 'node_modules'],
    ['a member', 'packages/one/node_modules'],
  ])(
    'two names that differ only by case in the node_modules of %s',
    async (_who, dir) => {
      const w = await standard((x) => {
        x.place(`${dir}/MS`, { name: 'ms', version: '2.1.3' }, { name: 'ms' });
        x.place(`${dir}/ms`, { name: 'ms', version: '2.1.3' });
      });
      await w.write();
      await refused(
        w,
        'INVALID_LOCK',
        new RegExp(
          `ms@2\\.1\\.3 would be installed as ms, which differs only by case from MS.*\\(at ${dir.replaceAll('/', '\\/')}\\/ms\\)`,
          'u',
        ),
      );
    },
  );
});

describe('a project without a workspace', () => {
  it('is installed as it always was, and refuses a workspace flag', async () => {
    const w = await setup();
    delete w.root.workspaces;
    w.root.dependencies = { a: '^1.0.0' };
    w.place('node_modules/a', { name: 'a', version: '1.0.0' });
    await w.write();
    const result = await w.install();
    expect(result.workspace).toBeUndefined();
    expect(result.installed).toBe(1);
    // npm accepts -w in a project with no workspaces and finds none.
    await expect(
      w.install({ workspace: { select: ['a'] } }),
    ).rejects.toMatchObject({
      code: 'INVALID_SPEC',
      message: expect.stringMatching(/No workspaces found/u),
    });
  });

  it('is never put through workspace discovery, which reads manifests more strictly than npm ci does', async () => {
    const w = await setup();
    delete w.root.workspaces;
    // Not SemVer 2.0, which discovery refuses and an ordinary install never read.
    w.root.version = '1.0';
    w.root.dependencies = { a: '^1.0.0' };
    w.place('node_modules/a', { name: 'a', version: '1.0.0' });
    await w.write();
    expect((await w.install()).installed).toBe(1);
  });

  it('is put through it once it declares a workspace', async () => {
    const w = await setup();
    w.root.version = '1.0';
    await w.write();
    await expect(w.install()).rejects.toMatchObject({
      code: 'INVALID_MANIFEST',
      message: expect.stringMatching(
        /version "1\.0" is not a semantic version/u,
      ),
    });
  });
});

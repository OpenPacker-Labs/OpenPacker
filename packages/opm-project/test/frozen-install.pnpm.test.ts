import {
  lstat,
  mkdir,
  readdir,
  readlink,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, pnpmWorld, type PnpmWorld } from './frozen-pnpm-fixture.js';
import { onPosix } from './frozen-workspace-fixture.js';

afterEach(cleanup);

/**
 * `installFrozen` over a `pnpm-lock.yaml` (ADR 0055): the places are chosen by
 * the install and not written in the lock, so what these read is what Node
 * resolves from the tree that was written.
 *
 *   .              a                      (a needs shared)
 *                  tool (dev, with a bin)
 *                  plat-linux-x64, plat-darwin-arm64 (optional, one per platform)
 *   packages/web   dom(react@18.2.0), react 18.2.0, lib (workspace link)
 *   packages/lib   dom(react@18.3.0), react 18.3.0
 *
 * `dom` is one package resolved against two sets of peers.
 */
async function fixture(): Promise<PnpmWorld> {
  const w = await pnpmWorld();
  w.pkg({ name: 'shared', version: '1.0.0' });
  w.pkg({ name: 'a', version: '1.0.0', deps: { shared: '1.0.0' } });
  w.pkg({
    name: 'tool',
    version: '1.0.0',
    manifest: { bin: { tool: 'index.js' } },
  });
  w.pkg({
    name: 'plat-linux-x64',
    version: '1.0.0',
    os: ['linux'],
    cpu: ['x64'],
    optional: true,
  });
  w.pkg({
    name: 'plat-darwin-arm64',
    version: '1.0.0',
    os: ['darwin'],
    cpu: ['arm64'],
    optional: true,
  });
  w.pkg({ name: 'react', version: '18.2.0' });
  w.pkg({ name: 'react', version: '18.3.0' });
  w.pkg({
    name: 'dom',
    version: '1.0.0',
    suffix: '(react@18.2.0)',
    deps: { react: '18.2.0' },
  });
  w.pkg({
    name: 'dom',
    version: '1.0.0',
    suffix: '(react@18.3.0)',
    deps: { react: '18.3.0' },
  });
  w.importer('.', {
    dependencies: { a: ['^1.0.0', '1.0.0'] },
    devDependencies: { tool: ['^1.0.0', '1.0.0'] },
    optionalDependencies: {
      'plat-linux-x64': ['^1.0.0', '1.0.0'],
      'plat-darwin-arm64': ['^1.0.0', '1.0.0'],
    },
  });
  w.importer('packages/web', {
    dependencies: {
      dom: ['^1.0.0', '1.0.0(react@18.2.0)'],
      react: ['^18.2.0', '18.2.0'],
      lib: ['workspace:*', 'link:../lib'],
    },
  });
  w.importer('packages/lib', {
    dependencies: {
      dom: ['^1.0.0', '1.0.0(react@18.3.0)'],
      react: ['^18.3.0', '18.3.0'],
    },
  });
  await w.write();
  return w;
}

describe('installFrozen of a pnpm workspace', () => {
  it('writes a tree in which Node finds, from every importer, the instance the lock names', async () => {
    const w = await fixture();
    await w.install();
    // The variants of one package, each with the peer its importer has.
    expect(w.load('dom', 'packages/web')).toEqual({
      id: 'dom@1.0.0',
      deps: { react: '18.2.0' },
    });
    expect(w.load('dom', 'packages/lib')).toEqual({
      id: 'dom@1.0.0',
      deps: { react: '18.3.0' },
    });
    expect(w.load('react/package.json', 'packages/web')).toMatchObject({
      version: '18.2.0',
    });
    // The project's own, and what it brings in.
    expect(w.load('a').deps).toEqual({ shared: '1.0.0' });
    expect(await w.list('node_modules')).toEqual(
      expect.arrayContaining(['a', 'shared', 'tool', 'lib']),
    );
  });

  it("shares a member's direct dependency at the project unless another version or its peer keeps it in the member", async () => {
    const w = await fixture();
    await w.install();
    // web's dom was resolved against react 18.2 and web requires react 18.2,
    // which the project's 18.3 shadows: both stay in web, one copy each.
    expect(await w.list('packages/web/node_modules')).toEqual(
      expect.arrayContaining(['dom', 'react']),
    );
    // lib's react 18.3 is shared at the project; its dom stays in lib, the
    // project's dom name going to the variant more importers want.
    expect(await w.list('packages/lib/node_modules')).not.toContain('react');
    expect(await w.list('packages/lib/node_modules')).toContain('dom');
    expect(w.load('react/package.json')).toMatchObject({ version: '18.3.0' });
    // `shared` is wanted by `a` alone and sits at the project.
    expect((await stat(join(w.dir, 'node_modules/shared'))).isDirectory()).toBe(
      true,
    );
  });

  it('extracts the two instances of one package once and places it twice', async () => {
    const w = await fixture();
    const result = await w.install();
    // 8 archives are in the lock (shared, a, tool, 2 plat, 2 react, dom); the
    // darwin one is not for this machine, so 7 are fetched and, with the two
    // places of dom, 8 are placed beside the 2 react copies in the members.
    expect(result.fetched).toBe(7);
    expect(result.installed).toBeGreaterThan(result.fetched);
  });

  onPosix('links a member at node_modules/<name> and shims a bin', async () => {
    const w = await fixture();
    await w.install();
    expect(
      (await lstat(join(w.dir, 'node_modules/lib'))).isSymbolicLink(),
    ).toBe(true);
    expect(await readlink(join(w.dir, 'node_modules/lib'))).toBe(
      '../packages/lib',
    );
    expect(w.run("console.log(require('lib'))", 'packages/web')).toBe(
      'member lib',
    );
    expect(await w.list('node_modules/.bin')).toContain('tool');
  });

  it('leaves out an optional package for another platform, and says so', async () => {
    const w = await fixture();
    const result = await w.install();
    expect(await w.list('node_modules')).toContain('plat-linux-x64');
    expect(await w.list('node_modules')).not.toContain('plat-darwin-arm64');
    expect(result.skipped).toEqual([
      expect.objectContaining({
        name: 'plat-darwin-arm64',
        kind: 'platform',
      }),
    ]);
  });

  it('reads whether a package declares an install script from the archive', async () => {
    const w = await pnpmWorld();
    w.pkg({
      name: 'builds',
      version: '1.0.0',
      manifest: { scripts: { postinstall: 'node build.js' } },
    });
    w.pkg({ name: 'quiet', version: '1.0.0' });
    w.importer('.', {
      dependencies: {
        builds: ['^1.0.0', '1.0.0'],
        quiet: ['^1.0.0', '1.0.0'],
      },
    });
    await w.write();
    const result = await w.install();
    expect(result.installScripts).toEqual([
      expect.objectContaining({ name: 'builds', version: '1.0.0' }),
    ]);
  });

  it('leaves alone an importer the project no longer has, and a new member with no dependencies, as pnpm does', async () => {
    const w = await fixture();
    await w.write({
      lock: w
        .lockText()
        .replace('importers:\n', 'importers:\n\n  "packages/ghost": {}\n'),
    });
    await mkdir(join(w.dir, 'packages/ghost/node_modules/keep'), {
      recursive: true,
    });
    await mkdir(join(w.dir, 'packages/extra'), { recursive: true });
    await writeFile(
      join(w.dir, 'packages/extra/package.json'),
      '{"name":"extra","version":"1.0.0"}',
    );
    await w.install();
    // Not a member: the install neither clears nor fills its node_modules.
    expect(await readdir(join(w.dir, 'packages/ghost/node_modules'))).toEqual([
      'keep',
    ]);
  });

  it('refuses a member with dependencies that the lock does not list, as its own rule', async () => {
    const w = await fixture();
    await w.write();
    await mkdir(join(w.dir, 'packages/extra'), { recursive: true });
    await writeFile(
      join(w.dir, 'packages/extra/package.json'),
      '{"name":"extra","version":"1.0.0","dependencies":{"left":"^1.0.0"}}',
    );
    const error = await w.install().then(
      () => undefined,
      (thrown: Error) => thrown,
    );
    expect(error?.message).toMatch(
      /does not list every member of the project's workspace .*"packages\/extra", which the lock does not list and which has dependencies/u,
    );
    expect(error?.message).not.toMatch(/would refuse too/u);
  });
});

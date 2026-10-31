/**
 * A project, a store or a temporary directory reached through a symbolic link
 * on the way to it: `TMPDIR` behind a link, macOS's `/var` → `/private/var`, a
 * project in a linked directory, `HOME` or `XDG_CACHE_HOME` behind a link.
 * Each is opened where the link leads, as npm, pnpm and git open it, and a
 * link swapped in below the project root is still refused (ADR 0034,
 * amendment of 2026-10-31).
 *
 * Each case builds its world in a real directory and points the environment
 * into it, so none depends on how this machine's `TMPDIR` is laid out, and the
 * shared store is always one of the world's, never the user's.
 */

import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addPackage,
  enableDefaultSharedStore,
  initProject,
  packProject,
  projectPaths,
  readManifestFile,
  usableSharedRoot,
  writeManifestFile,
} from '../src/index.js';
import {
  openStableDirectory,
  readStableFile,
  writeStableFile,
} from '../src/paths.js';
import { runLifecycleScript } from '../src/lifecycle.js';
import { permissive } from './closure-support.js';
import { NpmRegistryFixture } from './npm-registry-fixture.js';

const POSIX = process.platform === 'linux' || process.platform === 'darwin';

const worlds: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  enableDefaultSharedStore(false);
  for (const world of worlds.splice(0))
    await rm(world, { recursive: true, force: true });
});

/** A real, empty directory with its own shared store, which no case shares. */
async function world(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'opm-linked-'));
  worlds.push(dir);
  vi.stubEnv('OPM_STORE_HOME', join(dir, 'store'));
  return dir;
}

/** `<base>/<real>` as a directory and `<base>/<link>` → it. */
async function linked(
  base: string,
  real: string,
  link: string,
): Promise<{ real: string; link: string }> {
  await mkdir(join(base, real), { recursive: true });
  await symlink(real, join(base, link), 'dir');
  return { real: join(base, real), link: join(base, link) };
}

const registry = () =>
  new NpmRegistryFixture([
    {
      name: 'tool',
      versions: {
        '1.0.0': {
          bin: { 'tool-cli': 'cli.js' },
          files: { 'cli.js': '#!/usr/bin/env node\n' },
        },
      },
    },
  ]);

/** `opm init`, then `opm add pkg:npm/tool@1.0.0` with a node_modules layout. */
async function addTool(root: string): Promise<void> {
  await initProject({ root, name: 'linked' });
  const paths = projectPaths(root);
  const manifest = await readManifestFile(paths.manifest);
  manifest.project.ecosystems = ['npm'];
  manifest.options.nativeProjection = 'layout';
  manifest.policy = permissive;
  await writeManifestFile(paths.manifest, manifest);
  await writeStableFile(
    join(root, 'package.json'),
    '{"name":"linked","version":"0.0.0"}\n',
  );
  await addPackage({
    root,
    spec: 'pkg:npm/tool@1.0.0',
    registryOptions: { transport: registry() },
  });
}

/** What `addTool` leaves, read where the project really is. */
async function expectInstalled(real: string): Promise<void> {
  expect(await readFile(join(real, 'opm.toml'), 'utf8')).toContain(
    'pkg:npm/tool',
  );
  expect(
    JSON.parse(
      await readFile(join(real, 'node_modules/tool/package.json'), 'utf8'),
    ),
  ).toMatchObject({ name: 'tool', version: '1.0.0' });
  expect((await lstat(join(real, '.opm', 'bin', 'tool-cli'))).isFile()).toBe(
    true,
  );
}

describe.runIf(POSIX)('a project whose base is reached through a link', () => {
  it('installs under a TMPDIR that is a link', async () => {
    const base = await world();
    const tmp = await linked(base, 'real-tmp', 'tmp-link');
    vi.stubEnv('TMPDIR', tmp.link);
    const root = await mkdtemp(join(tmpdir(), 'opm-project-'));

    await addTool(root);
    await expectInstalled(join(tmp.real, root.split('/').at(-1)!));
  });

  it('installs under TMPDIR laid out as on macOS: /var → /private/var', async () => {
    const base = await world();
    await mkdir(join(base, 'private/var/folders/xy/T'), { recursive: true });
    await symlink('private/var', join(base, 'var'), 'dir');
    vi.stubEnv('TMPDIR', join(base, 'var/folders/xy/T'));
    const root = join(tmpdir(), 'project');
    await mkdir(root);

    await addTool(root);
    await expectInstalled(join(base, 'private/var/folders/xy/T/project'));
  });

  it('installs in a project reached through a linked parent directory', async () => {
    const base = await world();
    const code = await linked(base, 'code-real', 'code');
    await mkdir(join(code.real, 'project'));

    await addTool(join(code.link, 'project'));
    await expectInstalled(join(code.real, 'project'));
  });

  it('installs in a project root that is itself a link, as npm, pnpm and git do', async () => {
    const base = await world();
    const project = await linked(base, 'checkout', 'project');

    await addTool(project.link);
    await expectInstalled(project.real);
  });

  it('packs a project under a TMPDIR that is a link, and leaves its own output out', async () => {
    const base = await world();
    const tmp = await linked(base, 'real-tmp', 'tmp-link');
    vi.stubEnv('TMPDIR', tmp.link);
    const root = await mkdtemp(join(tmpdir(), 'opm-pack-'));
    await writeFile(
      join(root, 'package.json'),
      '{"name":"demo","version":"1.0.0"}\n',
    );
    await writeFile(join(root, 'index.js'), 'export const value = 1;\n');
    const pack = async () => {
      const outcome = await packProject({
        root,
        ecosystem: 'npm',
        strategy: 'standard',
        name: 'demo',
        version: '1.0.0',
        outputDirectory: join(root, 'out'),
      });
      const tarball = outcome.artifacts.find(
        (artifact) => artifact.nativeRole === 'distribution',
      )!;
      return await readFile(tarball.path);
    };

    // The second pack would hold the first tarball if out/ were not left out.
    expect(await pack()).toEqual(await pack());
  });

  it('runs a lifecycle script under a TMPDIR that is a link, and tells it where it runs', async () => {
    const base = await world();
    const tmp = await linked(base, 'real-tmp', 'tmp-link');
    vi.stubEnv('TMPDIR', tmp.link);
    const pkg = await mkdtemp(join(tmpdir(), 'opm-life-'));
    const real = join(tmp.real, pkg.split('/').at(-1)!);

    const outcome = await runLifecycleScript({
      event: 'postinstall',
      script: `${process.execPath} -e "require('fs').writeFileSync('seen', process.env.INIT_CWD + '|' + process.cwd())"`,
      packageDir: pkg,
      packageId: 'pkg:npm/linked-postinstall',
      policy: {
        ...permissive,
        allowLifecycleScripts: true,
        allowedLifecycleScriptPackages: ['pkg:npm/linked-postinstall'],
        sandboxMode: 'fail-closed',
        sandboxRequired: true,
        sandboxPrefer: 'native',
      },
    });
    expect(outcome).toMatchObject({ exitCode: 0, enforced: true });
    expect(await readFile(join(real, 'seen'), 'utf8')).toBe(`${real}|${real}`);
  });

  it('keeps a shared store that an environment it is handed names behind a link', async () => {
    const base = await world();
    await linked(base, 'store-real', 'ln');
    const store = join(base, 'ln', 'store');
    const env = { OPM_STORE_HOME: store };

    expect(await usableSharedRoot(join(base, 'project'), env)).toBe(store);
    const handle = await openStableDirectory(join(store, 'sha256-entry'), true);
    await handle.close();
    expect(await readdir(join(base, 'store-real', 'store'))).toEqual([
      'sha256-entry',
    ]);
    await mkdir(join(base, 'outside'));
    await symlink(
      join(base, 'outside'),
      join(base, 'store-real/store/swapped'),
    );
    await expect(
      openStableDirectory(join(store, 'swapped', 'x'), true),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readdir(join(base, 'outside'))).toEqual([]);
  });

  it('keeps its shared store under a HOME that is a link', async () => {
    const base = await world();
    const home = await linked(base, 'home-real', 'home-link');
    vi.stubEnv('OPM_STORE_HOME', '');
    vi.stubEnv('XDG_CACHE_HOME', '');
    vi.stubEnv('HOME', home.link);
    enableDefaultSharedStore(true);
    const project = join(home.link, 'project');
    await mkdir(project);

    await addTool(project);
    await expectInstalled(join(home.real, 'project'));
    expect(
      (await readdir(join(home.real, '.cache/openpacker/store'))).filter(
        (name) => name.startsWith('sha256-'),
      ),
    ).not.toHaveLength(0);
  });

  it('keeps its shared store under an XDG_CACHE_HOME that is a link', async () => {
    const base = await world();
    const cache = await linked(base, 'cache-real', 'cache-link');
    vi.stubEnv('OPM_STORE_HOME', '');
    vi.stubEnv('XDG_CACHE_HOME', cache.link);
    enableDefaultSharedStore(true);
    const root = join(base, 'project');
    await mkdir(root);

    await addTool(root);
    await expectInstalled(root);
    expect(
      (await readdir(join(cache.real, 'openpacker/store'))).filter((name) =>
        name.startsWith('sha256-'),
      ),
    ).not.toHaveLength(0);
  });
});

describe.runIf(POSIX)('a link below the project root', () => {
  it('is refused where .opm is, and nothing is written where it points', async () => {
    const base = await world();
    const code = await linked(base, 'code-real', 'code');
    const root = join(code.link, 'project');
    await mkdir(join(code.real, 'project'));
    await initProject({ root, name: 'linked' });
    await mkdir(join(base, 'outside'));
    await rm(join(code.real, 'project', '.opm'), { recursive: true });
    await symlink(join(base, 'outside'), join(code.real, 'project', '.opm'));

    await expect(
      addPackage({
        root,
        spec: 'pkg:npm/tool@1.0.0',
        registryOptions: { transport: registry() },
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readdir(join(base, 'outside'))).toEqual([]);
  });

  it('is refused inside .opm, though the project is reached through a link', async () => {
    const base = await world();
    const code = await linked(base, 'code-real', 'code');
    const root = join(code.link, 'project');
    const paths = projectPaths(root);
    await mkdir(join(code.real, 'project', '.opm'), { recursive: true });
    await mkdir(join(base, 'outside'));
    await symlink(
      join(base, 'outside'),
      join(code.real, 'project', '.opm', 'store'),
    );

    await expect(
      openStableDirectory(join(paths.store, 'sha256-entry'), true),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(
      writeStableFile(join(paths.store, 'sha256-entry', 'meta.json'), '{}'),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(
      readStableFile(join(paths.store, 'meta.json')),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    expect(await readdir(join(base, 'outside'))).toEqual([]);
  });
});

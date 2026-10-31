/**
 * What no base is resolved through, as an install meets it (ADR 0034,
 * amendment of 2026-10-31): a link in the project, however the project is
 * named (a bind mount of it), whenever the project was taken (after a store
 * root reached through its link), and a link another user put in a sticky
 * directory anyone may write to.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  chmod,
  lchown,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetBases } from '@openpacker/project-io';
import {
  addPackage,
  enableDefaultSharedStore,
  initProject,
  projectPaths,
  readManifestFile,
  usableSharedRoot,
  writeManifestFile,
} from '../src/index.js';
import { upsertAuthOrigin } from '../src/auth-config.js';
import { ensureStableDirectory, writeStableFile } from '../src/paths.js';
import { openToolCache } from '../src/shared-store-root.js';
import { permissive } from './closure-support.js';
import { NpmRegistryFixture } from './npm-registry-fixture.js';

const POSIX = process.platform === 'linux' || process.platform === 'darwin';
const ROOT = process.geteuid?.() === 0;
const NOBODY = 65534;
const REFUSED = /^(ENOTDIR|ELOOP|UNSAFE_PATH)$/u;

const worlds: string[] = [];
const mounts: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  enableDefaultSharedStore(false);
  forgetBases();
  for (const mount of mounts.splice(0))
    execFileSync('umount', [mount], { stdio: 'ignore' });
  for (const world of worlds.splice(0))
    await rm(world, { recursive: true, force: true });
});

async function world(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'opm-fences-'));
  worlds.push(dir);
  vi.stubEnv('OPM_STORE_HOME', '');
  return dir;
}

/** `<base>/project` holding `.cache -> <base>/outside`, as a checkout may. */
async function projectHoldingLink(
  base: string,
): Promise<{ root: string; outside: string }> {
  const root = join(base, 'project');
  const outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, join(root, '.cache'));
  return { root, outside };
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
  await initProject({ root, name: 'fenced' });
  const paths = projectPaths(root);
  const manifest = await readManifestFile(paths.manifest);
  manifest.project.ecosystems = ['npm'];
  manifest.options.nativeProjection = 'layout';
  manifest.policy = permissive;
  await writeManifestFile(paths.manifest, manifest);
  await writeStableFile(
    join(root, 'package.json'),
    '{"name":"fenced","version":"0.0.0"}\n',
  );
  await addPackage({
    root,
    spec: 'pkg:npm/tool@1.0.0',
    registryOptions: { transport: registry() },
  });
}

/** Whether this process may bind-mount (root in a namespace that allows it). */
const canBindMount: boolean = (() => {
  if (process.platform !== 'linux' || !ROOT) return false;
  const dir = mkdtempSync(join(tmpdir(), 'opm-fences-probe-'));
  try {
    execFileSync('mkdir', ['-p', join(dir, 'a'), join(dir, 'b')]);
    execFileSync('mount', ['--bind', join(dir, 'a'), join(dir, 'b')], {
      stdio: 'ignore',
    });
    execFileSync('umount', [join(dir, 'b')], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

describe.runIf(canBindMount)(
  'a project named through a bind mount of it',
  () => {
    it('fences what it holds: the default store a cache named through the mount would hold is not used, and nothing is made outside', async () => {
      const base = await world();
      const { root, outside } = await projectHoldingLink(base);
      const alias = join(base, 'alias');
      await mkdir(alias);
      execFileSync('mount', ['--bind', root, alias]);
      mounts.push(alias);
      vi.stubEnv('XDG_CACHE_HOME', join(alias, '.cache'));
      enableDefaultSharedStore(true);

      await addTool(root);
      expect(
        JSON.parse(
          await readFile(join(root, 'node_modules/tool/package.json'), 'utf8'),
        ),
      ).toMatchObject({ name: 'tool', version: '1.0.0' });
      expect(await usableSharedRoot(root)).toBeUndefined();
      await expect(
        ensureStableDirectory(join(alias, '.cache', 'openpacker', 'x')),
      ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
      expect(await readdir(outside, { recursive: true })).toEqual([]);
    });
  },
);

describe.runIf(POSIX && ROOT)(
  'a link another user put in a sticky directory anyone may write to',
  () => {
    it('is not followed to a project root, whatever fs.protected_symlinks says', async () => {
      const base = await world();
      const sticky = join(base, 'tmp');
      await mkdir(sticky);
      await chmod(sticky, 0o1777);
      const target = join(base, 'their-checkout');
      await mkdir(target);
      const link = join(sticky, 'project');
      await symlink(target, link);
      await lchown(link, NOBODY, NOBODY);

      await expect(
        initProject({ root: link, name: 'theirs' }),
      ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
      expect(await readdir(target)).toEqual([]);
    });
  },
);

describe.runIf(POSIX && ROOT)(
  'a link another user may have made, in a directory others may write to, sticky or not',
  () => {
    /** `<base>/shared` (mode 0777, not sticky) holding `<name> -> <base>/victim-private` (0700), owned by nobody. */
    async function theirLink(base: string, name: string) {
      const shared = join(base, 'shared');
      await mkdir(shared);
      await chmod(shared, 0o777);
      const victim = join(base, 'victim-private');
      await mkdir(victim, { mode: 0o700 });
      const link = join(shared, name);
      await symlink(victim, link);
      await lchown(link, NOBODY, NOBODY);
      return { link, victim };
    }

    it('is not taken as the tool cache, its last component, and nothing is written where it points', async () => {
      const base = await world();
      const { link, victim } = await theirLink(base, 'tc');

      await expect(openToolCache(link)).rejects.toMatchObject({
        code: 'UNSAFE_PATH',
      });
      await expect(
        writeStableFile(join(link, '.opm', 'store', 'x.json'), '{}'),
      ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
      expect(await readdir(victim)).toEqual([]);
    });

    it('is not taken as the configuration root, and no auth configuration is written where it points', async () => {
      const base = await world();
      const { link, victim } = await theirLink(base, 'config');

      await expect(
        upsertAuthOrigin({
          origin: 'https://registry.internal.example',
          path: join(link, 'auth.json'),
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
      expect(await readdir(victim)).toEqual([]);
    });
  },
);

describe.runIf(POSIX)('a store root taken before the project', () => {
  it('is no base once the project is taken, when it was reached through a link the project holds', async () => {
    const base = await world();
    const { root, outside } = await projectHoldingLink(base);
    const store = join(root, '.cache', 'store');
    await usableSharedRoot(root, { OPM_STORE_HOME: store });
    projectPaths(root);

    await expect(
      writeStableFile(join(store, 'sha256-entry', 'meta.json'), '{}'),
    ).rejects.toMatchObject({ code: expect.stringMatching(REFUSED) });
    expect(await readdir(join(outside, 'store'))).toEqual([]);
  });
});

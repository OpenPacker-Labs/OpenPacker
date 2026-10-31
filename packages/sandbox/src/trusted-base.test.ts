/**
 * A jail whose working directory or grants lie under a base reached through a
 * link: `TMPDIR` or `HOME` behind a link, macOS's `/var` → `/private/var`. The
 * base is bound at its real path, as every stable walk opens it (project-io
 * `trusted-base.ts`, ADR 0034); a link below it is still refused, and the
 * user home is recognised by its real path as well as by its name.
 */

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
import { openStableDirectory } from '@openpacker/project-io';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertGrantsNotDangerous,
  assertPathNotRootOrHome,
  assertSafeJailPath,
  createMockBackend,
  runInSandbox,
} from './index.js';

const worlds: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const world of worlds.splice(0))
    await rm(world, { recursive: true, force: true });
});

async function world(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'op-sandbox-base-'));
  worlds.push(dir);
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

const printCwdAndProof = [
  process.execPath,
  '-e',
  'process.stdout.write(process.cwd() + "|" + require("fs").readFileSync("proof", "utf8"))',
];

describe.runIf(process.platform === 'linux')(
  'a jail under a base reached through a link',
  () => {
    it('runs in, and binds, a directory under a TMPDIR that is a link, at its real path', async () => {
      const base = await world();
      const tmp = await linked(base, 'real-tmp', 'tmp-link');
      vi.stubEnv('TMPDIR', tmp.link);
      const cwd = await mkdtemp(join(tmpdir(), 'op-sandbox-'));
      await writeFile(join(cwd, 'proof'), 'stable');
      const real = join(tmp.real, cwd.split('/').at(-1)!);

      expect(assertSafeJailPath(cwd, 'cwd')).toBe(real);
      const outcome = await runInSandbox({
        argv: printCwdAndProof,
        cwd,
        policy: { mode: 'fail-closed' },
        readwritePaths: [cwd],
        readonlyPaths: [],
        backend: createMockBackend(),
      });
      expect(outcome).toMatchObject({ exitCode: 0, stdout: `${real}|stable` });
    });

    it('takes an authority opened through the link for the same directory', async () => {
      const base = await world();
      await mkdir(join(base, 'private/var/folders/xy/T'), { recursive: true });
      await symlink('private/var', join(base, 'var'), 'dir');
      vi.stubEnv('TMPDIR', join(base, 'var/folders/xy/T'));
      const cwd = join(tmpdir(), 'package');
      await mkdir(cwd);
      await writeFile(join(cwd, 'proof'), 'held');
      const authority = await openStableDirectory(cwd);
      try {
        const outcome = await runInSandbox({
          argv: printCwdAndProof,
          cwd,
          policy: { mode: 'fail-closed' },
          readwritePaths: [cwd],
          readonlyPaths: [],
          directoryAuthorities: [{ fd: authority.fd, path: cwd }],
          backend: createMockBackend(),
        });
        expect(outcome).toMatchObject({
          exitCode: 0,
          stdout: `${join(base, 'private/var/folders/xy/T/package')}|held`,
        });
      } finally {
        await authority.close();
      }
    });

    it('still refuses a grant that runs through a link below the base', async () => {
      const base = await world();
      const tmp = await linked(base, 'real-tmp', 'tmp-link');
      vi.stubEnv('TMPDIR', tmp.link);
      await mkdir(join(base, 'outside'));
      await symlink(join(base, 'outside'), join(tmp.real, 'alias'));

      expect(() =>
        assertSafeJailPath(join(tmpdir(), 'alias', 'pkg'), 'grant'),
      ).toThrow(/symbolic links/u);
      await expect(
        runInSandbox({
          argv: printCwdAndProof,
          cwd: join(tmpdir(), 'alias'),
          policy: { mode: 'fail-closed' },
          readwritePaths: [join(tmpdir(), 'alias')],
          readonlyPaths: [],
          backend: createMockBackend(),
        }),
      ).rejects.toThrow(/symbolic links/u);
    });

    it('knows the user home by its real path when HOME is a link', async () => {
      const base = await world();
      const home = await linked(base, 'home-real', 'home-link');
      vi.stubEnv('HOME', home.link);

      expect(() =>
        assertPathNotRootOrHome(home.real, false, 'package-exec cwd'),
      ).toThrow(/user home/u);
      expect(() =>
        assertGrantsNotDangerous([join(home.real, '.cache')], false),
      ).toThrow(/under home/u);
      expect(() =>
        assertGrantsNotDangerous(
          [assertSafeJailPath(join(home.link, '.cache'), 'write grant')],
          false,
        ),
      ).toThrow(/under home/u);
      expect(() =>
        assertPathNotRootOrHome(join(home.link, 'project'), false, 'cwd'),
      ).not.toThrow();
    });
  },
);

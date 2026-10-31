/**
 * opmx in a project this user may not write: a read-only mount, a CI cache,
 * another user's checkout. opmx activates the project's generation on every
 * run, and activation rewrote the bin shims and the project state each time,
 * so it failed with a bare `EACCES … unlink '/proc/self/fd/N/<bin>'` before
 * running anything. A project already up to date now runs with no write at
 * all; one out of date is refused in one line that says what is out of date
 * and what to do.
 *
 * The project is read-only as on a read-only mount: bwrap binds it so for the
 * built opmx, since root writes whatever the mode bits say. Run
 * `npm run build -w @openpacker/opm` first.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appRoot } from './bins-fixture.js';
import {
  INSTALLED_TIMEOUT_MS,
  binPackage,
  installedProject,
} from './installed-fixture.js';
import { canSandbox } from './signal-fixture.js';

const bwrap = ['/usr/bin/bwrap', '/bin/bwrap'].find((path) => existsSync(path));
const opmx = join(appRoot, 'dist', 'opmx-main.js');
const hello = binPackage('hello', "process.stdout.write('hello\\n');\n");

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A temporary directory, home and caches of the run's own. */
async function own(): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), 'opmx-readonly-own-'));
  temps.push(dir);
  for (const name of ['cache', 'config', 'data', 'state'])
    await mkdir(join(dir, name));
  return {
    PATH: process.env.PATH,
    HOME: dir,
    TMPDIR: dir,
    XDG_CACHE_HOME: join(dir, 'cache'),
    XDG_CONFIG_HOME: join(dir, 'config'),
    XDG_DATA_HOME: join(dir, 'data'),
    XDG_STATE_HOME: join(dir, 'state'),
    OPM_STORE_HOME: 'off',
    NODE_NO_WARNINGS: '1',
  };
}

/** The built opmx on `args` in `root`, which it sees read-only when `readOnly`. */
function run(
  root: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  readOnly: boolean,
) {
  const command = readOnly
    ? [
        bwrap!,
        '--dev-bind',
        '/',
        '/',
        '--ro-bind',
        root,
        root,
        process.execPath,
        opmx,
        ...args,
      ]
    : [process.execPath, opmx, ...args];
  return new Promise<{ status: number | null; out: string; err: string }>(
    (settle, fail) => {
      const child = spawn(command[0]!, command.slice(1), {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        out += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        err += chunk;
      });
      child.on('error', fail);
      child.on('close', (status) => settle({ status, out, err }));
    },
  );
}

/** Every entry under `dir`: its inode, size, mode and modification time. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const seen: Record<string, string> = {};
  const walk = async (at: string, name: string): Promise<void> => {
    const info = await lstat(at, { bigint: true });
    seen[name] = `${info.ino} ${info.size} ${info.mode} ${info.mtimeNs}`;
    if (info.isDirectory())
      for (const child of (await readdir(at)).sort())
        await walk(join(at, child), `${name}/${child}`);
  };
  await walk(dir, '.');
  return seen;
}

/**
 * A project that installed `hello`, run once by the built opmx where it may
 * write, as its owner would: that run activates it, and the shims it writes
 * start this opmx. Skipped, before anything else, where bwrap cannot bind it
 * read-only here.
 */
async function activated(context: { skip(when: boolean, why: string): void }) {
  expect(existsSync(opmx), 'run: npm run build -w @openpacker/opm').toBe(true);
  const root = await installedProject([hello]);
  const probe = spawnSync(bwrap!, [
    '--dev-bind',
    '/',
    '/',
    '--ro-bind',
    root,
    root,
    'true',
  ]);
  context.skip(
    probe.status !== 0,
    'bwrap cannot bind a directory read-only here',
  );
  const env = await own();
  const first = await run(root, ['hello'], env, false);
  expect([first.status, first.out], first.err).toEqual([0, 'hello\n']);
  const shim = join(root, '.opm', 'bin', 'hello');
  expect(await readFile(shim, 'utf8')).toContain(JSON.stringify(opmx));
  return { root, env, shim };
}

/**
 * Make `shim` start an opmx of another opm, at a path outside the project, as
 * an opm installed there would have written it; that opmx is an executable
 * file.
 */
async function startingAnother(
  shim: string,
  layout: 'file' | 'npm global link' = 'file',
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opmx-readonly-other-'));
  temps.push(dir);
  const other =
    layout === 'file' ? join(dir, 'opmx') : join(dir, 'bin', 'opmx');
  // As a global npm install lays opm out: `bin/opmx`, a link to the
  // package's executable `dist/opmx-main.js`.
  const file =
    layout === 'file'
      ? other
      : join(
          dir,
          'lib',
          'node_modules',
          '@openpacker',
          'opm',
          'dist',
          'opmx-main.js',
        );
  if (layout !== 'file') {
    await mkdir(join(file, '..'), { recursive: true });
    await mkdir(join(dir, 'bin'));
    await symlink(
      '../lib/node_modules/@openpacker/opm/dist/opmx-main.js',
      other,
    );
  }
  await writeFile(file, '#!/bin/sh\nexit 0\n');
  await chmod(file, 0o755);
  const script = await readFile(shim, 'utf8');
  expect(script).toContain(JSON.stringify(opmx));
  await writeFile(
    shim,
    script.replace(JSON.stringify(opmx), JSON.stringify(other)),
  );
  return other;
}

describe.runIf(canSandbox && bwrap !== undefined)(
  'opmx in a project this user may not write',
  { timeout: INSTALLED_TIMEOUT_MS },
  () => {
    it('runs the tool, and writes nothing, when the project is up to date', async (context) => {
      const { root, env } = await activated(context);
      const before = await snapshot(root);
      const ran = await run(root, ['hello'], env, true);
      expect([ran.status, ran.out, ran.err]).toEqual([0, 'hello\n', '']);
      expect(await snapshot(root)).toEqual(before);
    });

    it('is refused in one line, saying what is out of date and what to do', async (context) => {
      const { root, env, shim } = await activated(context);
      await writeFile(shim, '#!/bin/sh\nexit 3\n');
      const ran = await run(root, ['hello'], env, true);
      expect([ran.status, ran.out, ran.err]).toEqual([
        8,
        '',
        'opmx: .opm/bin/hello is out of date for the active generation, and ' +
          `this user may not write ${root}: run \`opm install\` there as its owner\n`,
      ]);
      expect(await readFile(shim, 'utf8')).toBe('#!/bin/sh\nexit 3\n');
    });

    it('runs the tool, and writes nothing, when its shims start another opmx that is there', async (context) => {
      const { root, env, shim } = await activated(context);
      await startingAnother(shim);
      const before = await snapshot(root);
      const ran = await run(root, ['hello'], env, true);
      expect([ran.status, ran.out, ran.err]).toEqual([0, 'hello\n', '']);
      expect(await snapshot(root)).toEqual(before);
    });

    it('runs the tool, and writes nothing, when its shims name a global npm link to an opmx', async (context) => {
      const { root, env, shim } = await activated(context);
      await startingAnother(shim, 'npm global link');
      const before = await snapshot(root);
      const ran = await run(root, ['hello'], env, true);
      expect([ran.status, ran.out, ran.err]).toEqual([0, 'hello\n', '']);
      expect(await snapshot(root)).toEqual(before);
    });

    it('is refused in one line, naming the shim, when the opmx it starts is gone', async (context) => {
      const { root, env, shim } = await activated(context);
      const other = await startingAnother(shim);
      await rm(other);
      const ran = await run(root, ['hello'], env, true);
      expect([ran.status, ran.out, ran.err]).toEqual([
        8,
        '',
        `opmx: .opm/bin/hello starts ${other}, which is missing or not a ` +
          `program, and this user may not write ${root}: run \`opm install\` ` +
          'there as its owner\n',
      ]);
    });

    it('rewrites such shims to start this opmx where it may write, as before', async (context) => {
      const { root, env, shim } = await activated(context);
      const written = await readFile(shim, 'utf8');
      await startingAnother(shim);
      const ran = await run(root, ['hello'], env, false);
      expect([ran.status, ran.out], ran.err).toEqual([0, 'hello\n']);
      expect(await readFile(shim, 'utf8')).toBe(written);
    });
  },
);

describe.skipIf(canSandbox && bwrap !== undefined)(
  'opmx in a project this user may not write',
  () => {
    it.skip('needs bwrap (/usr/bin/bwrap); not checked on this host', () => {});
  },
);

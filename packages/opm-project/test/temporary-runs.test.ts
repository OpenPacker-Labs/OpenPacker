import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { currentOwner } from '../src/process-owner.js';
import { writeOwnerFile } from '../src/owner-file.js';
import { makeTemporaryScratch } from '../src/run-scratch.js';
import { removeStableTree } from '../src/paths.js';

/**
 * Where a run makes what its project cannot hold (a read-only checkout):
 * `openpacker-runs` under the temporary directory. It was one name for every
 * user, so on a shared /tmp the first user's made every other user's run be
 * refused: it was not theirs. It is one per user now, as the sandbox's jail
 * root is, and what this user's ended runs left under the old name is still
 * removed.
 */

const NOBODY = 65534;
const uid = process.geteuid?.();
const source = fileURLToPath(new URL('../src/', import.meta.url));
const hook = new URL('./fixtures/ts-resolve.mjs', import.meta.url).href;

const temps: string[] = [];
const restores: (() => void)[] = [];
afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A temporary directory of the test's own, made the process's TMPDIR. */
async function ownTmpdir(): Promise<string> {
  const dir = await mkdtemp(join(realpathSync.native(tmpdir()), 'opm-runs-'));
  temps.push(dir);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  restores.push(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
  return dir;
}

/** The pid of a process that has ended. */
async function ended(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

/** Make a scratch directory there, and remove it again. */
async function aRun(): Promise<string> {
  const scratch = await makeTemporaryScratch('run-');
  await removeStableTree(scratch.path);
  return scratch.path;
}

describe('the temporary runs directory', () => {
  it('is this user’s own, named by the uid', async () => {
    const dir = await ownTmpdir();
    const made = await aRun();
    const root = join(dir, `openpacker-runs-${uid}`);
    expect(made.startsWith(`${root}/run-`)).toBe(true);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ['0755', 0o755],
    ['0775', 0o775],
  ])('is made 0700 when this user owns it and it is %s', async (_, mode) => {
    const dir = await ownTmpdir();
    const root = join(dir, `openpacker-runs-${uid}`);
    await mkdir(root);
    await chmod(root, mode);
    await aRun();
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
  });

  it('is refused when others may write it', async () => {
    const dir = await ownTmpdir();
    const root = join(dir, `openpacker-runs-${uid}`);
    await mkdir(root);
    await chmod(root, 0o777);
    await expect(aRun()).rejects.toThrow(
      `The temporary runs directory ${root} can be written by others (mode 777)`,
    );
    expect(await readdir(root)).toEqual([]);
  });

  it('still has what ended runs of this user left under the old shared name removed', async () => {
    const dir = await ownTmpdir();
    const shared = join(dir, 'openpacker-runs');
    const left = join(shared, 'run-left');
    await mkdir(join(left, 'tree'), { recursive: true, mode: 0o700 });
    await chmod(shared, 0o700);
    await writeOwnerFile(left, {
      ...(await currentOwner()),
      pid: await ended(),
    });
    await aRun();
    expect(existsSync(left)).toBe(false);
  });

  it.runIf(uid === 0)(
    'is not stopped by the old shared one another user made',
    async () => {
      const dir = await ownTmpdir();
      const shared = join(dir, 'openpacker-runs');
      await mkdir(shared, { mode: 0o700 });
      await chown(shared, NOBODY, NOBODY);
      await expect(aRun()).resolves.toContain(`openpacker-runs-${uid}`);
    },
  );
});

/** Whether a user other than the owner may pass through every directory down to `path`. */
async function traversable(path: string): Promise<boolean> {
  let dir = realpathSync.native(path);
  for (;;) {
    if (((await stat(dir)).mode & 0o001) === 0) return false;
    const parent = dirname(dir);
    if (parent === dir) return true;
    dir = parent;
  }
}

/**
 * Where the second user's shared temporary directory is made: under the
 * temporary directory when others may pass through every directory above it,
 * else under /tmp. A TMPDIR inside a private directory (an agent's scratch
 * under a 0700 one) keeps the second user out of a directory made in it
 * however open that directory is, which says nothing of the rule.
 */
async function sharedBase(): Promise<string | undefined> {
  for (const base of [tmpdir(), '/tmp'])
    if (await traversable(base)) return realpathSync.native(base);
  return undefined;
}

/** Makes and removes a scratch directory, as the run of a second user would. */
const RUN = `
const [src] = process.argv.slice(1);
const { makeTemporaryScratch } = await import(src + 'run-scratch.ts');
const { removeStableTree } = await import(src + 'paths.ts');
try {
  const scratch = await makeTemporaryScratch('run-');
  await removeStableTree(scratch.path);
  process.stdout.write(JSON.stringify({ path: scratch.path }));
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code, message: error.message }));
}
`;

describe.runIf(uid === 0)(
  'a second user’s run on a temporary directory users share',
  () => {
    it('runs, beside the first user’s directory', async (context) => {
      // Shared as /tmp is: anyone may make a name in it, and remove only theirs.
      const base = await sharedBase();
      if (base === undefined)
        return context.skip(
          `neither the temporary directory nor /tmp can be reached by uid ${NOBODY}`,
        );
      const shared = await mkdtemp(join(base, 'opm-shared-'));
      temps.push(shared);
      await chmod(shared, 0o1777);
      // Without the CA bundle and options only root may read.
      const env = Object.fromEntries(
        Object.entries({
          ...process.env,
          TMPDIR: shared,
          NODE_NO_WARNINGS: '1',
        }).filter(
          ([key]) => key !== 'NODE_EXTRA_CA_CERTS' && key !== 'NODE_OPTIONS',
        ),
      );
      const node = (asNobody: boolean) =>
        spawnSync(
          process.execPath,
          [
            '--experimental-transform-types',
            '--import',
            hook,
            '--input-type=module',
            '-e',
            RUN,
            source,
          ],
          {
            cwd: shared,
            env,
            encoding: 'utf8',
            ...(asNobody && { uid: NOBODY, gid: NOBODY }),
          },
        );
      // Whether uid 65534 can load what it runs here: only this decides a skip.
      const probe = spawnSync(
        process.execPath,
        [
          '--experimental-transform-types',
          '--import',
          hook,
          '--input-type=module',
          '-e',
          'await import(process.argv[1] + "run-scratch.ts")',
          source,
        ],
        { cwd: shared, env, encoding: 'utf8', uid: NOBODY, gid: NOBODY },
      );
      context.skip(
        probe.status !== 0,
        `uid ${NOBODY} cannot load the sources here: ${probe.stderr.slice(0, 200)}`,
      );
      // The first user's run, here root's, as this process.
      const first = node(false);
      expect(JSON.parse(first.stdout), first.stderr).toHaveProperty('path');
      const second = node(true);
      const outcome = JSON.parse(second.stdout) as { path?: string };
      expect(outcome, second.stderr).toEqual({
        path: expect.stringContaining(
          join(shared, `openpacker-runs-${NOBODY}`, 'run-'),
        ),
      });
    });
  },
);

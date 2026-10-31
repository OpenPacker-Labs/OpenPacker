import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A run's layout was made beside the store it links from, in
 * `<root>/.opm/runs`, and nowhere else: in a checkout this user may read and
 * not write (a read-only mount, another user's tree) it could not be made,
 * and the bin did not run. It is made in `openpacker-runs-<uid>` under the
 * temporary directory then, which must be this user's and no one else's.
 *
 * The project is read-only here as on a read-only mount: bwrap binds it so for
 * a child that lays a tool out, since root writes whatever the mode bits say.
 */

const bwrap = ['/usr/bin/bwrap', '/bin/bwrap'].find((path) => existsSync(path));
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const source = fileURLToPath(new URL('../src/', import.meta.url));
const hook = new URL('./fixtures/ts-resolve.mjs', import.meta.url).href;
const DIGEST = '1'.repeat(64);

/** Lays `bare` out from the store under `cacheRoot` and says where, and whether it was whole. */
const LAY_OUT = `
const [src, cacheRoot, storePath] = process.argv.slice(1);
const { configureDefaultAdapters } = await import('@openpacker/adapters-default');
configureDefaultAdapters();
const { existsSync } = await import('node:fs');
const { layOutTool } = await import(src + 'ephemeral-layout.ts');
const layout = await layOutTool({
  cacheRoot,
  tool: 'pkg:npm/bare@1.0.0',
  closure: [{
    exactPurl: 'pkg:npm/bare@1.0.0',
    digest: 'sha256:${DIGEST}',
    size: 1,
    source: 'https://registry.npmjs.org/bare/-/bare-1.0.0.tgz',
    storePath,
  }],
});
const whole = existsSync(layout.entry('cli.js'));
await layout.dispose();
process.stdout.write(JSON.stringify({ root: layout.root, whole }));
`;

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A project with `bare` in its store, and a temporary directory of the run's own. */
async function places() {
  const base = await mkdtemp(join(tmpdir(), 'opm-layout-readonly-'));
  temps.push(base);
  const cacheRoot = join(base, 'project');
  const storePath = join(cacheRoot, '.opm', 'store', `sha256-${DIGEST}`);
  await mkdir(storePath, { recursive: true });
  await writeFile(join(storePath, 'cli.js'), '');
  const own = join(base, 'tmp');
  await mkdir(own);
  return { cacheRoot, storePath, own };
}

/** Lay `bare` out in a child that sees `cacheRoot` read-only. */
function layOut(where: Awaited<ReturnType<typeof places>>) {
  return new Promise<{ status: number | null; out: string; err: string }>(
    (settle, fail) => {
      const child = spawn(
        bwrap!,
        [
          '--dev-bind',
          '/',
          '/',
          // bwrap makes a mount point through no link: the project is bound
          // at its real path, where the child's spelling of it leads.
          '--ro-bind',
          realpathSync(where.cacheRoot),
          realpathSync(where.cacheRoot),
          process.execPath,
          '--experimental-transform-types',
          '--import',
          hook,
          '--input-type=module',
          '-e',
          LAY_OUT,
          source,
          where.cacheRoot,
          where.storePath,
        ],
        {
          cwd: packageRoot,
          env: { ...process.env, TMPDIR: where.own, NODE_NO_WARNINGS: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
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

describe.runIf(process.platform === 'linux' && bwrap !== undefined)(
  'a tool laid out from a store it may not write beside',
  () => {
    it('is laid out in a private directory under the temporary directory, and removed', async () => {
      const where = await places();
      const ran = await layOut(where);
      expect(ran.status, ran.err).toBe(0);
      const { root, whole } = JSON.parse(ran.out) as {
        root: string;
        whole: boolean;
      };
      // The layout is at the real path of its base, TMPDIR (ADR 0034).
      const runs = join(
        realpathSync(where.own),
        `openpacker-runs-${process.geteuid?.()}`,
      );
      expect([whole, root.startsWith(join(runs, 'run-'))]).toEqual([
        true,
        true,
      ]);
      expect(((await stat(runs)).mode & 0o777).toString(8)).toBe('700');
      expect(await readdir(runs)).toEqual([]);
      expect(existsSync(join(where.cacheRoot, '.opm', 'runs'))).toBe(false);
    });

    it('is refused when others may write that directory', async () => {
      const where = await places();
      const runs = join(where.own, `openpacker-runs-${process.geteuid?.()}`);
      await mkdir(runs);
      await chmod(runs, 0o777);
      const ran = await layOut(where);
      expect(ran.status).not.toBe(0);
      expect(ran.err).toContain(
        `The temporary runs directory ${runs} can be written by others (mode 777)`,
      );
      expect(await readdir(runs)).toEqual([]);
    });
  },
);

describe.skipIf(process.platform === 'linux' && bwrap !== undefined)(
  'a tool laid out from a store it may not write beside',
  () => {
    it.skip('needs bwrap (/usr/bin/bwrap); not checked on this host', () => {});
  },
);

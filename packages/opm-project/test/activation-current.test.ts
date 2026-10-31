import { spawn } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activateGeneration,
  initProject,
  installFromLock,
  projectPaths,
  readEnvironmentState,
  readGeneration,
  readManifestFile,
  resolveManifestToLock,
  writeLockfile,
  writeManifestFile,
} from '../src/index.js';
import { NpmRegistryFixture } from './npm-registry-fixture.js';

/**
 * opmx activates the project's generation on every run, and activation
 * rewrote every bin shim, every link and the project state each time. So opmx
 * could not run in a project this user may not write (a read-only mount, a CI
 * cache, another user's checkout): it failed on its first shim with a bare
 * EACCES. Activation now writes nothing when the project already holds what
 * it would write; where it must write and cannot, it says what is out of date
 * and how to bring it up to date.
 */

const bwrap = ['/usr/bin/bwrap', '/bin/bwrap'].find((path) => existsSync(path));
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const source = fileURLToPath(new URL('../src/', import.meta.url));
const hook = new URL('./fixtures/ts-resolve.mjs', import.meta.url).href;

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A project that installed `runner`, whose one bin is `runner`, or `bins`. */
async function installed(
  bins: Record<string, string> = { runner: 'cli.js' },
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-activation-'));
  temps.push(root);
  await initProject({ root, name: 'activation' });
  const paths = projectPaths(root);
  const manifest = await readManifestFile(paths.manifest);
  manifest.project.ecosystems = ['npm'];
  manifest.packages = {
    runner: { alias: 'runner', purl: 'pkg:npm/runner', version: '1.0.0' },
  };
  const registry = new NpmRegistryFixture([
    {
      name: 'runner',
      versions: {
        '1.0.0': {
          bin: bins,
          files: { 'cli.js': "#!/usr/bin/env node\nconsole.log('ran');\n" },
        },
      },
    },
  ]);
  const lock = await resolveManifestToLock({
    root,
    manifest,
    offline: false,
    registryOptions: { transport: registry },
  });
  await writeManifestFile(paths.manifest, manifest);
  await writeLockfile(paths.lock, lock);
  await installFromLock({ root, lock, offline: false });
  return root;
}

async function activate(root: string) {
  const environment = await readEnvironmentState(root);
  const generation = await readGeneration(
    root,
    environment!.currentGenerationDigest,
  );
  return await activateGeneration({ root, generation });
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
 * A shim as an opm installed at `opmx` would have written it: the same script
 * but for the `opmx` it starts.
 */
async function startingOpmx(root: string, opmx: string): Promise<string> {
  const shim = join(projectPaths(root).bin, 'runner');
  const script = await readFile(shim, 'utf8');
  const line = /^const opmx = process\.env\.OPM_OPMX\?\.trim\(\) \|\| .*;$/mu;
  expect(script).toMatch(line);
  await writeFile(
    shim,
    script.replace(
      line,
      `const opmx = process.env.OPM_OPMX?.trim() || ${JSON.stringify(opmx)};`,
    ),
  );
  return shim;
}

/** An `opmx` of another opm, outside the project: an executable file. */
async function otherOpmx(mode = 0o755): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opm-activation-opmx-'));
  temps.push(dir);
  const opmx = join(dir, 'opmx');
  await writeFile(opmx, '#!/bin/sh\nexit 0\n');
  await chmod(opmx, mode);
  return opmx;
}

/**
 * opm as a global npm install lays it out: `<prefix>/bin/opmx`, a link to the
 * package's `dist/opmx-main.js`, which npm makes executable. The link is what
 * a shim written by that opm names.
 */
async function npmGlobalOpmx(): Promise<{ link: string; target: string }> {
  const prefix = await mkdtemp(join(tmpdir(), 'opm-activation-prefix-'));
  temps.push(prefix);
  const dist = join(
    prefix,
    'lib',
    'node_modules',
    '@openpacker',
    'opm',
    'dist',
  );
  await mkdir(dist, { recursive: true });
  await mkdir(join(prefix, 'bin'));
  const target = join(dist, 'opmx-main.js');
  await writeFile(target, '#!/usr/bin/env node\n');
  await chmod(target, 0o755);
  const link = join(prefix, 'bin', 'opmx');
  await symlink('../lib/node_modules/@openpacker/opm/dist/opmx-main.js', link);
  return { link, target };
}

describe('a package with a bin whose name starts with "-"', () => {
  it('is installed and activated, that bin with no shim, the others with theirs', async () => {
    const root = await installed({ runner: 'cli.js', '-x': 'cli.js' });
    expect(await readdir(projectPaths(root).bin)).toEqual(['runner']);
    const state = await activate(root);
    expect(state.packages.runner!.bins.map((bin) => bin.name)).toEqual([
      'runner',
    ]);
    expect(await readdir(projectPaths(root).bin)).toEqual(['runner']);
  });
});

describe('activating the active generation', () => {
  it('writes nothing when the project holds what it would write', async () => {
    const root = await installed();
    const before = await snapshot(join(root, '.opm'));
    const state = await activate(root);
    expect(Object.keys(state.packages)).toEqual(['runner']);
    expect(await snapshot(join(root, '.opm'))).toEqual(before);
  });

  it('rewrites a shim that is out of date where it may write, as before', async () => {
    const root = await installed();
    const shim = join(projectPaths(root).bin, 'runner');
    const written = await readFile(shim, 'utf8');
    await writeFile(shim, '#!/bin/sh\nexit 3\n');
    await activate(root);
    expect(await readFile(shim, 'utf8')).toBe(written);
  });

  it('rewrites a shim that starts another opmx where it may write, to start this one', async () => {
    const root = await installed();
    const shim = join(projectPaths(root).bin, 'runner');
    const written = await readFile(shim, 'utf8');
    await startingOpmx(root, await otherOpmx());
    await activate(root);
    expect(await readFile(shim, 'utf8')).toBe(written);
  });
});

/** Activates in a child that sees `root` read-only, as on a read-only mount. */
const ACTIVATE = `
const [src, root] = process.argv.slice(1);
const { configureDefaultAdapters } = await import('@openpacker/adapters-default');
configureDefaultAdapters();
const opm = await import(src + 'index.ts');
const environment = await opm.readEnvironmentState(root);
const generation = await opm.readGeneration(root, environment.currentGenerationDigest);
try {
  const state = await opm.activateGeneration({ root, generation });
  process.stdout.write(JSON.stringify({ packages: Object.keys(state.packages) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code, message: error.message }));
}
`;

function activateReadOnly(root: string) {
  return new Promise<{ status: number | null; out: string; err: string }>(
    (settle, fail) => {
      const child = spawn(
        bwrap!,
        [
          '--dev-bind',
          '/',
          '/',
          '--ro-bind',
          root,
          root,
          process.execPath,
          '--experimental-transform-types',
          '--import',
          hook,
          '--input-type=module',
          '-e',
          ACTIVATE,
          source,
          root,
        ],
        {
          cwd: packageRoot,
          env: { ...process.env, NODE_NO_WARNINGS: '1' },
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
  'activating it in a project this user may not write',
  () => {
    it('needs no write when the project holds what it would write', async () => {
      const root = await installed();
      const ran = await activateReadOnly(root);
      expect([ran.status, JSON.parse(ran.out)], ran.err).toEqual([
        0,
        { packages: ['runner'] },
      ]);
    });

    it('is refused, saying which shim is out of date and how to update it', async () => {
      const root = await installed();
      const shim = join(projectPaths(root).bin, 'runner');
      await writeFile(shim, '#!/bin/sh\nexit 3\n');
      const ran = await activateReadOnly(root);
      expect(JSON.parse(ran.out), ran.err).toEqual({
        code: 'PROJECT_READ_ONLY',
        message:
          '.opm/bin/runner is out of date for the active generation, and ' +
          `this user may not write ${root}: run \`opm install\` there as its owner`,
      });
      expect(await readFile(shim, 'utf8')).toBe('#!/bin/sh\nexit 3\n');
    });

    it('needs no write when its shims start another opmx that is there', async () => {
      const root = await installed();
      const opmx = await otherOpmx();
      const shim = await startingOpmx(root, opmx);
      const held = await readFile(shim, 'utf8');
      const ran = await activateReadOnly(root);
      expect([ran.status, JSON.parse(ran.out)], ran.err).toEqual([
        0,
        { packages: ['runner'] },
      ]);
      expect(await readFile(shim, 'utf8')).toBe(held);
    });

    it.each([
      ['missing', async (opmx: string) => rm(opmx)],
      ['not executable', async (opmx: string) => chmod(opmx, 0o644)],
    ])(
      'is refused, naming the shim, when the opmx it starts is %s',
      async (_, spoil) => {
        const root = await installed();
        const opmx = await otherOpmx();
        await startingOpmx(root, opmx);
        await spoil(opmx);
        const ran = await activateReadOnly(root);
        expect(JSON.parse(ran.out), ran.err).toEqual({
          code: 'PROJECT_READ_ONLY',
          message:
            `.opm/bin/runner starts ${opmx}, which is missing or not a ` +
            `program, and this user may not write ${root}: run ` +
            '`opm install` there as its owner',
        });
      },
    );

    it('needs no write when its shims name a global npm link to an opmx', async () => {
      const root = await installed();
      const { link } = await npmGlobalOpmx();
      const shim = await startingOpmx(root, link);
      const held = await readFile(shim, 'utf8');
      const ran = await activateReadOnly(root);
      expect([ran.status, JSON.parse(ran.out)], ran.err).toEqual([
        0,
        { packages: ['runner'] },
      ]);
      expect(await readFile(shim, 'utf8')).toBe(held);
    });

    it.each([
      ['dangling', async (target: string) => rm(target)],
      [
        'to a directory',
        async (target: string) => {
          await rm(target);
          await mkdir(target);
        },
      ],
      [
        'to a file it may not run',
        async (target: string) => chmod(target, 0o644),
      ],
    ])(
      'is refused, naming the shim, when the link its shims name is %s',
      async (_, spoil) => {
        const root = await installed();
        const { link, target } = await npmGlobalOpmx();
        await startingOpmx(root, link);
        await spoil(target);
        const ran = await activateReadOnly(root);
        expect(JSON.parse(ran.out), ran.err).toEqual({
          code: 'PROJECT_READ_ONLY',
          message:
            `.opm/bin/runner starts ${link}, which is missing or not a ` +
            `program, and this user may not write ${root}: run ` +
            '`opm install` there as its owner',
        });
      },
    );

    it.each([
      ['/usr/bin/env', async () => '/usr/bin/env'],
      [
        'a program named foo',
        async () => {
          const dir = await mkdtemp(join(tmpdir(), 'opm-activation-foo-'));
          temps.push(dir);
          const foo = join(dir, 'foo');
          await writeFile(foo, '#!/bin/sh\nexit 0\n');
          await chmod(foo, 0o755);
          return foo;
        },
      ],
      [
        'a link named opmx to a program named foo',
        async () => {
          const dir = await mkdtemp(join(tmpdir(), 'opm-activation-foo-'));
          temps.push(dir);
          await writeFile(join(dir, 'foo'), '#!/bin/sh\nexit 0\n');
          await chmod(join(dir, 'foo'), 0o755);
          await symlink('foo', join(dir, 'opmx'));
          return join(dir, 'opmx');
        },
      ],
    ])(
      'is refused, naming the shim, when its shims start %s, which is no opmx',
      async (_, made) => {
        const root = await installed();
        const named = await made();
        await startingOpmx(root, named);
        const ran = await activateReadOnly(root);
        expect(JSON.parse(ran.out), ran.err).toEqual({
          code: 'PROJECT_READ_ONLY',
          message:
            `.opm/bin/runner starts ${named}, which is not an opmx, and ` +
            `this user may not write ${root}: run \`opm install\` there as ` +
            'its owner',
        });
      },
    );

    it('is refused, naming the project state when that is out of date', async () => {
      const root = await installed();
      const paths = projectPaths(root);
      // The project state as it would be with the bin forgotten.
      const state = JSON.parse(await readFile(paths.projectState, 'utf8')) as {
        packages: Record<string, { bins: unknown[] }>;
      };
      state.packages.runner!.bins = [];
      await writeFile(paths.projectState, `${JSON.stringify(state)}\n`);
      const ran = await activateReadOnly(root);
      expect(JSON.parse(ran.out), ran.err).toMatchObject({
        code: 'PROJECT_READ_ONLY',
        message: expect.stringMatching(
          /^\.opm\/project\.json is out of date for the active generation, /u,
        ),
      });
    });
  },
);

describe.skipIf(process.platform === 'linux' && bwrap !== undefined)(
  'activating it in a project this user may not write',
  () => {
    it.skip('needs bwrap (/usr/bin/bwrap); not checked on this host', () => {});
  },
);

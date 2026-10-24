import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  recordGeneration,
  storePathForDigest,
  type InstalledPackageRecord,
} from '@openpacker/opm-project';
import {
  canSandbox,
  PLAIN_NODE,
  signalledScript,
  source,
} from './signal-fixture.js';

/**
 * `runOpmx` itself, not the pieces it is made of, holds SIGINT, SIGTERM and
 * SIGHUP while a tool runs, of an installed project or straight from a
 * registry: the run ends the tool, removes the store view or the layout it
 * made, and opmx ends by the very signal. The piece tests
 * (opmx-signals.test.ts) wire `holdingSignals` and `runTool` by hand, so they
 * cannot tell a `runOpmx` that holds nothing.
 */

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const idle = 'setInterval(() => {}, 1000);\n';

/**
 * A project of fifteen installed packages, one more than the handles left for
 * a run beside its project and the jail's home, so a run that binds their
 * store binds it through a view. The first has a bin `idler`, which runs from
 * a layout of the npm packages in `.opm/runs`; `.opm/bin/direct` is a file no
 * package of the project owns, which runs with the store bound.
 */
async function installedProject() {
  const root = await mkdtemp(join(tmpdir(), 'opmx-run-signals-'));
  temps.push(root);
  await writeFile(join(root, 'opm.toml'), 'name = "signals"\n');
  const packages: Record<string, InstalledPackageRecord> = {};
  for (let i = 0; i < 15; i += 1) {
    const alias = `p${i}`;
    const digest = `sha256:${i.toString(16).padStart(64, '0')}`;
    const storePath = storePathForDigest(root, digest);
    await mkdir(storePath, { recursive: true });
    await writeFile(
      join(storePath, i === 0 ? 'cli.js' : 'index.js'),
      i === 0 ? idle : `module.exports = ${i};\n`,
    );
    packages[alias] = {
      alias,
      purl: `pkg:npm/${alias}@1.0.0`,
      digest,
      storePath,
      bins:
        i === 0
          ? [{ name: 'idler', path: 'cli.js', shim: '', target: '' }]
          : [],
      installedAt: '2026-01-01T00:00:00.000Z',
    };
  }
  await recordGeneration({
    root,
    packages,
    lockDigest: `sha256:${'0'.repeat(64)}`,
  });
  await mkdir(join(root, '.opm', 'bin'), { recursive: true });
  await writeFile(join(root, '.opm', 'bin', 'direct'), idle);
  return { root, store: join(root, '.opm', 'store') };
}

/**
 * `runOpmx` in a child process, killed by `signal` once the tool is running
 * and the one thing the run made for it is there: a store view, or a layout.
 */
async function killedRun(
  bin: string,
  signal: NodeJS.Signals,
  made: 'view' | 'layout',
) {
  const { root, store } = await installedProject();
  const runs = join(root, '.opm', 'runs');
  const views = async () =>
    (await readdir(store)).filter((name) => name.startsWith('.view-'));
  const layouts = async () => await readdir(runs).catch(() => []);
  const marker = `--opmx-run-signals-${randomUUID()}`;
  const run = await signalledScript({
    work: root,
    marker,
    signal,
    made: async () =>
      (await (made === 'view' ? views : layouts)()).length === 1,
    script: `import { runOpmx } from ${source('../src/opmx.ts')};
     ${PLAIN_NODE}
     process.exitCode = await runOpmx(${JSON.stringify([bin, '--', marker])}, process, ${JSON.stringify(root)});
    `,
  });
  return { ...run, left: [...(await views()), ...(await layouts())] };
}

describe.runIf(canSandbox)(
  'opmx stopped while it runs an installed tool',
  () => {
    it('ends a declared bin and removes its layout, by SIGHUP', async () => {
      const { how, left, output } = await killedRun(
        'idler',
        'SIGHUP',
        'layout',
      );
      expect([how, left]).toEqual(['SIGHUP', []]);
      // What ended the tool is said by its name.
      expect(output).toContain('openpacker sandbox: process stopped by SIGHUP');
    }, 120_000);

    it('ends a bin no package owns and removes the store view, by SIGINT', async () => {
      const { how, left, output } = await killedRun('direct', 'SIGINT', 'view');
      expect([how, left]).toEqual(['SIGINT', []]);
      expect(output).toContain('openpacker sandbox: process stopped by SIGINT');
    }, 120_000);
  },
);

/**
 * `runOpmx pkg:npm/idler@1.0.0` in a child process, answered by the npm
 * fixture registry through the registry seam, killed by `signal` once the
 * tool runs from its layout in the tool cache.
 */
async function killedRegistryRun(signal: NodeJS.Signals) {
  const work = await mkdtemp(join(tmpdir(), 'opmx-run-signals-pkg-'));
  temps.push(work);
  const cache = join(work, 'tool-cache');
  const runs = join(cache, '.opm', 'runs');
  const layouts = async () => await readdir(runs).catch(() => []);
  const marker = `--opmx-run-signals-${randomUUID()}`;
  const run = await signalledScript({
    work,
    marker,
    signal,
    made: async () => (await layouts()).length === 1,
    script: `import { runOpmx } from ${source('../src/opmx.ts')};
     import { NpmRegistryFixture } from ${source('../../../packages/opm-project/test/npm-registry-fixture.ts')};
     ${PLAIN_NODE}
     delete process.env.OPM_STORE_HOME;
     process.env.OPM_TOOL_CACHE = ${JSON.stringify(cache)};
     const registry = new NpmRegistryFixture([{
       name: 'idler',
       versions: { '1.0.0': {
         bin: { idler: 'cli.js' },
         files: { 'cli.js': ${JSON.stringify(idle)} },
       } },
     }]);
     process.exitCode = await runOpmx(
       ${JSON.stringify(['pkg:npm/idler@1.0.0', '--', marker])},
       process,
       ${JSON.stringify(work)},
       { transport: registry },
     );
    `,
  });
  return { ...run, layouts: await layouts() };
}

describe.runIf(canSandbox)(
  'opmx stopped while it runs a tool straight from a registry',
  () => {
    it('ends the tool and removes its layout, by SIGTERM', async () => {
      const { how, layouts, output } = await killedRegistryRun('SIGTERM');
      expect([how, layouts]).toEqual(['SIGTERM', []]);
      expect(output).toContain('opmx: pkg:npm/idler@1.0.0');
      expect(output).toContain(
        'openpacker sandbox: process stopped by SIGTERM',
      );
    }, 120_000);
  },
);

describe.skipIf(canSandbox)(
  'opmx stopped while it runs an installed tool, or one from a registry',
  () => {
    it.skip('needs bwrap (/usr/bin/bwrap); not checked on this host', () => {});
  },
);

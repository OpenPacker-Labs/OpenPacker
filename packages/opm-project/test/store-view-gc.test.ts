import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  addPackage,
  collectGarbage,
  initProject,
  listGenerations,
  projectPaths,
} from '../src/index.js';
import { currentOwner } from '../src/run-owner.js';
import { scratchName, scratchNameFor } from '../src/run-scratch.js';
import { storeViews } from '../src/store-view.js';

configureDefaultAdapters();

/**
 * A run binds the entries it needs from a store through a view made inside
 * that store. `opm gc` removes every directory of a project's store that no
 * generation reaches; a view is not a store path, and removing it would take
 * files from under a tool that is running.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureCatalog = join(repoRoot, 'fixtures/opm/catalog.json');
const fixtureTgz = join(repoRoot, 'fixtures/opm/demo-tool-1.1.0.tgz');

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-view-gc-'));
  roots.push(root);
  await initProject({ root, name: 'view-gc' });
  // SAFETY: the fixture catalog checked in beside the tarball.
  const catalog = JSON.parse(await readFile(fixtureCatalog, 'utf8')) as {
    packages: Record<string, { source: string }>;
  };
  for (const entry of Object.values(catalog.packages))
    entry.source = `file:${fixtureTgz}`;
  await writeFile(join(root, '.opm/catalog.json'), JSON.stringify(catalog));
  return root;
}

describe('opm gc while a tool runs', () => {
  it('leaves the view the tool is bound to', async () => {
    const root = await project();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    const [generation] = await listGenerations(root);
    const installed = generation!.members[0]!.storePath;
    const store = projectPaths(root).store;
    expect(dirname(installed)).toBe(store);
    // Entries of the same store which no generation names, more than the
    // handles left for them, so that the run binds them through one view.
    const unreachable = Array.from({ length: 9 }, (_, i) =>
      join(store, `sha256-${i.toString(16).padStart(64, '0')}`),
    );
    for (const entry of unreachable)
      await mkdir(join(entry, 'package'), { recursive: true });
    const before = await readdir(store);

    const view = await storeViews([installed, ...unreachable], 8);
    try {
      const [made] = (await readdir(store)).filter(
        (name) => !before.includes(name),
      );
      expect(made).toBeDefined();
      const { removed } = await collectGarbage({ root });
      expect(removed).toEqual(unreachable);
      expect((await readdir(join(store, made!))).sort()).toEqual(
        [installed, ...unreachable].map((path) => basename(path)).sort(),
      );
    } finally {
      await view.dispose();
    }
    expect((await readdir(store)).sort()).toEqual(
      before.filter((name) => !unreachable.includes(join(store, name))).sort(),
    );
  });
});

describe('opm gc after a run that was killed', () => {
  it('removes the view it left, and keeps one a run still uses or another machine made', async () => {
    const root = await project();
    const store = projectPaths(root).store;
    await mkdir(store, { recursive: true });
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    const ended = { ...currentOwner(), pid: child.pid!, start: '' };
    const left = scratchNameFor('.view-', ended);
    const running = scratchName('.view-');
    const foreign = scratchNameFor('.view-', { ...ended, machine: 'zzzzzzzz' });
    for (const name of [left, running, foreign])
      await mkdir(join(store, name, `sha256-${'0'.repeat(64)}`), {
        recursive: true,
      });

    await collectGarbage({ root, dryRun: true });
    expect((await readdir(store)).sort()).toEqual(
      [left, running, foreign].sort(),
    );
    await collectGarbage({ root });
    expect((await readdir(store)).sort()).toEqual([running, foreign].sort());
  });
});

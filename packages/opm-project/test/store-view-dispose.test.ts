import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMockBackend,
  MAX_INHERITED_HANDLES,
  type SandboxBackend,
} from '@openpacker/sandbox';
import { runSandboxedPackageProcess } from '../src/index.js';

/**
 * The store view a sandboxed run binds is the run's own, and the run removes it
 * however it ends: a process that exits, a backend that throws, an abort. A run
 * that left it behind would keep a second name on every file of the entries it
 * showed, and `opm gc` would take those entries for in use.
 */

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** More entries of one store than the run has handles left for: a view. */
async function store() {
  const base = await mkdtemp(join(tmpdir(), 'opm-view-dispose-'));
  temps.push(base);
  const root = join(base, 'store');
  const entries: string[] = [];
  for (let i = 0; i < MAX_INHERITED_HANDLES; i += 1) {
    const entry = join(root, `sha256-${i.toString(16).padStart(64, '0')}`);
    await mkdir(entry, { recursive: true });
    await writeFile(join(entry, 'index.js'), `module.exports = ${i};\n`);
    entries.push(entry);
  }
  const work = join(base, 'work');
  await mkdir(work);
  return { root, entries, work };
}

const views = async (root: string) =>
  (await readdir(root)).filter((name) => name.startsWith('.view-'));

/** The spawner without a jail, under a name that counts as an enforcing one. */
const spawner = createMockBackend();
const enforcing: SandboxBackend = {
  id: 'native-bwrap',
  run: (input) => spawner.run(input),
};

/** Node, which prints how many views the store holds while it runs. */
const listViews = (root: string) =>
  `process.stdout.write(String(require('fs').readdirSync(${JSON.stringify(root)}).filter((n) => n.startsWith('.view-')).length))`;

describe('the store view of a run', () => {
  it('is removed when the process exits', async () => {
    const { root, entries, work } = await store();
    const outcome = await runSandboxedPackageProcess({
      argv: [process.execPath, '-e', listViews(root)],
      cwd: work,
      storePaths: entries,
      backend: enforcing,
    });
    // Made for the run (one), and gone with it.
    expect([outcome.stdout, await views(root)]).toEqual(['1', []]);
  });

  it('is removed when the backend throws', async () => {
    const { root, entries, work } = await store();
    const seen: number[] = [];
    const failing: SandboxBackend = {
      id: 'native-bwrap',
      async run() {
        seen.push((await views(root)).length);
        throw new Error('the backend failed');
      },
    };
    await expect(
      runSandboxedPackageProcess({
        argv: ['/bin/true'],
        cwd: work,
        storePaths: entries,
        backend: failing,
      }),
    ).rejects.toThrow('the backend failed');
    expect([seen, await views(root)]).toEqual([[1], []]);
  });

  it('is removed when the run is aborted', async () => {
    const { root, entries, work } = await store();
    const abort = new AbortController();
    const idle = 'setInterval(() => {}, 1000)';
    const running = runSandboxedPackageProcess({
      argv: [process.execPath, '-e', idle],
      cwd: work,
      storePaths: entries,
      backend: {
        id: 'native-bwrap',
        async run(input) {
          // The process is running with its view: end it.
          setTimeout(() => abort.abort(), 300);
          return await spawner.run(input);
        },
      },
      signal: abort.signal,
    });
    // Ended by the abort, not by itself, and the view went with it.
    const outcome = await running;
    expect([outcome.exitCode === 0, await views(root)]).toEqual([false, []]);
  });
});

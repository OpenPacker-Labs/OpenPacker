import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_INHERITED_HANDLES } from '@openpacker/sandbox';
import { runSandboxedPackageProcess } from '../src/index.js';
import { storesToView } from '../src/store-view.js';

/**
 * Store entries are bound one handle each while the run's handles allow it,
 * and through a view of their store only past that. A view is made inside the
 * store, so a store the user cannot write to (installed by root in an image,
 * or on a read-only file system) still runs whatever fits, as before views;
 * a fixed threshold of eight refused such a store at nine entries.
 */

const temps: string[] = [];
const unlocks: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unlock of unlocks.splice(0)) await unlock();
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A store holding `count` entries, and a working directory beside it. */
async function store(count: number) {
  const base = await mkdtemp(join(tmpdir(), 'opm-view-budget-'));
  temps.push(base);
  const root = join(base, 'store');
  const entries: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const entry = join(root, `sha256-${i.toString(16).padStart(64, '0')}`);
    await mkdir(join(entry, 'package'), { recursive: true });
    await writeFile(
      join(entry, 'package', 'index.js'),
      `module.exports = ${i};\n`,
    );
    entries.push(entry);
  }
  const work = join(base, 'work');
  await mkdir(work);
  return { root, entries, work };
}

/**
 * Make `dir` impossible to add a name to for this process: read-only for a
 * user, immutable for root, whom a mode does not stop. Undefined when this host
 * can do neither (root on a file system without the immutable flag).
 */
async function lock(dir: string): Promise<true | undefined> {
  try {
    if (process.getuid?.() === 0) {
      execFileSync('chattr', ['+i', dir], { stdio: 'ignore' });
      unlocks.push(async () => {
        execFileSync('chattr', ['-i', dir], { stdio: 'ignore' });
      });
    } else {
      await chmod(dir, 0o555);
      unlocks.push(() => chmod(dir, 0o755));
    }
  } catch {
    return undefined;
  }
  try {
    await mkdir(join(dir, 'probe'));
  } catch {
    return true;
  }
  await rmdir(join(dir, 'probe'));
  return undefined;
}

/** Run node in the sandbox over `entries`, cwd outside the store. */
const run = (entries: readonly string[], work: string, program: string) =>
  runSandboxedPackageProcess({
    argv: [process.execPath, '-e', program],
    cwd: work,
    storePaths: entries,
  });

const requireAll = (entries: readonly string[]) =>
  `process.stdout.write(${JSON.stringify(entries)}.map((p) => require(p + '/package/index.js')).join(','))`;

/** How many mounts the sandboxed process has at `root` or under it. */
const mountsUnder = (root: string) =>
  `process.stdout.write(String(require('fs').readFileSync('/proc/self/mountinfo', 'utf8').split('\\n').filter((line) => { const at = line.split(' ')[4] ?? ''; return at === ${JSON.stringify(root)} || at.startsWith(${JSON.stringify(`${root}/`)}); }).length))`;

const canSandbox =
  process.platform === 'linux' &&
  ['/usr/bin/bwrap', '/bin/bwrap'].some((path) => existsSync(path));

describe('which stores are bound through a view', () => {
  const at = (store: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${store}/sha256-${i}`);

  it('is none while every entry fits in the handles left for them', () => {
    expect(storesToView(at('/s', 14), 14).size).toBe(0);
    expect([...storesToView(at('/s', 15), 14).keys()]).toEqual(['/s']);
  });

  it('is the fewest stores, the one with the most entries first', () => {
    const paths = [...at('/small', 5), ...at('/large', 10)];
    expect([...storesToView(paths, 12).keys()]).toEqual(['/large']);
    expect([...storesToView(paths, 2).keys()].sort()).toEqual([
      '/large',
      '/small',
    ]);
  });

  it('refuses, naming the bound, what no views make fit', () => {
    // One entry in each of fifteen stores: a view of a store saves nothing.
    const spread = Array.from({ length: 15 }, (_, i) => `/s${i}/sha256-0`);
    expect(() => storesToView(spread, 14)).toThrow(
      `${MAX_INHERITED_HANDLES} a sandboxed process may inherit`,
    );
  });
});

describe.runIf(canSandbox)('a run over entries of one store', () => {
  // The working directory and the jail's home take two of the handles.
  const room = MAX_INHERITED_HANDLES - 2;

  it('binds each entry on its own up to the last handle, then one view', async () => {
    for (const count of [room, room + 1]) {
      const { root, entries, work } = await store(count);
      const outcome = await run(entries, work, mountsUnder(root));
      expect(outcome.stderr).toBe('');
      expect([count, outcome.stdout]).toEqual([
        count,
        String(count === room ? room : 1),
      ]);
    }
  });

  it('runs from a store it cannot write to while the entries fit', async (context) => {
    for (const count of [9, 11, 13, room]) {
      const { root, entries, work } = await store(count);
      context.skip(
        (await lock(root)) === undefined,
        'cannot make a directory unwritable on this host',
      );
      const outcome = await run(entries, work, requireAll(entries));
      expect(outcome.stderr).toBe('');
      expect(outcome.stdout).toBe(
        Array.from({ length: count }, (_, i) => i).join(','),
      );
    }
  });

  it('refuses one entry more from that store, naming the bound', async (context) => {
    const { root, entries, work } = await store(room + 1);
    context.skip(
      (await lock(root)) === undefined,
      'cannot make a directory unwritable on this host',
    );
    await expect(run(entries, work, requireAll(entries))).rejects.toThrow(
      `${MAX_INHERITED_HANDLES} handles a sandboxed process may inherit`,
    );
  });
});

describe.skipIf(canSandbox)('a run over entries of one store', () => {
  it.skip('needs bwrap (/usr/bin/bwrap); not checked on this host', () => {});
});

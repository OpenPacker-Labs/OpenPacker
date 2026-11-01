import { spawn } from 'node:child_process';
import { existsSync, realpathSync, renameSync, symlinkSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { layOutTool } from '../src/ephemeral-layout.js';
import { placeDigest, type ProcessOwner } from '../src/process-owner.js';
import {
  makeScratch,
  sweepAbandoned,
  type Scratch,
} from '../src/run-scratch.js';
import { storeViews } from '../src/store-view.js';

/**
 * What a run made is removed from a place a sandboxed tool may be able to
 * write: a run whose store entries fit without a view binds the project's
 * store read-write when `sandbox.project_write = true`. A tool there can plant
 * a `.view-*` whose owner reads as ended, and swap a directory in it for a link
 * to anywhere while the next run's sweep, or `opm gc`, removes it. Node's
 * recursive `rm` looks at a directory, then lists it by its path: a link put
 * there in between is entered, and what is behind it is removed. Each
 * directory must be opened once, without following a link, and emptied through
 * that handle.
 *
 * Neither Node's `rm` nor a walk through handles has a seam between the look
 * and the listing, so the listing is wrapped: `fs.readdir`, which Node's `rm`
 * takes from `fs` the first time it is used (so it is wrapped here before
 * anything is removed), and `fs.promises.readdir`, which project-io's walk
 * lists an open directory through. Linux only: elsewhere that walk is libc's
 * or NT's and lists through neither.
 */

const PREFIX = '.view-';

interface Swap {
  /** The directory whose listing is the moment. */
  listed: string;
  /** The directory then put aside, with a link to `outside` in its place. */
  swapped: string;
  outside: string;
  /** Just before `listed` is read, or just after. */
  moment: 'before' | 'after';
  fired: boolean;
}

let swap: Swap | undefined;

/** The swap due when `path` is listed, if any. */
function dueAt(path: unknown): Swap | undefined {
  if (swap === undefined || swap.fired) return undefined;
  try {
    return realpathSync(String(path)) === swap.listed ? swap : undefined;
  } catch {
    return undefined;
  }
}

function act(due: Swap): void {
  due.fired = true;
  renameSync(due.swapped, `${due.swapped}.moved`);
  symlinkSync(due.outside, due.swapped);
}

// SAFETY: Node's own `fs`; its two `readdir`s are wrapped and pass every argument through.
const fs = createRequire(import.meta.url)('node:fs') as typeof NodeFs;
/** A `readdir` as it is called here: the path, then whatever else was given. */
type Listing<T> = (path: unknown, ...rest: unknown[]) => T;
const list = {
  // SAFETY: called with exactly the arguments its caller gave, the callback last.
  callback: fs.readdir.bind(fs) as Listing<void>,
  // SAFETY: called with exactly the arguments its caller gave.
  promise: fs.promises.readdir.bind(fs.promises) as Listing<
    Promise<string[] | Buffer[] | NodeFs.Dirent[]>
  >,
};
Object.assign(fs, {
  readdir(path: unknown, ...rest: unknown[]) {
    const due = dueAt(path);
    if (due?.moment === 'before') act(due);
    if (due?.moment === 'after') {
      // SAFETY: the callback form of readdir ends with its callback.
      const done = rest.pop() as (...answer: unknown[]) => void;
      rest.push((...answer: unknown[]) => {
        act(due);
        done(...answer);
      });
    }
    return list.callback(path, ...rest);
  },
});
Object.assign(fs.promises, {
  async readdir(path: unknown, ...rest: unknown[]) {
    const due = dueAt(path);
    if (due?.moment === 'before') act(due);
    const names = await list.promise(path, ...rest);
    if (due?.moment === 'after') act(due);
    return names;
  },
});
syncBuiltinESMExports();

const temps: string[] = [];
afterEach(async () => {
  swap = undefined;
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** Where runs make their scratch, and a directory outside holding `precious`. */
async function places(): Promise<{ dir: string; outside: string }> {
  const base = await mkdtemp(join(tmpdir(), 'opm-scratch-removal-'));
  temps.push(base);
  const dir = join(base, 'store');
  const outside = join(base, 'outside');
  await mkdir(dir);
  await mkdir(outside);
  await writeFile(join(outside, 'precious'), 'keep\n');
  return { dir, outside };
}

/** Swap `swapped` for a link to `outside` once, at that moment of `listed`'s listing. */
function swapAt(
  moment: Swap['moment'],
  listed: string,
  swapped: string,
  outside: string,
): void {
  swap = {
    listed: realpathSync(listed),
    swapped,
    outside,
    moment,
    fired: false,
  };
}

/** Whether the swap happened, and whether `precious` is still outside. */
const outcome = (outside: string) => [
  swap?.fired,
  existsSync(join(outside, 'precious')),
];

/** A reader on a machine, boot and PID namespace named here. */
const reader: ProcessOwner = {
  pid: process.pid,
  host: 'here',
  startTime: '1000',
  pidNamespace: '4026531836',
  bootId: placeDigest('boot', 'this boot'),
  machineId: placeDigest('machine', 'this machine'),
};

/** The pid of a process that has ended. */
async function ended(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

/** What a run that has ended left in `dir`: its tree holds `pkg/index.js`. */
async function leftover(dir: string): Promise<Scratch> {
  const scratch = await makeScratch(dir, PREFIX, {
    ...reader,
    pid: await ended(),
  });
  await mkdir(join(scratch.tree, 'pkg'));
  await writeFile(join(scratch.tree, 'pkg', 'index.js'), '');
  return scratch;
}

describe.runIf(process.platform === 'linux')(
  'removing what a run made while a tool swaps a directory in it for a link',
  () => {
    it.each([
      ['the scratch directory', (scratch: Scratch) => scratch.path],
      [
        'a directory in its tree',
        (scratch: Scratch) => join(scratch.tree, 'pkg'),
      ],
    ])(
      'the sweep does not enter %s, swapped just before it is listed',
      async (_, pick) => {
        const { dir, outside } = await places();
        const target = pick(await leftover(dir));
        swapAt('before', target, target, outside);
        await sweepAbandoned(dir, PREFIX, { reader });
        expect(outcome(outside)).toEqual([true, true]);
      },
    );

    it('the sweep does not enter a directory swapped just after its parent was listed', async () => {
      const { dir, outside } = await places();
      const { tree } = await leftover(dir);
      swapAt('after', tree, join(tree, 'pkg'), outside);
      await sweepAbandoned(dir, PREFIX, { reader });
      expect(outcome(outside)).toEqual([true, true]);
    });

    it('a store view does not enter a directory swapped as it is removed', async () => {
      const { dir: store, outside } = await places();
      const entries = [1, 2, 3].map((i) => join(store, `sha256-${i}`));
      for (const entry of entries) {
        await mkdir(entry);
        await writeFile(join(entry, 'index.js'), '');
      }
      // Three entries and one handle: they are bound through a view.
      const view = await storeViews(entries, 1);
      const [made] = (await readdir(store)).filter((name) =>
        name.startsWith(PREFIX),
      );
      const target = join(store, made!, 'tree', basename(entries[0]!));
      swapAt('before', target, target, outside);
      await view.dispose().catch(() => undefined);
      expect(outcome(outside)).toEqual([true, true]);
    });

    it('a tool layout does not enter a directory swapped as it is removed', async () => {
      const { dir: cacheRoot, outside } = await places();
      const digest = '1'.repeat(64);
      const storePath = join(cacheRoot, '.opm', 'store', `sha256-${digest}`);
      await mkdir(storePath, { recursive: true });
      await writeFile(join(storePath, 'cli.js'), '');
      const layout = await layOutTool({
        cacheRoot,
        tool: 'pkg:npm/bare@1.0.0',
        closure: [
          {
            exactPurl: 'pkg:npm/bare@1.0.0',
            digest: `sha256:${digest}`,
            size: 1,
            source: 'https://registry.npmjs.org/bare/-/bare-1.0.0.tgz',
            storePath,
          },
        ],
      });
      const target = join(layout.root, 'node_modules');
      swapAt('before', target, target, outside);
      await layout.dispose().catch(() => undefined);
      expect(outcome(outside)).toEqual([true, true]);
    });
  },
);

/**
 * The work a patch's paths cost (ADR 0056 §9). The budget counted the
 * characters of the files a patch reads, compares and writes, and nothing the
 * tree does with the paths themselves: every lookup walks the ancestors of its
 * path, `ensureDir` does that for every ancestor again, and every named path
 * and each directory above it is an `lstat`. A 16 MiB patch within every bound
 * (one path 128 directories deep created 4,801 times) was applied after 330 s;
 * 2 MiB of distinct deep paths took 177 s, 892,000 `lstat` calls and 375 MB.
 * Each is charged now, so the accounting here is exact: it is the contract.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PatchBudget, PatchRefusal } from './apply.js';
import { applyPnpmPatch, readPatchText } from './index.js';
import {
  loadPatchTree,
  OverlayTree,
  type PatchNode,
  withAncestors,
} from './tree.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const dir: PatchNode = { kind: 'dir' };
const file = (text: string): PatchNode => ({
  kind: 'file',
  bytes: Buffer.from(text),
  mode: 0o644,
});

/** `a`, `a/b` and `a/b/c` known, `a/b/c` not there. */
const small = (budget: PatchBudget) =>
  new OverlayTree(
    new Map<string, PatchNode | undefined>([
      ['a', dir],
      ['a/b', dir],
      ['a/b/c', undefined],
      ['a/b/d', file('d')],
    ]),
    budget,
  );

describe('what a lookup in the tree costs', () => {
  it('is the path and each ancestor it visits, a character each and one for the lookup', () => {
    const budget = new PatchBudget();
    expect(small(budget).exists('a/b/c')).toBe(false);
    // 'a/b/c' (5 + 1), then 'a/b' (3 + 1) and 'a' (1 + 1).
    expect(budget.spent).toBe(12);
  });

  it('is the path alone for a path with no ancestor', () => {
    const budget = new PatchBudget();
    expect(small(budget).exists('a')).toBe(true);
    expect(budget.spent).toBe(2);
  });

  it('stops at the first file on the way up: a path below a file is not there', () => {
    const budget = new PatchBudget();
    const tree = new OverlayTree(
      new Map<string, PatchNode | undefined>([
        ['a', file('a')],
        ['a/b', undefined],
        ['a/b/c', undefined],
      ]),
      budget,
    );
    expect(tree.exists('a/b/c')).toBe(false);
    // 'a/b/c' (6), 'a/b' (4), 'a' (2) is the file: no more.
    expect(budget.spent).toBe(12);
  });

  it('is charged to a write as its lookups, and for each directory it makes sure of', () => {
    const budget = new PatchBudget();
    small(budget).write('a/b/c', 'x', 0o644);
    // ensureDir('a/b/c'): the parent 'a/b' (3 + 1) and its parent 'a' (1 + 1),
    // each looked up on the way back: 'a' (1 + 1), 'a/b' (3 + 1 and 'a' 1 + 1);
    // then the lookup of the path itself: 'a/b/c' (5 + 1), 'a/b' (3 + 1), 'a' (1 + 1).
    expect(budget.spent).toBe(4 + 2 + 2 + 6 + 12);
  });

  it('is charged to every kind of change, a move and an unlink and a chmod included', () => {
    const spent = (change: (tree: OverlayTree) => void) => {
      const budget = new PatchBudget();
      change(small(budget));
      return budget.spent;
    };
    // 'a/b/d' is a file: a lookup of it costs 6 + 4 + 2 = 12.
    expect(spent((tree) => tree.unlink('a/b/d'))).toBe(12);
    expect(spent((tree) => tree.chmod('a/b/d', 0o755))).toBe(12);
    expect(spent((tree) => void tree.readText('a/b/d'))).toBe(12);
    expect(spent((tree) => void tree.mode('a/b/d'))).toBe(12);
    // move: the source (12), the target (12), the directory above the target
    // made sure of (4 + 2 + 2 + 6).
    expect(spent((tree) => tree.move('a/b/d', 'a/b/c'))).toBe(12 + 12 + 14);
  });

  it('refuses the patch as too costly when a lookup is what overruns the budget', () => {
    const tree = small(new PatchBudget(11));
    expect(() => tree.exists('a/b/c')).toThrow(
      expect.objectContaining({
        name: 'PatchRefusal',
        code: 'PATCH_FAILED',
        message: expect.stringContaining('too costly'),
      }),
    );
    expect(() => small(new PatchBudget(12)).exists('a/b/c')).not.toThrow();
  });
});

describe('what reading the tree from disk costs', () => {
  const effects = (...paths: string[]) =>
    paths.map((path) => ({
      type: 'file deletion' as const,
      path,
      mode: 0o644,
      hash: null,
      hunk: null,
    }));

  async function packageDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'pnpm-patch-load-'));
    temps.push(root);
    await mkdir(join(root, 'lib'));
    await writeFile(join(root, 'lib', 'a.js'), '12345678');
    return root;
  }

  it('is an lstat for the path and each directory above it, and the bytes of each file read', async () => {
    const root = await packageDir();
    const budget = new PatchBudget();
    await loadPatchTree(root, effects('lib/a.js', 'lib/b/c.js'), budget);
    // Four entries: lib (3), lib/a.js (8), lib/b (5) and lib/b/c.js (10), each
    // an lstat of 2048 and its length; then the 8 bytes of a.js and one.
    expect(budget.spent).toBe(4 * 2048 + (3 + 8 + 5 + 10) + (8 + 1));
  });

  it('refuses the patch as too costly when the lstats are what overrun the budget', async () => {
    const root = await packageDir();
    await expect(
      loadPatchTree(root, effects('lib/a.js'), new PatchBudget(2 * 2048 + 10)),
    ).rejects.toMatchObject({
      name: 'PatchRefusal',
      code: 'PATCH_FAILED',
      message: expect.stringContaining('too costly'),
    });
  });

  it('refuses the patch as too costly when the files read are what overrun it', async () => {
    const root = await packageDir();
    await expect(
      loadPatchTree(
        root,
        effects('lib/a.js'),
        new PatchBudget(2 * 2048 + 11 + 8),
      ),
    ).rejects.toBeInstanceOf(PatchRefusal);
    await expect(
      loadPatchTree(
        root,
        effects('lib/a.js'),
        new PatchBudget(2 * 2048 + 11 + 9),
      ),
    ).resolves.toBeInstanceOf(OverlayTree);
  });
});

describe('a patch that makes the tree walk for minutes', () => {
  const create = (path: string) =>
    `diff --git a/x b/${path}\nnew file mode 100644\n`;
  /** 128 segments of 27 characters, 3,455 bytes: within every bound. */
  const deep = Array.from(
    { length: 128 },
    (_, index) => `${String(index).padStart(3, '0')}${'s'.repeat(23)}`,
  ).join('/');
  const patch = (text: string) => ({
    key: 'x@1.0.0',
    file: 'p.patch',
    hash: '',
    digest: '',
    text,
  });

  it('is refused when it makes one deep path again and again: 100 effects, 350 KB, where 4,801 took 330 s', async () => {
    const text = create(deep).repeat(100);
    expect(text.length).toBeLessThan(400_000);
    expect(readPatchText(text, 'p.patch')).toHaveLength(100);
    const root = await mkdtemp(join(tmpdir(), 'pnpm-patch-deep-'));
    temps.push(root);
    await writeFile(join(root, 'package.json'), '{}');
    const started = performance.now();
    await expect(
      applyPnpmPatch(root, patch(text), 'x@1.0.0'),
    ).rejects.toMatchObject({
      code: 'PATCH_FAILED',
      message: expect.stringContaining('too costly'),
    });
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 60_000);

  it('costs a real patch nothing to speak of: 20 files six directories deep spend under 0.1% of the budget', () => {
    const budget = new PatchBudget();
    const base = new Map<string, PatchNode | undefined>();
    const paths = Array.from(
      { length: 20 },
      (_, index) => `dist/esm/lib/util/internal/helpers/file${index}.js`,
    );
    for (const entry of withAncestors(paths)) base.set(entry, undefined);
    const tree = new OverlayTree(base, budget);
    for (const path of paths) tree.write(path, 'x', 0o644);
    expect(budget.spent).toBeGreaterThan(0);
    expect(budget.spent).toBeLessThan(budget.limit / 1000);
  });
});

describe('the files a patch tree may hold', () => {
  it('lists the entries as before, and refuses one past the limit before building the rest', () => {
    expect(
      withAncestors(['b/c/d.js', 'a.js', 'b/e.js', 'b/c/f.js'], 6),
    ).toEqual(['b', 'a.js', 'b/c', 'b/e.js', 'b/c/d.js', 'b/c/f.js']);
    expect(() =>
      withAncestors(['b/c/d.js', 'a.js', 'b/e.js', 'b/c/f.js'], 5),
    ).toThrow(
      expect.objectContaining({
        name: 'PatchRefusal',
        code: 'SIZE_LIMIT',
        message: expect.stringContaining('more than the 5 files'),
      }),
    );
  });

  it('gives the entries of the linear reading, in its order, for 3,000 random paths', () => {
    const reference = (paths: readonly string[]): string[] => {
      const seen = new Set<string>();
      const byDepth: string[][] = [];
      for (const path of paths) {
        const parts = path.split('/');
        for (let depth = 0; depth < parts.length; depth += 1) {
          const prefix = parts.slice(0, depth + 1).join('/');
          if (!seen.has(prefix)) {
            seen.add(prefix);
            (byDepth[depth] ??= []).push(prefix);
          }
        }
      }
      return byDepth.flat();
    };
    let state = 5;
    const next = () => {
      state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
      return state / 0x80000000;
    };
    const names = ['a', 'b', 'c', 'dd', 'e'];
    const paths = Array.from({ length: 3_000 }, () =>
      Array.from(
        { length: 1 + Math.floor(next() * 7) },
        () => names[Math.floor(next() * names.length)],
      ).join('/'),
    );
    expect(withAncestors(paths)).toEqual(reference(paths));
    expect(withAncestors([...new Set(paths)])).toEqual(
      reference([...new Set(paths)]),
    );
  });

  it('takes a patch whose paths and directories come to 100,000 and refuses 100,001, at --plan', () => {
    const sections = (count: number) =>
      Array.from(
        { length: count },
        (_, index) =>
          `diff --git a/d/f${index} b/d/f${index}\nnew file mode 100644\n`,
      ).join('');
    // 99,999 files and the directory above them.
    expect(readPatchText(sections(99_999), 'p')).toHaveLength(99_999);
    expect(() => readPatchText(sections(100_000), 'p')).toThrow(
      expect.objectContaining({
        code: 'SIZE_LIMIT',
        message: expect.stringContaining(
          'names 100000 paths, which with the directories above them come to more than the 100000 files',
        ),
      }),
    );
  }, 60_000);

  it('refuses at --plan, in a moment, 800 paths that are each 128 directories deep: 102,400 lstat calls', () => {
    const text = Array.from(
      { length: 800 },
      (_, index) =>
        `diff --git a/p${index}${'/a'.repeat(127)} b/\ndeleted file mode 100644\n`,
    ).join('');
    expect(text.length).toBeLessThan(600_000);
    const started = performance.now();
    expect(() => readPatchText(text, 'p')).toThrow(
      expect.objectContaining({ code: 'SIZE_LIMIT' }),
    );
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

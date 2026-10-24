import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editJsonFile, observeWrites, writeFileAtomic } from './index.js';

/**
 * An observer is told of a write before it is made (the copy of a step learns
 * what package.json is about to hold, and records it, before the file can hold
 * it), only inside the work it wraps, and a refusal from it stops the write.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'project-io-observer-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('observeWrites', () => {
  it('is told the path and the contents before the file changes', async () => {
    const path = join(dir, 'package.json');
    await writeFile(path, 'old\n');
    const told: { path: string; contents: string; onDisk: string }[] = [];
    await observeWrites(
      async (where, contents) => {
        told.push({
          path: where,
          contents: String(contents),
          onDisk: await readFile(path, 'utf8'),
        });
      },
      () => writeFileAtomic(path, 'new\n'),
    );
    expect(told).toEqual([{ path, contents: 'new\n', onDisk: 'old\n' }]);
    expect(await readFile(path, 'utf8')).toBe('new\n');
  });

  it('is waited for: the write follows its answer', async () => {
    const path = join(dir, 'a.json');
    const order: string[] = [];
    await observeWrites(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        order.push(
          (await readdir(dir)).includes('a.json') ? 'file first' : 'observer',
        );
      },
      async () => {
        await writeFileAtomic(path, '{}\n');
        order.push('written');
      },
    );
    expect(order).toEqual(['observer', 'written']);
  });

  it('stops the write when it throws', async () => {
    const path = join(dir, 'a.json');
    await writeFile(path, 'old\n');
    await expect(
      observeWrites(
        async () => {
          throw new Error('not recorded');
        },
        () => writeFileAtomic(path, 'new\n'),
      ),
    ).rejects.toThrow('not recorded');
    expect(await readFile(path, 'utf8')).toBe('old\n');
    expect(await readdir(dir)).toEqual(['a.json']);
  });

  it('sees the writes an edit makes', async () => {
    const path = join(dir, 'package.json');
    await writeFile(path, '{\n  "a": 1\n}\n');
    const told: string[] = [];
    await observeWrites(
      async (_where, contents) => {
        told.push(String(contents));
      },
      () =>
        editJsonFile<{ a: number }>(path, (value) => {
          value.a = 2;
        }).then(() => undefined),
    );
    expect(told).toEqual(['{\n  "a": 2\n}\n']);
  });

  it('does not see a write outside the work it wraps', async () => {
    const told: string[] = [];
    await observeWrites(
      async (where) => {
        told.push(where);
      },
      async () => undefined,
    );
    await writeFileAtomic(join(dir, 'later.json'), '{}\n');
    expect(told).toEqual([]);
  });

  it('tells both, the outer one first, when they nest', async () => {
    const told: string[] = [];
    await observeWrites(
      async () => {
        told.push('outer');
      },
      () =>
        observeWrites(
          async () => {
            told.push('inner');
          },
          () => writeFileAtomic(join(dir, 'a.json'), '{}\n'),
        ),
    );
    expect(told).toEqual(['outer', 'inner']);
  });
});

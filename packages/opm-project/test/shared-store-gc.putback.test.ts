import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectSharedStore } from '../src/index.js';

/**
 * `opm gc --shared` and an old orphan `<key>.tree` record whose key a publish
 * writes again while gc is judging it (ADR 0056 §11). gc moves a record aside
 * before it removes it, and puts it back when what it moved is not the inode
 * it judged (a publish's atomic replace is a new inode). A publish that lands
 * before the move aside is put back; one that lands after it is left alone;
 * and a record that was put back is not reported as removed.
 */

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const KEY = `sha256-${'a'.repeat(64)}-patch-${'b'.repeat(64)}`;
const OLD = `sha256:${'0'.repeat(64)}\n`;
const NEW = `sha256:${createHash('sha256').update('new').digest('hex')}\n`;

/** A publish: the record written by atomic replace, the entry made after it. */
async function publish(root: string): Promise<void> {
  const tmp = join(root, `.${KEY}.tree.publish.tmp`);
  await writeFile(tmp, NEW);
  await rename(tmp, join(root, `${KEY}.tree`));
  await mkdir(join(root, KEY, 'package'), { recursive: true });
}

async function store(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-gc-putback-'));
  temps.push(root);
  await writeFile(join(root, `${KEY}.tree`), OLD);
  const old = new Date(Date.now() - 3_600_000);
  await utimes(join(root, `${KEY}.tree`), old, old);
  return root;
}

const collecting = async (root: string) =>
  (await readdir(root)).filter((name) => name.includes('.collect-'));

describe('gc and a publish of an orphan record’s key', () => {
  it('puts back a record written between its judgement and its move aside, and does not report it removed', async () => {
    const root = await store();
    let landed = false;
    const result = await collectSharedStore({
      env: { OPM_STORE_HOME: root },
      steps: {
        judged: async () => {
          landed = true;
          await publish(root);
        },
      },
    });
    expect(landed).toBe(true);
    expect(await readFile(join(root, `${KEY}.tree`), 'utf8')).toBe(NEW);
    expect(await collecting(root)).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('leaves a record written right after the old one was moved aside, and reports the old one removed', async () => {
    const root = await store();
    let landed = false;
    const result = await collectSharedStore({
      env: { OPM_STORE_HOME: root },
      steps: {
        movedAside: async () => {
          landed = true;
          await publish(root);
        },
      },
    });
    expect(landed).toBe(true);
    expect(await readFile(join(root, `${KEY}.tree`), 'utf8')).toBe(NEW);
    expect(await collecting(root)).toEqual([]);
    expect(result.removed).toEqual([join(root, `${KEY}.tree`)]);
  });

  it('removes an old orphan record nobody replaced', async () => {
    const root = await store();
    const result = await collectSharedStore({
      env: { OPM_STORE_HOME: root },
    });
    expect(result.removed).toEqual([join(root, `${KEY}.tree`)]);
    expect(await readdir(root)).toEqual([]);
  });
});

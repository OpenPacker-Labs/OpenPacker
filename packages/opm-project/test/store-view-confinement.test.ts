import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_INHERITED_HANDLES } from '@openpacker/sandbox';
import { runSandboxedPackageProcess } from '../src/index.js';

/**
 * What a sandboxed process sees of a store whose entries it is given, bound
 * one by one or through a view: those entries at their own paths, read-only,
 * and nothing else of the store, not even the view's own directory.
 *
 * The working directory is outside the store. One that contains the store
 * (the cache root) is bound read-only over it and shows the whole store, view
 * included, as it always has (ADR 0036).
 */

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** What the sandboxed process reports of the store and of entry 0. */
const probe = (store: string, entry: string) => `
const fs = require('fs');
const attempt = (act) => { try { act(); return 'done'; } catch (error) { return error.code; } };
const file = ${JSON.stringify(join(entry, 'package', 'index.js'))};
process.stdout.write(JSON.stringify({
  listing: fs.readdirSync(${JSON.stringify(store)}).sort(),
  write: attempt(() => fs.writeFileSync(file, 'changed')),
  append: attempt(() => fs.appendFileSync(file, 'changed')),
  chmod: attempt(() => fs.chmodSync(file, 0o777)),
  unlink: attempt(() => fs.unlinkSync(file)),
  mkdirInEntry: attempt(() => fs.mkdirSync(${JSON.stringify(join(entry, 'added'))})),
  mkdirInStore: attempt(() => fs.mkdirSync(${JSON.stringify(join(store, 'added'))})),
}));
`;

const canSandbox =
  process.platform === 'linux' &&
  ['/usr/bin/bwrap', '/bin/bwrap'].some((path) => existsSync(path));

describe.runIf(canSandbox)('a store as a sandboxed tool sees it', () => {
  // The working directory and the jail's home take two handles: fourteen
  // entries are bound alone, fifteen through a view.
  it.each([
    ['alone', MAX_INHERITED_HANDLES - 2],
    ['through a view', MAX_INHERITED_HANDLES - 1],
  ])('holds only the entries bound %s, read-only', async (_how, count) => {
    const base = await mkdtemp(join(tmpdir(), 'opm-view-confined-'));
    temps.push(base);
    const store = join(base, '.opm', 'store');
    const entry = (i: number) =>
      join(store, `sha256-${i.toString(16).padStart(64, '0')}`);
    for (let i = 0; i <= count; i += 1) {
      await mkdir(join(entry(i), 'package'), { recursive: true });
      await writeFile(join(entry(i), 'package', 'index.js'), `${i}\n`);
    }
    // The last entry is in the store but not in the closure.
    const closure = Array.from({ length: count }, (_, i) => entry(i));
    const work = join(base, 'work');
    await mkdir(work);

    const outcome = await runSandboxedPackageProcess({
      argv: [process.execPath, '-e', probe(store, entry(0))],
      cwd: work,
      storePaths: closure,
    });
    expect(outcome.stderr).toBe('');
    const seen = JSON.parse(outcome.stdout);
    expect(seen.listing).toEqual(closure.map((path) => basename(path)).sort());
    expect(seen).toMatchObject({
      write: 'EROFS',
      append: 'EROFS',
      chmod: 'EROFS',
      unlink: 'EROFS',
      mkdirInEntry: 'EROFS',
    });
    // Through a view the store itself is the read-only bind. Bound alone, the
    // store is a directory bwrap made in the sandbox's own scratch root: a
    // name can be added there, and it never reaches the store (below).
    expect(seen.mkdirInStore).toBe(
      count === MAX_INHERITED_HANDLES - 1 ? 'EROFS' : 'done',
    );
    expect(await readFile(join(entry(0), 'package', 'index.js'), 'utf8')).toBe(
      '0\n',
    );
    expect(existsSync(join(store, 'added'))).toBe(false);
  });
});

describe.skipIf(canSandbox)('a store as a sandboxed tool sees it', () => {
  it.skip('needs bwrap (/usr/bin/bwrap); not checked on this host', () => {});
});

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENVIRONMENT_STATE, GENERATIONS_DIR } from '../src/generations.js';
import { NATIVE_STATE } from '../src/native.js';
import { OPM_DIR } from '../src/paths.js';
import {
  linkDigest,
  parseRollbackRecord,
  ROLLBACK_FILES,
  ROLLBACK_TREES,
  sha256,
} from '../src/rollback-record.js';

/**
 * The record of a rollback copy names no path: one row per entry of the
 * tables, by position. Anything else is not a record this opm reads.
 */

const owner = { pid: 4242, host: 'vm', startTime: '66484' };
const kept = { before: sha256('a\n'), mode: 0o644 };
const ready = {
  rollbackVersion: 1,
  state: 'ready',
  owner,
  files: ROLLBACK_FILES.map(() => kept),
  trees: ROLLBACK_TREES.map(() => true),
};

describe('the tables a copy keeps', () => {
  it('spell the state files as the modules that write them do', () => {
    expect(ROLLBACK_FILES).toContain(join(OPM_DIR, NATIVE_STATE));
    expect(ROLLBACK_FILES).toContain(join(OPM_DIR, ENVIRONMENT_STATE));
    expect(ROLLBACK_TREES.map((tree) => tree.path)).toContain(
      join(OPM_DIR, GENERATIONS_DIR),
    );
  });
});

describe('a rollback record read back', () => {
  it('is kept when it has one row per table entry', () => {
    expect(parseRollbackRecord(ready)).toEqual(ready);
    expect(
      parseRollbackRecord({ ...ready, state: 'copying', files: [], trees: [] }),
    ).toEqual({ ...ready, state: 'copying', files: [], trees: [] });
  });

  it.each([
    [
      'paths in place of rows',
      {
        ...ready,
        files: [{ path: '../outside-written.txt', present: true }],
        trees: [{ path: '../victim-dir', present: false }],
      },
    ],
    ['a row too few', { ...ready, files: ready.files.slice(1) }],
    ['a tree too many', { ...ready, trees: [...ready.trees, true] }],
    ['a ready record with nothing kept', { ...ready, files: [], trees: [] }],
    [
      'a path beside a row',
      {
        ...ready,
        files: ready.files.map((row) => ({ ...row, before: '../x' })),
      },
    ],
    [
      'a mode out of range',
      {
        ...ready,
        files: ready.files.map((row) => ({ ...row, mode: 0o10000 })),
      },
    ],
    ['another version', { ...ready, rollbackVersion: 2 }],
    ['another state', { ...ready, state: 'done' }],
    ['an owner with no pid', { ...ready, owner: { host: 'vm' } }],
  ])('is refused with %s', (_case, value) => {
    expect(parseRollbackRecord(value)).toBeUndefined();
  });
});

describe('a row of a record read back (round 5)', () => {
  const rows = (row: { before: string; mode?: number; link?: string }) =>
    ROLLBACK_FILES.map((_file, index) => (index === 2 ? row : kept));

  it('is a link only when its digest is the digest of its target', () => {
    const link = 'target/elsewhere';
    expect(
      parseRollbackRecord({
        ...ready,
        files: rows({ before: linkDigest(link), link }),
      }),
    ).toBeDefined();
    expect(
      parseRollbackRecord({
        ...ready,
        files: rows({ before: linkDigest('another/target'), link }),
      }),
    ).toBeUndefined();
    expect(
      parseRollbackRecord({
        ...ready,
        files: rows({ before: sha256('bytes'), link }),
      }),
    ).toBeUndefined();
  });

  it('lists at most 32 contents the step told the copy of', () => {
    const also = (count: number) =>
      Array.from({ length: count }, (_x, n) => sha256(`write ${n}`));
    expect(
      parseRollbackRecord({
        ...ready,
        files: rows({ ...kept, also: also(32) }),
      }),
    ).toBeDefined();
    expect(
      parseRollbackRecord({
        ...ready,
        files: rows({ ...kept, also: also(33) }),
      }),
    ).toBeUndefined();
  });
});

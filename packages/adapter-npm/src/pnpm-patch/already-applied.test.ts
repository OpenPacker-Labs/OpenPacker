/**
 * A patch that fails forward and whose reverse would apply counts as applied
 * (ADR 0057 §9), as pnpm counts it, and the package keeps what the two runs
 * left: the files the forward run wrote before it failed, and any mode the
 * dry run of the reverse set (pnpm's dry run still runs chmod). Only a patch
 * that fails both ways leaves the package as it was. The outcomes below are
 * pnpm 10.28's own `applyPatchToDir` on the same trees (review 184's
 * edge-case script, run 2026-10-17).
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPnpmPatch } from './index.js';
import { readTree } from './tree-fixture.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function packageOf(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pnpm-patch-already-'));
  temps.push(dir);
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(dir, name), text);
    await chmod(join(dir, name), 0o644);
  }
  return dir;
}

const edit = (path: string) => [
  `diff --git a/${path} b/${path}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  '@@ -1 +1 @@',
  '-1',
  '+2',
];

const apply = (dir: string, lines: string[]) =>
  applyPnpmPatch(
    dir,
    {
      key: 'x',
      file: 'c.patch',
      hash: '',
      digest: '',
      text: `${lines.join('\n')}\n`,
    },
    'x@1.0.0',
  );

describe('a patch the package already has, in part', () => {
  it('keeps what the forward run wrote before it failed', async () => {
    const dir = await packageOf({ a: '2\n', b: '1\n' });
    await apply(dir, [...edit('b'), ...edit('a')]);
    expect(await readTree(dir)).toEqual({
      a: { text: '2\n', executable: false },
      b: { text: '2\n', executable: false },
    });
  });

  it('keeps the mode the dry run of the reverse set back', async () => {
    const dir = await packageOf({ a: '2\n', t: 't\n' });
    await apply(dir, [
      'diff --git a/t b/t',
      'old mode 100644',
      'new mode 100755',
      ...edit('a'),
    ]);
    expect(await readTree(dir)).toEqual({
      a: { text: '2\n', executable: false },
      t: { text: 't\n', executable: false },
    });
  });
});

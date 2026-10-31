/**
 * The patch reader and applier against pnpm's own code (ADR 0057):
 * `test/pnpm-patch-oracle/oracle.json` is what pnpm 10.28's
 * `applyPatchToDir` did with each case and what pnpm 10.28's and 9.15's
 * `calcPatchHashes` record for each file (`generate.mjs` makes it from the two
 * bundles). opm must do the same, except that where pnpm fails it leaves the
 * package as it was rather than half patched.
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPnpmPatch, pnpm10PatchHash, pnpm9PatchHash } from './index.js';
import { readTree } from './tree-fixture.js';

interface Files {
  readonly [path: string]: string;
}

interface ApplyCase {
  readonly name: string;
  readonly files: Files;
  readonly patch: string;
  readonly outcome: string;
  readonly after?: Record<string, { text: string; executable: boolean }>;
}

interface HashCase {
  readonly name: string;
  readonly base64: string;
  readonly pnpm10: { hash: string; path: string };
  readonly pnpm9: { hash: string; path: string };
}

const oracle = JSON.parse(
  readFileSync(
    new URL('../../test/pnpm-patch-oracle/oracle.json', import.meta.url),
    'utf8',
  ),
) as { apply: ApplyCase[]; hash: HashCase[] };

const CODES: Record<string, string> = {
  ERR_PNPM_PATCH_FAILED: 'PATCH_FAILED',
  ERR_PNPM_INVALID_PATCH: 'INVALID_PATCH',
};

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function packageOf(files: Files): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pnpm-patch-'));
  temps.push(dir);
  for (const [path, text] of Object.entries(files)) {
    const where = join(dir, ...path.split('/'));
    await mkdir(dirname(where), { recursive: true });
    await writeFile(where, text);
    await chmod(where, 0o644);
  }
  return dir;
}

const patchOf = (text: string) => ({
  key: 'a@1.0.0',
  file: 'patches/a@1.0.0.patch',
  hash: '',
  digest: '',
  text,
});

describe('a patch applied as pnpm 10.28 applies it', () => {
  it('has every case of the oracle', () => {
    expect(oracle.apply.length).toBeGreaterThanOrEqual(37);
  });

  for (const item of oracle.apply)
    it(item.name, async () => {
      const dir = await packageOf(item.files);
      const before = await readTree(dir);
      const done = applyPnpmPatch(dir, patchOf(item.patch), 'a@1.0.0');
      if (item.outcome === 'applied') {
        await done;
        expect(await readTree(dir)).toEqual(item.after);
        return;
      }
      await expect(done).rejects.toMatchObject({ code: CODES[item.outcome] });
      // pnpm leaves what it did before the failure; opm leaves nothing.
      expect(await readTree(dir)).toEqual(before);
    });
});

describe("the hash a lock records for a patch, as pnpm's calcPatchHashes makes it", () => {
  for (const item of oracle.hash)
    it(item.name, () => {
      const bytes = Buffer.from(item.base64, 'base64');
      expect(pnpm10PatchHash(bytes)).toBe(item.pnpm10.hash);
      expect(pnpm9PatchHash(bytes)).toBe(item.pnpm9.hash);
    });
});

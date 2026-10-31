/** The package, patch and cleanup the tests of the case-collision rule share. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import { applyPnpmPatch } from './index.js';

const temps: string[] = [];
/** Removes the packages made since the last call; the tests call it after each. */
export async function removePackages(): Promise<void> {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

export async function packageWith(
  files: Record<string, string>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pnpm-patch-case-'));
  temps.push(dir);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

export const create = (path: string) =>
  [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    '+new',
    '',
  ].join('\n');
export const remove = (path: string) =>
  [
    `diff --git a/${path} b/${path}`,
    'deleted file mode 100644',
    '--- a/${path}',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-old',
    '',
  ]
    .join('\n')
    .split('${path}')
    .join(path);
export const rename = (from: string, to: string) =>
  [
    `diff --git a/${from} b/${to}`,
    'similarity index 100%',
    `rename from ${from}`,
    `rename to ${to}`,
    '',
  ].join('\n');

export const patchOf = (text: string) => ({
  key: 'x@1.0.0',
  file: 'patches/x.patch',
  hash: '',
  digest: '',
  text,
});
export const apply = (dir: string, text: string) =>
  applyPnpmPatch(dir, patchOf(text), 'x@1.0.0').then(
    () => 'applied',
    (error: unknown) => error,
  );
export const collision = (path: string, other: string) =>
  expect.objectContaining({
    code: 'CASE_COLLISION',
    message: expect.stringContaining(`"${path}" beside "${other}"`),
  });

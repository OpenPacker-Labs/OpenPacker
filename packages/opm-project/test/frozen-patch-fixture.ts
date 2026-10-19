/** A shared store and a format, for the tests of publishing a patched entry (ADR 0056 §11). */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FrozenPatch, ProjectFormat } from '@openpacker/adapter-core';
import { patchArchives } from '../src/frozen-patch.js';
import { pnpmWorld, type PnpmWorld } from './frozen-pnpm-fixture.js';

const temps: string[] = [];

/** Remove the stores made since the last call. */
export async function cleanStores(): Promise<void> {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

export const DIGEST = `sha256:${'a'.repeat(64)}`;
export const PATCH: FrozenPatch = {
  key: 'x@1.0.0',
  file: 'patches/x.patch',
  hash: 'b'.repeat(64),
  digest: 'b'.repeat(64),
  text: '',
};

/** A shared store holding x@1.0.0's unpatched entry. */
export async function store(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-patch-publish-'));
  temps.push(root);
  const unpatched = join(root, `sha256-${'a'.repeat(64)}`, 'package');
  await mkdir(unpatched, { recursive: true });
  await writeFile(join(unpatched, 'package.json'), '{"name":"x"}');
  await writeFile(join(unpatched, 'index.js'), 'original\n');
  return root;
}

const LOCK = {
  packages: [
    {
      path: 'node_modules/x',
      packageName: 'x',
      version: '1.0.0',
      patch: PATCH,
    },
  ],
};

export function publish(
  root: string,
  format: Pick<ProjectFormat, 'applyFrozenPatch'>,
  recordWaitMs?: number,
  maximumFiles?: number,
) {
  return patchArchives({
    lock: LOCK,
    byPath: new Map([
      [
        'node_modules/x',
        {
          path: join(root, `sha256-${'a'.repeat(64)}`),
          digest: DIGEST,
          fetchedBytes: 0,
          fetched: false,
        },
      ],
    ]),
    storeRoot: root,
    shared: true,
    format,
    ...(recordWaitMs !== undefined && { recordWaitMs }),
    ...(maximumFiles !== undefined && { maximumFiles }),
  });
}

/** A format whose `n`th application writes `tree n`, after `wait(n)`. */
export function numbered(wait: (call: number) => Promise<void>) {
  let calls = 0;
  const format = {
    async applyFrozenPatch(dir: string) {
      calls += 1;
      const call = calls;
      await wait(call);
      await writeFile(join(dir, 'index.js'), `tree ${call}\n`);
    },
  };
  return { format, calls: () => calls };
}

/** A format that gives the same tree every time, as a real patch does. */
export function deterministic() {
  let calls = 0;
  const format = {
    async applyFrozenPatch(dir: string) {
      calls += 1;
      await writeFile(join(dir, 'index.js'), 'patched\n');
    },
  };
  return { format, calls: () => calls };
}

/** x@1.0.0 patched by `patch`, in a project of its own (a lock, its files and the patch on disk). */
export async function patchedWorld(patch: string): Promise<PnpmWorld> {
  const hash = createHash('sha256')
    .update(patch.split('\r\n').join('\n'))
    .digest('hex');
  const suffix = `(patch_hash=${hash})`;
  const w = await pnpmWorld();
  w.pkg({
    name: 'x',
    version: '1.0.0',
    suffix,
    files: { 'lib.js': "module.exports = 'original';\n" },
  });
  w.importer(
    '.',
    { dependencies: { x: ['1.0.0', `1.0.0${suffix}`] } },
    { pnpm: { patchedDependencies: { 'x@1.0.0': 'patches/x.patch' } } },
  );
  w.rootLines(
    'patchedDependencies:',
    '  x@1.0.0:',
    `    hash: ${hash}`,
    '    path: patches/x.patch',
    '',
  );
  await w.write();
  await mkdir(join(w.dir, 'patches'));
  await writeFile(join(w.dir, 'patches', 'x.patch'), patch);
  return w;
}

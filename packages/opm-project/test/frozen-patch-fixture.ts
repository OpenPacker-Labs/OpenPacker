/** A shared store and a format, for the tests of publishing a patched entry (ADR 0056 §11). */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FrozenPatch, ProjectFormat } from '@openpacker/adapter-core';
import { patchArchives } from '../src/frozen-patch.js';

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

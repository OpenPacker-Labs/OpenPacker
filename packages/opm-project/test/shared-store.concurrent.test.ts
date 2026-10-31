import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packTarGzip } from '@openpacker/project-io';
import {
  materializeThroughSharedStore,
  storeKeyFromDigest,
} from '../src/index.js';

/**
 * Installs of one new package at the same time, over and over.
 *
 * One run of `shared-store.default.test.ts` rarely lands the interleaving in
 * which an install finds the record beside the entry replaced under it, so this
 * runs it many times. Before `shared-store-record.ts` it failed in each of three
 * runs, in round 0 to 13, and in one of two runs of a later review, with
 * "Metadata file changed during publication" (a script of 40 rounds of six
 * installs measured 8 to 10 failed installs), all on Linux. It is a likelihood,
 * not a guard: `shared-store-record.test.ts` is the deterministic one.
 */

const made: string[] = [];
afterEach(async () => {
  await Promise.all(
    made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

describe('the shared store under concurrent installs', () => {
  // Thirty rounds of six installs, each extracting a 64 KiB archive and
  // linking a tree, one round to a test: the same rounds as one test of thirty,
  // and as likely to land the race, while each round stays within the
  // package's own bound (alone a round takes about 0.4 s). Nothing here times
  // the work.
  it.each(Array.from({ length: 30 }, (_, round) => round))(
    'publishes a new package once however many installs race for it (round %i)',
    async (round) => {
      const bytes = packTarGzip([
        {
          path: 'package/package.json',
          contents: new TextEncoder().encode(
            '{"name":"demo","version":"1.0.0"}',
          ),
        },
        { path: 'package/big.bin', contents: randomBytes(64 * 1024) },
      ]);
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const key = storeKeyFromDigest(digest);
      const shared = await tempDir('opm-shared-');
      const projects = await Promise.all(
        Array.from({ length: 6 }, () => tempDir('opm-proj-')),
      );
      const results = await Promise.allSettled(
        projects.map((project) =>
          materializeThroughSharedStore({
            digest,
            projectStorePath: join(project, key),
            bytes,
            format: 'tar+gzip',
            env: { OPM_STORE_HOME: shared },
          }),
        ),
      );
      expect(
        results.filter((result) => result.status === 'rejected'),
        `round ${round}`,
      ).toEqual([]);
      expect((await readdir(shared)).sort()).toEqual(
        [key, `${key}.tree`].sort(),
      );
    },
  );
});

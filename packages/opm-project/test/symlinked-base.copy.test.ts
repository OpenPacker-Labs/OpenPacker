/**
 * A store file a project gets its own copy of is the project's to write, as
 * its own user (ADR 0034, amendment of 2026-10-31: every copy is one function,
 * and a project's copy is owner-writable).
 */

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetBases, packTarGzip } from '@openpacker/project-io';
import {
  enableDefaultSharedStore,
  isolateProjectStoreFromSharedLinks,
  materializeThroughSharedStore,
  projectPaths,
  storeKeyFromDigest,
} from '../src/index.js';

const POSIX = process.platform === 'linux' || process.platform === 'darwin';
const ROOT = process.geteuid?.() === 0;
const NOBODY = 65534;

const worlds: string[] = [];
const mounts: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  enableDefaultSharedStore(false);
  forgetBases();
  for (const mount of mounts.splice(0))
    execFileSync('umount', [mount], { stdio: 'ignore' });
  for (const world of worlds.splice(0))
    await rm(world, { recursive: true, force: true });
});

async function world(): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'opm-fences-'));
  worlds.push(dir);
  vi.stubEnv('OPM_STORE_HOME', '');
  return dir;
}

describe.runIf(POSIX && ROOT)(
  'a store file a project gets its own copy of',
  () => {
    it('is writable by its owner, so a lifecycle script run as that user may edit it', async () => {
      const base = await world();
      await chmod(base, 0o755);
      const shared = join(base, 'shared');
      await mkdir(shared, { mode: 0o700 });
      const root = join(base, 'project');
      await mkdir(join(root, '.opm', 'store'), { recursive: true });
      projectPaths(root);
      const bytes = packTarGzip([
        {
          path: 'package/index.js',
          contents: new TextEncoder().encode('export const n = 1;\n'),
        },
      ]);
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const entry = join(root, '.opm', 'store', storeKeyFromDigest(digest));
      await materializeThroughSharedStore({
        digest,
        projectStorePath: entry,
        bytes,
        format: 'tar+gzip',
        env: { OPM_STORE_HOME: shared },
      });
      const file = join(entry, 'package', 'index.js');
      expect((await stat(file)).nlink).toBeGreaterThan(1);

      await isolateProjectStoreFromSharedLinks(entry);
      // The project as its own user would hold it, and that user editing it.
      execFileSync('chown', ['-R', `${NOBODY}:${NOBODY}`, root]);
      const edit = promisify(execFile)(
        process.execPath,
        [
          '-e',
          `require('fs').appendFileSync(${JSON.stringify(file)}, '//\\n')`,
        ],
        { uid: NOBODY, gid: NOBODY },
      );
      await expect(edit).resolves.toBeDefined();
      expect((await stat(file)).nlink).toBe(1);
    });
  },
);

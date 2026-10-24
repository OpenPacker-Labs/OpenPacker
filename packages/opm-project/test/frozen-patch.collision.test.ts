import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup } from './frozen-pnpm-fixture.js';
import { patchedWorld } from './frozen-patch-fixture.js';
import { onPosix } from './frozen-workspace-fixture.js';

const stores: string[] = [];
afterEach(async () => {
  await cleanup();
  await Promise.all(
    stores.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/**
 * A patch that creates `LIB.js` beside the package's `lib.js` leaves a pair an
 * archive refuses as CASE_COLLISION (ADR 0057 §13). `opm ci` stops with
 * UNSAFE_PATH (exit 7) and the message names the archive's code, the install
 * writes nothing, and no patched entry is left in the store.
 */
describe.runIf(onPosix)('opm ci over a patch that creates a case twin', () => {
  const PATCH = [
    'diff --git a/LIB.js b/LIB.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/LIB.js',
    '@@ -0,0 +1 @@',
    '+twin',
    '',
  ].join('\n');

  it('stops with UNSAFE_PATH naming CASE_COLLISION, and leaves nothing installed or published', async () => {
    const w = await patchedWorld(PATCH);
    const store = await mkdtemp(join(tmpdir(), 'opm-collision-'));
    stores.push(store);
    const outcome = await w.install({ env: { OPM_STORE_HOME: store } }).then(
      () => 'installed',
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({
      code: 'UNSAFE_PATH',
      message: expect.stringContaining('"LIB.js" beside "lib.js"'),
    });
    expect(String((outcome as Error).message)).toContain('CASE_COLLISION');
    const names = await readdir(store);
    expect(names.filter((name) => name.includes('-patch-'))).toEqual([]);
    expect(await readdir(w.dir)).not.toContain('node_modules');
  }, 120_000);
});

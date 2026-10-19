import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertResolvedStores } from '../../../tests/support/store-guard.js';

/**
 * A test run never reads or writes the caller's package store or caches. An
 * agent ran this suite with OPM_STORE_HOME pointing at its real shared store,
 * and the test that tampers with a store file wrote through a hard link into
 * that store and corrupted an entry.
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const insideTmp = (path: string) => {
  const rel = relative(tmpdir(), path);
  return rel !== '' && !rel.startsWith('..');
};

describe('a test run and the caller stores', () => {
  it('points every store and cache location at a fresh temporary directory', () => {
    expect(process.env.OPM_STORE_HOME).toBeUndefined();
    expect(process.env.OPM_TOOL_CACHE).toBeUndefined();
    expect(insideTmp(process.env.XDG_CACHE_HOME ?? '')).toBe(true);
  });

  // Starts a second vitest, which transforms and collects host-fetch.test.ts's
  // whole import graph before it runs one test: 19 to 21 s at a load of 40
  // here, so it keeps a bound above the shared 30 s, and the child's own is 90 s.
  it("leaves the caller's store alone while a test tampers with a store file", async () => {
    const sentinel = await mkdtemp(join(tmpdir(), 'opm-caller-store-'));
    try {
      const vitest = join(
        dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
        'vitest.mjs',
      );
      const child = spawnSync(
        process.execPath,
        [
          vitest,
          'run',
          'test/host-fetch.test.ts',
          '-t',
          'rebuilds a tampered store tree',
        ],
        {
          cwd: packageRoot,
          env: { ...process.env, OPM_STORE_HOME: sentinel },
          encoding: 'utf8',
          timeout: 90_000,
        },
      );
      expect(await readdir(sentinel)).toEqual([]);
      expect(child.status, child.stdout + child.stderr).toBe(0);
    } finally {
      await rm(sentinel, { recursive: true, force: true });
    }
  }, 120_000);

  it('fails a test whose environment resolves a store outside the temporary directory', () => {
    const cache = process.env.XDG_CACHE_HOME;
    const outside = join(packageRoot, '.store-guard-probe');
    const refused = "a test must never read or write the caller's store";
    try {
      expect(() => assertResolvedStores()).not.toThrow();
      process.env.OPM_STORE_HOME = outside;
      expect(() => assertResolvedStores()).toThrow(refused);
      delete process.env.OPM_STORE_HOME;
      process.env.OPM_TOOL_CACHE = outside;
      expect(() => assertResolvedStores()).toThrow(refused);
      delete process.env.OPM_TOOL_CACHE;
      // No XDG_CACHE_HOME: the default store and the tool cache are ~/.cache's.
      delete process.env.XDG_CACHE_HOME;
      expect(() => assertResolvedStores()).toThrow(refused);
    } finally {
      delete process.env.OPM_STORE_HOME;
      delete process.env.OPM_TOOL_CACHE;
      process.env.XDG_CACHE_HOME = cache;
    }
    expect(existsSync(outside)).toBe(false);
  });
});

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
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

/** What the guard's resolvers read. */
const GUARDED = [
  'OPM_STORE_HOME',
  'OPM_TOOL_CACHE',
  'OPM_PLUGIN_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'HOME',
  'USERPROFILE',
] as const;
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

  // Each resolver the guard asks, refused on its own, by name. The location
  // outside is a sibling of the temporary directory, so it is outside however
  // the machine's temporary directory and this checkout are placed (a checkout
  // under /tmp put the old probe, beside the package, inside it).
  it('fails a test whose environment resolves a store outside the temporary directory', () => {
    const saved = Object.fromEntries(
      GUARDED.map((name) => [name, process.env[name]]),
    );
    const temporary = realpathSync(tmpdir());
    const outside = join(
      dirname(temporary),
      `${basename(temporary)}-outside-${process.pid}`,
    );
    const refusal = (what: string) =>
      new RegExp(
        `^${what} resolves to .*: a test must never read or write the caller's store$`,
        'u',
      );
    const refused = (change: Record<string, string | undefined>) => {
      for (const [name, value] of Object.entries(change))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      try {
        assertResolvedStores();
        return undefined;
      } catch (error) {
        return (error as Error).message;
      } finally {
        for (const name of GUARDED)
          if (saved[name] === undefined) delete process.env[name];
          else process.env[name] = saved[name];
      }
    };
    expect(relative(temporary, outside).startsWith('..')).toBe(true);
    expect(refused({})).toBeUndefined();
    expect(refused({ OPM_STORE_HOME: outside })).toMatch(
      refusal('OPM_STORE_HOME'),
    );
    expect(refused({ OPM_TOOL_CACHE: outside })).toMatch(
      refusal('The tool cache'),
    );
    expect(refused({ OPM_PLUGIN_HOME: outside })).toMatch(
      refusal('The plugin store'),
    );
    // The home directory is HOME's, or USERPROFILE's on Windows.
    const home = { HOME: outside, USERPROFILE: outside };
    // No XDG_CACHE_HOME: the default store and the tool cache are home's.
    expect(refused({ XDG_CACHE_HOME: undefined, ...home })).toMatch(
      refusal('The default shared store'),
    );
    // No XDG_DATA_HOME: the plugin store is home's, and only it moves.
    expect(refused({ XDG_DATA_HOME: undefined, ...home })).toMatch(
      refusal('The plugin store'),
    );
    expect(existsSync(outside)).toBe(false);
  });
});

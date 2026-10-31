import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanup,
  setup,
  storedNames,
  tarballOf,
  temps,
  type Pkg,
} from './frozen-workspace-fixture.js';

afterEach(cleanup);

/**
 * A build an install leaves out because its own package.json names another C
 * library (ADR 0059) is never stored, so what its archive declared is
 * recorded against its integrity instead: a later install, online or offline,
 * decides it without fetching it again.
 */

const linux = { os: 'linux', architecture: 'x64', libc: 'glibc' } as const;

const native = (name: string, libc: string): Pkg => ({
  name,
  version: '1.0.0',
  manifest: { os: ['linux'], cpu: ['x64'], libc: [libc] },
});

async function world(required = false) {
  const w = await setup();
  delete w.root.workspaces;
  w.root.optionalDependencies = {
    'native-gnu': '1.0.0',
    'native-musl': '1.0.0',
  };
  const marked = { optional: true, os: ['linux'], cpu: ['x64'] };
  w.place('node_modules/native-gnu', native('native-gnu', 'glibc'), marked);
  w.place('node_modules/native-musl', native('native-musl', 'musl'), marked);
  if (required) {
    w.root.dependencies = { left: '1.0.0' };
    w.place('node_modules/left', { name: 'left', version: '1.0.0' });
  }
  await w.write();
  return w;
}

const names = async (dir: string) =>
  (await readdir(join(dir, 'node_modules')))
    .filter((name) => !name.startsWith('.'))
    .sort();

const bytesOf = (pkg: Pkg) => tarballOf(pkg).byteLength;

describe('a build left out for its C library', () => {
  it('is fetched once: a second install and an offline one decide it from the record', async () => {
    const w = await world();

    const first = await w.install({ target: linux });
    expect(await names(w.dir)).toEqual(['native-gnu']);
    // Both were fetched to read their lists; the counts say so, and agree.
    expect(w.registry.requests).toHaveLength(2);
    expect(first.fetched).toBe(2);
    expect(first.fetchedBytes).toBe(
      bytesOf(native('native-gnu', 'glibc')) +
        bytesOf(native('native-musl', 'musl')),
    );
    expect(await storedNames(`${w.dir}-store`)).toEqual(['native-gnu']);

    await rm(join(w.dir, 'node_modules'), { recursive: true });
    const second = await w.install({ target: linux });
    expect(w.registry.requests).toHaveLength(2);
    expect(second.fetched).toBe(0);
    expect(second.fetchedBytes).toBe(0);
    expect(await names(w.dir)).toEqual(['native-gnu']);
    expect(second.skipped.map((item) => [item.name, item.kind])).toEqual([
      ['native-musl', 'platform'],
    ]);

    await rm(join(w.dir, 'node_modules'), { recursive: true });
    const offline = await w.install({ target: linux, offline: true });
    expect(w.registry.requests).toHaveLength(2);
    expect(await names(w.dir)).toEqual(['native-gnu']);
    expect(offline.skipped.map((item) => [item.name, item.kind])).toEqual([
      ['native-musl', 'platform'],
    ]);
  });

  it('leaves out an optional build offline that the store has never seen, as npm leaves out an optional package it cannot get, and says so', async () => {
    const w = await world();
    const store = await mkdtemp(join(tmpdir(), 'platform-record-'));
    temps.push(store);
    const result = await w.install({
      target: linux,
      offline: true,
      env: { OPM_STORE_HOME: join(store, 'shared') },
    });
    expect(w.registry.requests).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        name: 'native-gnu',
        kind: 'offline',
        reason: expect.stringMatching(/optional.*not in the local store/u),
      }),
      expect.objectContaining({ name: 'native-musl', kind: 'offline' }),
    ]);
  });

  it('still refuses offline when a required package is not in the store, naming that one alone', async () => {
    const w = await world(true);
    const store = await mkdtemp(join(tmpdir(), 'platform-record-'));
    temps.push(store);
    await expect(
      w.install({
        target: linux,
        offline: true,
        env: { OPM_STORE_HOME: join(store, 'shared') },
      }),
    ).rejects.toMatchObject({
      code: 'OFFLINE',
      message: expect.stringMatching(/^1 package is not in the local store/u),
    });
  });
});

import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packTarGzip } from '@openpacker/project-io';
import { collectSharedStore, storeKeyFromDigest } from '../src/index.js';
import { publishSharedEntry } from '../src/shared-store.js';

/**
 * How `opm gc --shared` tells an entry an install may be about to link.
 *
 * An entry is too new to collect while its record (`<entry>.tree`) or the entry
 * directory itself changed within the grace period. The record alone is not
 * enough: a publish that finds the same record already on disk leaves it alone,
 * so a record left behind by an interrupted collection or a failed publish keeps
 * its old time while the entry beside it is brand new. A directory's ctime
 * cannot be set back, so "old" is reached by moving the clock gc reads forward.
 */

const made: string[] = [];
afterEach(async () => {
  await Promise.all(
    made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function sharedRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opm-shared-'));
  made.push(dir);
  return dir;
}

const HOUR = 3_600_000;

function archive(): { bytes: Uint8Array; digest: string } {
  const bytes = packTarGzip([
    {
      path: 'package/package.json',
      contents: new TextEncoder().encode('{"name":"demo","version":"1.0.0"}'),
    },
    {
      path: 'package/index.js',
      contents: new TextEncoder().encode('module.exports = 1;\n'),
    },
  ]);
  return {
    bytes,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

/** Publish the demo package into `shared`, linked by no project. */
async function publish(shared: string) {
  const pkg = archive();
  await publishSharedEntry({
    sharedRoot: shared,
    digest: pkg.digest,
    format: 'tar+gzip',
    bytes: pkg.bytes,
  });
  const key = storeKeyFromDigest(pkg.digest);
  return { key, entry: join(shared, key), record: join(shared, `${key}.tree`) };
}

describe('opm gc --shared and the grace period', () => {
  it('leaves an entry younger than the grace period alone, and collects it once it is old', async () => {
    const shared = await sharedRoot();
    const { entry } = await publish(shared);
    const env = { OPM_STORE_HOME: shared };

    const young = await collectSharedStore({ env });
    expect(young).toMatchObject({ removed: [], tooNew: 1 });

    const later = Date.now() + HOUR;
    const aged = await collectSharedStore({ env, now: () => later });
    expect(aged).toMatchObject({ removed: [entry], tooNew: 0 });
    expect(await readdir(shared)).toEqual([]);
  });

  it('keeps a republished entry whose identical record was left behind an hour ago', async () => {
    const shared = await sharedRoot();
    const { key, entry, record } = await publish(shared);
    // What an interrupted collection or a failed publish leaves: the record
    // without its entry, an hour old.
    await rm(entry, { recursive: true });
    const old = new Date(Date.now() - HOUR);
    await utimes(record, old, old);

    await publish(shared);
    // The same record was there, so the publish did not write it again.
    expect(Math.abs((await stat(record)).mtimeMs - old.getTime())).toBeLessThan(
      1000,
    );

    const result = await collectSharedStore({
      env: { OPM_STORE_HOME: shared },
    });
    expect(result).toMatchObject({ removed: [], tooNew: 1 });
    expect((await readdir(shared)).sort()).toEqual([key, `${key}.tree`].sort());
  });

  it('keeps an old entry whose record was written within the grace period', async () => {
    const shared = await sharedRoot();
    const { record } = await publish(shared);
    const later = Date.now() + HOUR;
    await utimes(record, new Date(later), new Date(later));

    const result = await collectSharedStore({
      env: { OPM_STORE_HOME: shared },
      now: () => later,
    });
    expect(result).toMatchObject({ removed: [], tooNew: 1 });
  });

  it('keeps a new entry that has no record, and collects it once it is old', async () => {
    const shared = await sharedRoot();
    const { entry, record } = await publish(shared);
    await rm(record);
    const env = { OPM_STORE_HOME: shared };

    expect(await collectSharedStore({ env })).toMatchObject({
      removed: [],
      tooNew: 1,
    });
    const later = Date.now() + HOUR;
    expect(await collectSharedStore({ env, now: () => later })).toMatchObject({
      removed: [entry],
      tooNew: 0,
    });
  });
});

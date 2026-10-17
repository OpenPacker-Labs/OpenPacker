import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  materializeThroughSharedStore,
  storeKeyFromDigest,
} from '@openpacker/opm-project';
import { runOpm } from '../src/opm.js';

/** The materializer's defaults, written out: apps/opm does not depend on it. */
const LIMITS = {
  maximumFiles: 10_000,
  maximumExpandedBytes: 64 * 1024 * 1024,
  maximumCompressedBytes: 64 * 1024 * 1024,
  maximumCompressionRatio: 32,
  maximumMemoryBytes: 192 * 1024 * 1024,
  maximumPathBytes: 4096,
  maximumDepth: 128,
};

const temps: string[] = [];
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.OPM_STORE_HOME;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.OPM_STORE_HOME;
  else process.env.OPM_STORE_HOME = previous;
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function capture() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (s: string) => ((out += s), true) },
      stderr: { write: (s: string) => ((err += s), true) },
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

const fixtureTgz = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/opm/demo-tool-1.1.0.tgz',
);

async function sharedEntry(shared: string): Promise<string> {
  const bytes = new Uint8Array(await readFile(fixtureTgz));
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const project = await mkdtemp(join(tmpdir(), 'opm-gc-proj-'));
  temps.push(project);
  const key = storeKeyFromDigest(digest);
  await materializeThroughSharedStore({
    limits: LIMITS,
    digest,
    projectStorePath: join(project, key),
    bytes,
    format: 'tar+gzip',
    env: { OPM_STORE_HOME: shared },
  });
  // The project goes away; only the shared root still holds the files.
  await rm(project, { recursive: true });
  return key;
}

describe('opm gc --shared', () => {
  it('lists, then removes, the entries no project links to', async () => {
    const shared = await mkdtemp(join(tmpdir(), 'opm-gc-shared-'));
    temps.push(shared);
    process.env.OPM_STORE_HOME = shared;
    const key = await sharedEntry(shared);
    const old = new Date(Date.now() - 3_600_000);
    await utimes(join(shared, `${key}.tree`), old, old);

    const dry = capture();
    expect(await runOpm(['gc', '--shared', '--dry-run'], dry.io, shared)).toBe(
      0,
    );
    expect(dry.out).toContain('Would remove 1 unreferenced entry');
    expect(dry.out).toContain(join(shared, key));
    expect(await readdir(shared)).toContain(key);

    const real = capture();
    expect(await runOpm(['gc', '--shared'], real.io, shared)).toBe(0);
    expect(real.out).toContain('Removed 1 unreferenced entry');
    expect(await readdir(shared)).toEqual([]);
  });

  it('needs no project, and says plainly when there is no shared store', async () => {
    process.env.OPM_STORE_HOME = 'off';
    const nowhere = await mkdtemp(join(tmpdir(), 'opm-gc-nowhere-'));
    temps.push(nowhere);

    const result = capture();
    expect(await runOpm(['gc', '--shared'], result.io, nowhere)).toBe(0);

    expect(result.out).toContain('No shared store is in use');
  });
});

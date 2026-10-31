import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readTreeRecord,
  recordTreeDigest,
  type TreeRecordIo,
} from '../src/shared-store-record.js';
import { OpmError } from '../src/types.js';

/**
 * Recording the digest an entry's tree must hash to, while other installs of
 * the same package record it too.
 *
 * Installs of one new package run at the same time, and each writes the file
 * beside the entry. Replacing a file with the same bytes changes its inode, and
 * a stable read or write reports that as INPUT_CHANGED. The cases below make a
 * peer replace the file at each point where that can be noticed, which a run of
 * real installs does only now and then.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`;
const RECORD = `${DIGEST}\n`;
const OTHER = `sha256:${'b'.repeat(64)}\n`;
const replaced = (what: string) =>
  new OpmError('INPUT_CHANGED', `Metadata file changed ${what}: x.tree`);
const absent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

/** An io that answers from a script, one answer per call, and counts the calls. */
function scripted(
  reads: (string | Error)[],
  writes: (undefined | Error)[] = [],
): TreeRecordIo & { reads: number; writes: number } {
  const io = {
    reads: 0,
    writes: 0,
    async read() {
      const next = reads[Math.min(io.reads, reads.length - 1)]!;
      io.reads += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    async write() {
      const next = writes[io.writes];
      io.writes += 1;
      if (next instanceof Error) throw next;
    },
  };
  return io;
}

describe('recordTreeDigest', () => {
  it('writes nothing when the same record is already there', async () => {
    const io = scripted([RECORD]);
    await recordTreeDigest('/shared/entry', DIGEST, io);
    expect(io.writes).toBe(0);
  });

  it('writes when nothing, or something else, is recorded', async () => {
    const none = scripted([absent()], [undefined]);
    await recordTreeDigest('/shared/entry', DIGEST, none);
    expect(none.writes).toBe(1);
    const stale = scripted([OTHER], [undefined]);
    await recordTreeDigest('/shared/entry', DIGEST, stale);
    expect(stale.writes).toBe(1);
  });

  it('accepts a peer replacing the file with the same record while it publishes', async () => {
    const io = scripted([absent(), RECORD], [replaced('during publication')]);
    await expect(
      recordTreeDigest('/shared/entry', DIGEST, io),
    ).resolves.toBeUndefined();
  });

  it('accepts it when the peer replaces the file again while it is read back', async () => {
    const io = scripted(
      [
        absent(),
        replaced('while it was read'),
        replaced('while it was read'),
        RECORD,
      ],
      [replaced('during publication')],
    );
    await expect(
      recordTreeDigest('/shared/entry', DIGEST, io),
    ).resolves.toBeUndefined();
    expect(io.writes).toBe(1);
  });

  it('refuses when what the peer left is a different record', async () => {
    const failure = replaced('during publication');
    const io = scripted([absent(), OTHER], [failure]);
    await expect(recordTreeDigest('/shared/entry', DIGEST, io)).rejects.toBe(
      failure,
    );
  });

  it('refuses a failure that is not a replacement, whatever is recorded', async () => {
    const failure = new OpmError('UNSAFE_PATH', 'not a replacement');
    const io = scripted([absent(), RECORD], [failure]);
    await expect(recordTreeDigest('/shared/entry', DIGEST, io)).rejects.toBe(
      failure,
    );
  });

  it('gives up on a file that never stops being replaced', async () => {
    const failure = replaced('during publication');
    const io = scripted([absent(), replaced('while it was read')], [failure]);
    await expect(recordTreeDigest('/shared/entry', DIGEST, io)).rejects.toBe(
      failure,
    );
  });
});

describe('readTreeRecord', () => {
  it('follows the file being replaced and returns what it ends up saying', async () => {
    const io = scripted([
      replaced('while it was read'),
      replaced('while it was read'),
      RECORD,
    ]);
    await expect(readTreeRecord('x.tree', io)).resolves.toBe(RECORD);
  });

  it('passes on any other failure at once', async () => {
    const io = scripted([absent(), RECORD]);
    await expect(readTreeRecord('x.tree', io)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(io.reads).toBe(1);
  });
});

describe('recordTreeDigest on real files', () => {
  const made: string[] = [];
  afterEach(async () => {
    await Promise.all(
      made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('lets many installs record the same digest at once', async () => {
    for (let round = 0; round < 20; round += 1) {
      const shared = await mkdtemp(join(tmpdir(), 'opm-record-'));
      made.push(shared);
      const entry = join(shared, 'sha256-entry');
      await Promise.all(
        Array.from({ length: 12 }, () => recordTreeDigest(entry, DIGEST)),
      );
      expect(await readFile(`${entry}.tree`, 'utf8')).toBe(RECORD);
    }
  });
});

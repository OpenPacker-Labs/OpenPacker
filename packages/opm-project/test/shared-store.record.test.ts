import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptExistingEntry } from '../src/shared-store.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/**
 * An entry whose `<key>.tree` record is not a digest (cut off, empty, or
 * something else's text) is refused, and the message names the two paths to
 * remove, as the other two refusals of an entry do. A crash cannot cause it:
 * a record is written whole, by a temporary file and a rename, so the
 * message says something else wrote it.
 */
describe('a record that is not a digest', () => {
  it.each([
    ['cut off', `sha256:${'a'.repeat(30)}`],
    ['empty', ''],
    ['not a digest', 'hello\n'],
  ])(
    'is %s: refused, naming the entry and its record to remove',
    async (_, text) => {
      const root = await mkdtemp(join(tmpdir(), 'opm-record-'));
      temps.push(root);
      const entry = join(root, `sha256-${'a'.repeat(64)}`);
      await mkdir(join(entry, 'package'), { recursive: true });
      await writeFile(join(entry, 'package', 'index.js'), 'x\n');
      await writeFile(`${entry}.tree`, text);
      const outcome = await adoptExistingEntry(entry, 'x').then(
        () => 'adopted',
        (error: unknown) => error,
      );
      expect(outcome).toMatchObject({
        code: 'VERIFICATION_FAILED',
        message: expect.stringContaining(
          `Shared store tree digest is malformed: ${entry}.tree is not a sha256 digest; a crash cannot leave this (a record is written whole, by a temporary file and a rename), so something else wrote it; remove ${entry} and ${entry}.tree and run the command again`,
        ),
      });
      // Nothing was changed by looking.
      expect(await readFile(`${entry}.tree`, 'utf8')).toBe(text);
    },
  );
});

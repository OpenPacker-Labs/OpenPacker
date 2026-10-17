import { join, resolve } from 'node:path';
import { writeStableFile } from './paths.js';
import {
  JOURNALED_INDEXES,
  MAX_ALSO,
  ROLLBACK_FILES,
  ROLLBACK_RECORD,
  sha256,
  type RollbackRecord,
} from './rollback-record.js';

/**
 * What a copy is told about the writes a step makes after it (ADR 0056 §4).
 *
 * package.json and package-lock.json are written late, by the adapters, and
 * are the people's as much as opm's: a hand edit or an `npm install` between a
 * kill and the next step must not be taken for the killed step's work and put
 * back over. So before such a write the digest of what the file is about to
 * hold is added to the copy's record (`also`) and the record is replaced
 * durably; recovery then puts the copy back over the file only while it holds
 * what the copy kept or one of those digests.
 */

export async function writeRecord(
  holder: string,
  record: RollbackRecord,
): Promise<void> {
  await writeStableFile(
    join(holder, ROLLBACK_RECORD),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

/**
 * The observer for the writes of a step on `root` whose copy is `holder`:
 * told of each write before it is made (`@openpacker/project-io`
 * `observeWrites`), it records a journaled file's new digest. Writes are
 * recorded one at a time, so two at once cannot lose each other's digest.
 */
export function journalWrites(
  root: string,
  holder: string,
  record: RollbackRecord,
): (path: string, contents: string | Uint8Array) => Promise<void> {
  let queue: Promise<void> = Promise.resolve();
  return (path, contents) => {
    const index = JOURNALED_INDEXES.find(
      (candidate) =>
        resolve(path) === resolve(root, ROLLBACK_FILES[candidate] ?? ''),
    );
    if (index === undefined) return Promise.resolve();
    const record_ = async () => {
      const row = record.files[index];
      if (row === undefined) return;
      const digest = sha256(contents);
      const known = row.also ?? [];
      if (row.before === digest || known.includes(digest)) return;
      row.also = [...known, digest].slice(-MAX_ALSO);
      await writeRecord(holder, record);
    };
    const run = queue.then(record_);
    queue = run.catch(() => undefined);
    return run;
  };
}

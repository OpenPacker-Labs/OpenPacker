import { lstat, readdir, readFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { projectPaths, readStableFile } from './paths.js';
import {
  describeProcessOwner,
  isOwnerAlive,
  type ProcessOwner,
} from './process-owner.js';
import { absent, discardCopy, restoreFrom } from './project-rollback.js';
import {
  DISCARD_SUFFIX,
  parseRollbackRecord,
  ROLLBACK_FILES,
  ROLLBACK_PREFIX,
  ROLLBACK_RECORD,
  sha256,
  type RollbackRecord,
} from './rollback-record.js';
import { OpmError } from './types.js';

/** A copy a step left behind, and what was done with it. */
export interface RecoveredStep {
  /** The copy, relative to the project root. */
  copy: string;
  /** The process whose step left it. */
  owner: ProcessOwner;
  /** True when the project was put back from it; false when it was only removed. */
  restored: boolean;
}

/**
 * Finish what a killed step left in `root/.opm`, and nowhere else. Run by a
 * step that holds the project's step lock (`project-step.ts`), before its own
 * work, so no other step's copy can be live here unless its owner is beyond
 * what this process can judge.
 *
 * Each copy must be a directory of this user, not a link, directly under the
 * project's own `.opm`, with a record this opm can read; anything else stops
 * the step with nothing changed. Then:
 * - a copy whose owner may still be running (another machine, boot or PID
 *   namespace; a process of another user) stops the step with `PROJECT_BUSY`;
 * - a `ready` copy that was not being discarded means the project may be half
 *   way through a step: it is put back, unless a file the step said it would
 *   write holds neither what it held nor what the step meant to write, which
 *   stops the step with `ROLLBACK_CONFLICT` and keeps the copy;
 * - a copy still being made (no record yet, or `copying`: the step had not
 *   started writing) or being discarded (the step had finished) is removed.
 */
export async function recoverHeldProject(
  root: string,
  /** How a record is read: `readStableFile`, but for tests of a failed read. */
  readText: (
    path: string,
    maximumBytes: number,
  ) => Promise<string> = readStableFile,
): Promise<RecoveredStep[]> {
  const paths = projectPaths(root);
  const opm = await lstat(paths.opmDir).catch(absent);
  if (opm === undefined) return [];
  if (!opm.isDirectory()) throw unsafe('.opm is not a directory');
  const recovered: RecoveredStep[] = [];
  for (const name of (await readdir(paths.opmDir)).sort()) {
    if (!name.startsWith(ROLLBACK_PREFIX)) continue;
    const copy = join('.opm', name);
    const holder = join(paths.opmDir, name);
    const info = await lstat(holder).catch(absent);
    if (info === undefined) continue;
    assertOwnCopy(info, copy);
    const record = await readRecord(holder, copy, readText);
    if (record === undefined) {
      // Cut short before its record was written, or half removed: either way
      // the step had changed nothing it would need to put back.
      await discardCopy(holder);
      continue;
    }
    if (await isOwnerAlive(record.owner))
      throw new OpmError(
        'PROJECT_BUSY',
        `${copy} belongs to a step of ${describeProcessOwner(record.owner)} that may still be running, and opm cannot tell from here. Run this again when it has finished; if it is not running, remove ${copy} to keep the project as it is now.`,
      );
    const restore = record.state === 'ready' && !name.endsWith(DISCARD_SUFFIX);
    if (restore) {
      await assertRestorable(paths.root, record, copy);
      await restoreFrom(paths.root, holder, record);
    } else await discardCopy(holder);
    recovered.push({ copy, owner: record.owner, restored: restore });
  }
  return recovered;
}

/** One line for each copy recovered, as `opm` prints it on stderr. */
export function describeRecovery(step: RecoveredStep): string {
  return step.restored
    ? `opm: put the project back as it was before a step that process ${step.owner.pid} did not finish, and removed ${step.copy}`
    : `opm: removed ${step.copy}, left by process ${step.owner.pid} before it changed the project`;
}

function assertOwnCopy(info: Stats, copy: string): void {
  if (info.isSymbolicLink() || !info.isDirectory())
    throw unsafe(`${copy} is not a directory`);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid)
    throw unsafe(`${copy} belongs to user ${info.uid}, not to this user`);
}

function unsafe(what: string): OpmError {
  return new OpmError(
    'UNSAFE_PATH',
    `Refusing to recover a step from it: ${what}. opm made no change; remove it if you know where it came from.`,
  );
}

/**
 * The record of a copy. `undefined` only when there is none; a record that
 * cannot be read or is not one this opm writes stops the step, the copy kept.
 */
async function readRecord(
  holder: string,
  copy: string,
  readText: (path: string, maximumBytes: number) => Promise<string>,
): Promise<RollbackRecord | undefined> {
  const where = join(copy, ROLLBACK_RECORD);
  let text: string;
  try {
    text = await readText(join(holder, ROLLBACK_RECORD), 1024 * 1024);
  } catch (error) {
    // SAFETY: only the errno code of a file-system error is read.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new OpmError(
      error instanceof OpmError ? 'INVALID_ROLLBACK' : 'UNAVAILABLE',
      `Could not read ${where} (${error instanceof Error ? error.message : String(error)}); the copy is kept and nothing was changed. Run this again.`,
      { cause: error },
    );
  }
  let record: RollbackRecord | undefined;
  try {
    record = parseRollbackRecord(JSON.parse(text));
  } catch {
    record = undefined;
  }
  if (record === undefined)
    throw new OpmError(
      'INVALID_ROLLBACK',
      `${where} is not a record this opm writes (another version, or not written by opm); the copy is kept and nothing was changed.`,
    );
  return record;
}

/**
 * The files the step said it would write hold either what they held or what
 * the step meant to write. Anything else was written after the step, by
 * someone else, and putting the copy back would undo it.
 */
async function assertRestorable(
  root: string,
  record: RollbackRecord,
  copy: string,
): Promise<void> {
  for (const [index, file] of ROLLBACK_FILES.entries()) {
    const kept = record.files[index];
    if (kept?.after === undefined) continue;
    const bytes = await readFile(join(root, file)).catch(absent);
    const now = bytes === undefined ? null : sha256(bytes);
    if (now !== kept.before && now !== kept.after)
      throw new OpmError(
        'ROLLBACK_CONFLICT',
        `${file} changed after a step that process ${record.owner.pid} did not finish, so opm will not put the project back from ${copy} over it. Remove ${copy} to keep the project as it is now.`,
      );
  }
}

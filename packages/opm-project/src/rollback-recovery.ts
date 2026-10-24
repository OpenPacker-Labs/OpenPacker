import { lstat, readdir } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { projectPaths, readStableFile } from './paths.js';
import {
  describeProcessOwner,
  isOwnerAlive,
  type ProcessOwner,
} from './process-owner.js';
import {
  absent,
  discardCopy,
  liveDigest,
  readLive,
  sweepRestoreNames,
} from './rollback-files.js';
import {
  otherProject,
  projectIdentity,
  sharesOpmDir,
} from './rollback-project.js';
import { opmEntry, printable } from './fs-reason.js';
import { markerOf, marked, restoreFrom } from './rollback-restore.js';
import {
  DISCARD_SUFFIX,
  JOURNALED_INDEXES,
  parseRollbackRecord,
  ROLLBACK_FILES,
  ROLLBACK_PREFIX,
  ROLLBACK_RECORD,
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
  /** The real path of the project it was made in, when that is not this one: it was removed, not put back. */
  foreign?: string;
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
 * - a `ready` copy made in another project (a copied `.opm`, a cache) is never
 *   put back: it stops the step with `INVALID_ROLLBACK`, and is removed, and
 *   nothing else done, by `opm recover --abandon-step`;
 * - a `ready` copy that was not being discarded means the project may be half
 *   way through a step: it is put back, unless a file the step said it would
 *   write (opm.toml, the lock) or told the copy it was about to (package.json,
 *   package-lock.json) holds neither what it held nor what the step meant to
 *   write, which stops the step with `ROLLBACK_CONFLICT` and keeps the copy;
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
  /** Owners the operator asserted are dead (`opm recover --abandon-step`). */
  abandoned?: (owner: ProcessOwner) => boolean,
): Promise<RecoveredStep[]> {
  const paths = projectPaths(root);
  // Held under the project's lock, so a temporary name a putting back left is
  // always a leftover, whether or not its copy is still there.
  await sweepRestoreNames(paths.root);
  const opm = await lstat(paths.opmDir).catch(absent);
  if (opm === undefined) return [];
  if (!opm.isDirectory()) throw unsafe('.opm is not a directory');
  const recovered: RecoveredStep[] = [];
  for (const name of (await readdir(paths.opmDir)).sort()) {
    if (!name.startsWith(ROLLBACK_PREFIX)) continue;
    const copy = opmEntry(name);
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
    const restore = record.state === 'ready' && !name.endsWith(DISCARD_SUFFIX);
    const foreign = restore
      ? await otherProject(paths.root, record.project)
      : undefined;
    if (foreign !== undefined) {
      const shared = await sharesOpmDir(foreign, paths.opmDir);
      if (abandoned?.(record.owner) !== true || shared)
        throw await foreignCopy(paths.root, name, foreign, shared);
      await discardCopy(holder);
      recovered.push({ copy, owner: record.owner, restored: false, foreign });
      continue;
    }
    if (
      abandoned?.(record.owner) !== true &&
      (await isOwnerAlive(record.owner))
    )
      throw new OpmError(
        'PROJECT_BUSY',
        `${copy} belongs to a step of ${describeProcessOwner(record.owner)} that may still be running, and opm cannot tell from here. Run this again when it has finished (--wait <ms> waits longer). If that step is dead and cannot be seen from here (another container or host), opm recover --abandon-step ${printable(copyId(name))} says what taking it for dead costs and asks you to confirm.`,
      );
    if (restore) {
      await assertRestorable(paths.root, holder, record, copy);
      await restoreFrom(paths.root, holder, record);
    } else await discardCopy(holder);
    recovered.push({ copy, owner: record.owner, restored: restore });
  }
  return recovered;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

/** The id of a copy, `.rollback-<pid>-<id>`: what `opm recover --abandon-step` names. */
export function copyId(name: string): string {
  return UUID.exec(name)?.[0] ?? name;
}

/** One line for each copy recovered, as `opm` prints it on stderr. */
export function describeRecovery(step: RecoveredStep): string {
  if (step.foreign !== undefined)
    return `opm: removed ${step.copy}, which was made for the project at ${printable(step.foreign)}; this project was not changed`;
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
 * the step meant to write, and the ones it told the copy of hold what they
 * held or one of the contents it was about to write. Anything else was written
 * after the step, by someone else, and putting the copy back would undo it.
 * A file the copy began to write in place (a bind mount) is its own, half
 * written or not.
 */
async function assertRestorable(
  root: string,
  holder: string,
  record: RollbackRecord,
  copy: string,
): Promise<void> {
  for (const [index, file] of ROLLBACK_FILES.entries()) {
    const kept = record.files[index];
    if (kept === undefined) continue;
    const journaled = JOURNALED_INDEXES.includes(index);
    if (kept.after === undefined && !journaled) continue;
    if (await marked(markerOf(holder, 'files', index, 'putting'))) continue;
    const live = await readLive(join(root, file), file);
    const now = live === undefined ? null : liveDigest(live);
    const wrote = [kept.before, kept.after, ...(kept.also ?? [])];
    if (!wrote.includes(now))
      throw new OpmError(
        'ROLLBACK_CONFLICT',
        `${file} changed after a step that process ${record.owner.pid} did not finish, so opm will not put the project back from ${copy} over it. Remove ${copy} to keep the project as it is now.`,
      );
  }
}

/**
 * A copy made in another project: said plainly, with the way out that changes
 * nothing else. When that project has this very `.opm` the copy is its own
 * (in use, or waiting for it to recover), and the way out is there.
 */
export async function foreignCopy(
  root: string,
  name: string,
  made: string,
  shared: boolean,
): Promise<OpmError> {
  const copy = opmEntry(name);
  const there = printable(made);
  const here = printable((await projectIdentity(root)).path);
  return new OpmError(
    'INVALID_ROLLBACK',
    shared
      ? `${copy} was made by the project at ${there}, which shares this .opm directory with ${here}. It is that project's own copy, and opm will not put it back here or remove it from here. opm made no change; run opm recover in ${there}.`
      : `${copy} was made in the project at ${there}, and this project is at ${here}, so opm will not put it back here: it holds the files of that project's step. opm made no change. If this project is that one moved or restored from a backup (another volume, another path), the step that made the copy was never finished: run opm recover --abandon-step ${printable(copyId(name))} (it only removes the copy, as removing ${copy} does) and then opm sync to finish it. If the copy only came along by accident (a copied .opm, a cache), the same command removes it and nothing else is needed.`,
  );
}

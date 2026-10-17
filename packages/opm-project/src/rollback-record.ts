import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { OPM_DIR } from './paths.js';
import { parseProcessOwner, type ProcessOwner } from './process-owner.js';

/**
 * What a rollback copy keeps (`project-rollback.ts`), and the record of it
 * (`rollback.json`) as it is written and read back.
 *
 * The record is read from the project directory, which may have come from
 * anywhere (a clone, an archive, a shared drive), so it names no path. It
 * holds one entry per row of {@link ROLLBACK_FILES} and
 * {@link ROLLBACK_TREES}, by position, and every path is rebuilt from those
 * tables: a record of another shape is refused whole, never half used.
 */

/** Copies of a project are `.opm/.rollback-<pid>-<uuid>`. */
export const ROLLBACK_PREFIX = '.rollback-';
/** A copy being removed: never one to restore from. */
export const DISCARD_SUFFIX = '.discard';
export const ROLLBACK_RECORD = 'rollback.json';

/*
 * `native.json`, `environment.json` and `generations` are native.ts's
 * NATIVE_STATE and generations.ts's ENVIRONMENT_STATE and GENERATIONS_DIR,
 * spelled out: those modules reach this one through the steps they run, and
 * importing them back would read the names before they are set.
 * rollback-record.test.ts holds the two spellings equal.
 */

/** Files an install may rewrite, relative to the project root. */
export const ROLLBACK_FILES = [
  'opm.toml',
  'opm.lock.json',
  'package.json',
  'package-lock.json',
  join(OPM_DIR, 'project.json'),
  join(OPM_DIR, 'native.json'),
  join(OPM_DIR, 'environment.json'),
] as const;

/** Where in {@link ROLLBACK_FILES} the two files a step writes first are. */
export const MANIFEST_INDEX = 0;
export const LOCK_INDEX = 1;

/**
 * Trees an install may change, relative to the project root. node_modules is
 * kept as hard links (its files are the store's); opm's own small trees are
 * copied, so nothing depends on how they are written.
 */
export const ROLLBACK_TREES = [
  { path: 'node_modules', copy: false },
  { path: join(OPM_DIR, 'bin'), copy: true },
  { path: join(OPM_DIR, 'links'), copy: true },
  { path: join(OPM_DIR, 'generations'), copy: true },
] as const;

/** One row of {@link ROLLBACK_FILES}, as the copy found and kept it. */
export interface KeptFile {
  /** sha256 of the file when the copy was taken; null where there was none. */
  before: string | null;
  /** Its mode then. */
  mode?: number;
  /**
   * sha256 of what the step was about to write over it, where the step said
   * (opm.toml and the lock). The project is put back only over a file that
   * is one or the other: anything else was written by someone after the step.
   */
  after?: string;
}

export interface RollbackRecord {
  rollbackVersion: 1;
  /** `copying` until every file and tree is kept: only `ready` restores. */
  state: 'copying' | 'ready';
  owner: ProcessOwner;
  /** By index of {@link ROLLBACK_FILES}; empty while `copying`. */
  files: KeptFile[];
  /** By index of {@link ROLLBACK_TREES}: whether the tree existed. */
  trees: boolean[];
}

export function sha256(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u;

/**
 * A record as this opm writes it, or `undefined`: another version, a path
 * where an index belongs, a row too many or too few.
 */
export function parseRollbackRecord(
  value: unknown,
): RollbackRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  // SAFETY: each field is checked below before it is used.
  const record = value as Record<string, unknown>;
  const owner = parseProcessOwner(record.owner);
  const { state, files, trees } = record;
  if (record.rollbackVersion !== 1 || owner === undefined) return undefined;
  if (state !== 'copying' && state !== 'ready') return undefined;
  if (!Array.isArray(files) || !Array.isArray(trees)) return undefined;
  // A `copying` record is never restored from: it may list nothing yet.
  const whole =
    files.length === ROLLBACK_FILES.length &&
    trees.length === ROLLBACK_TREES.length;
  const empty = files.length === 0 && trees.length === 0;
  if (!(whole || (state === 'copying' && empty))) return undefined;
  const kept: KeptFile[] = [];
  for (const file of files) {
    const row = parseKeptFile(file);
    if (row === undefined) return undefined;
    kept.push(row);
  }
  if (!trees.every((present) => typeof present === 'boolean')) return undefined;
  // SAFETY: every entry was checked to be a boolean just above.
  return {
    rollbackVersion: 1,
    state,
    owner,
    files: kept,
    trees: trees as boolean[],
  };
}

function parseKeptFile(value: unknown): KeptFile | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  // SAFETY: each field is checked below before it is used.
  const { before, mode, after } = value as Record<string, unknown>;
  if (!(before === null || (typeof before === 'string' && DIGEST.test(before))))
    return undefined;
  if (
    !(after === undefined || (typeof after === 'string' && DIGEST.test(after)))
  )
    return undefined;
  if (
    !(
      mode === undefined ||
      (typeof mode === 'number' &&
        Number.isInteger(mode) &&
        mode >= 0 &&
        mode <= 0o7777)
    )
  )
    return undefined;
  return {
    before,
    ...(!(mode === undefined) && { mode }),
    ...(!(after === undefined) && { after }),
  };
}

import { constants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, sep } from 'node:path';
import { OPMX_NAMES, shimOpmx, type PlannedBinShim } from './bins.js';
import { readStableFile, resolveContained } from './paths.js';
import type { InstalledPackageRecord, ProjectState } from './types.js';

/** What activation writes for one package: its record, shims and link. */
export interface PlannedPackage {
  record: InstalledPackageRecord;
  shims: readonly PlannedBinShim[];
  /** The link file's path and text. */
  link: { path: string; text: string };
}

/** The fields of a bin activation derives, in one order. */
const binKey = (bin: InstalledPackageRecord['bins'][number]) =>
  JSON.stringify([
    bin.name,
    bin.path,
    bin.shim,
    bin.target,
    bin.interpreter ?? null,
    bin.entry ?? null,
  ]);

/**
 * Whether a recorded package is the one activation would record. Only what
 * activation derives from the generation counts: when it was installed, and
 * what an install noted besides (its tree digest, whether lifecycle scripts
 * ran), say nothing about whether the project is up to date.
 */
function sameRecord(
  held: InstalledPackageRecord | undefined,
  wanted: InstalledPackageRecord,
): boolean {
  if (
    held === undefined ||
    held.alias !== wanted.alias ||
    held.purl !== wanted.purl ||
    held.digest !== wanted.digest ||
    held.storePath !== wanted.storePath ||
    held.bins.length !== wanted.bins.length
  )
    return false;
  const keys = (bins: InstalledPackageRecord['bins']) =>
    bins.map(binKey).sort();
  return keys(held.bins).join('\n') === keys(wanted.bins).join('\n');
}

/** What a file holds, read without following a link; undefined for anything but a file. */
async function fileText(
  path: string,
  executable: boolean,
): Promise<string | undefined> {
  const info = await lstat(path).catch(() => undefined);
  if (info?.isFile() !== true) return undefined;
  if (executable && process.platform !== 'win32' && (info.mode & 0o100) === 0)
    return undefined;
  return await readStableFile(path).catch(() => undefined);
}

/**
 * The names an opmx a shim starts may have: those `resolveOpmxPath` finds one
 * by, and the CommonJS one a shim also starts with Node. Anything else, a
 * `/usr/bin/env` say, is no opmx, whatever it would run.
 */
const OPMX_FILES: ReadonlySet<string> = new Set([...OPMX_NAMES, 'opmx.cjs']);

/** Why the opmx a shim starts will not do. */
export type OpmxProblem = 'missing' | 'not opmx';

/**
 * Why `path` cannot be started as a shim starts its `opmx`, or undefined when
 * it can: an absolute path named as an opmx is, whose final target, links
 * followed, is named so too and is a regular file this user may execute, or
 * read where the shim starts it with Node (a name ending `.js`, `.mjs` or
 * `.cjs`). A global npm install's `bin/opmx` is a link to its `opmx-main.js`.
 * The link is followed only to answer this: the shim runs whatever is at that
 * path already, and nothing is written through it.
 */
async function unstartable(path: string): Promise<OpmxProblem | undefined> {
  if (!isAbsolute(path) || !OPMX_FILES.has(basename(path))) return 'not opmx';
  const target = await realpath(path).catch(() => undefined);
  if (target === undefined) return 'missing';
  if (!OPMX_FILES.has(basename(target))) return 'not opmx';
  const info = await stat(target).catch(() => undefined);
  if (info?.isFile() !== true) return 'missing';
  const mode = /\.[cm]?js$/iu.test(path) ? constants.R_OK : constants.X_OK;
  return await access(target, mode).then(
    () => undefined,
    () => 'missing' as const,
  );
}

/** What is out of date, as a path from the project's root, and why. */
export type OutOfDate =
  | { path: string; why: 'differs' }
  /** A shim that would do, but for the `opmx` it starts. */
  | { path: string; why: 'opmx'; opmx: string; problem: OpmxProblem };

/**
 * Whether a shim is the one planned. With `elsewhere`, for a project this user
 * may not write, it is also one that starts another opmx and is otherwise the
 * same script, while that opmx can be started: a project built where opm was
 * installed elsewhere runs as it is.
 */
async function shimOutOfDate(
  planned: PlannedBinShim,
  elsewhere: boolean,
): Promise<'differs' | { opmx: string; problem: OpmxProblem } | undefined> {
  const text = await fileText(planned.shim.shim, true);
  if (text === planned.script) return undefined;
  if (!elsewhere || text === undefined) return 'differs';
  const opmx = shimOpmx(text);
  if (opmx === undefined || planned.scriptFor(opmx) !== text) return 'differs';
  const problem = await unstartable(opmx);
  return problem === undefined ? undefined : { opmx, problem };
}

/**
 * The first thing in the project that is not what activating `planned` would
 * write there, its path relative to `root` (`/`-separated); undefined when the
 * project holds all of it, and activation then writes nothing. `elsewhere`
 * takes a shim that starts another opmx that can be started as up to date.
 */
export async function outOfDate(input: {
  root: string;
  statePath: string;
  held: ProjectState | undefined;
  planned: readonly PlannedPackage[];
  elsewhere: boolean;
}): Promise<OutOfDate | undefined> {
  const shown = (path: string) =>
    relative(input.root, path).split(sep).join('/');
  const held = input.held?.packages ?? {};
  if (
    Object.keys(held).length !== input.planned.length ||
    input.planned.some(({ record }) => !sameRecord(held[record.alias], record))
  )
    return { path: shown(input.statePath), why: 'differs' };
  for (const { shims, link } of input.planned) {
    for (const planned of shims) {
      const stale = await shimOutOfDate(planned, input.elsewhere);
      if (stale === 'differs')
        return { path: shown(planned.shim.shim), why: 'differs' };
      if (stale !== undefined)
        return { path: shown(planned.shim.shim), why: 'opmx', ...stale };
    }
    if ((await fileText(link.path, false)) !== link.text)
      return { path: shown(link.path), why: 'differs' };
  }
  return undefined;
}

/** The link activation writes for a package: where, and what it holds. */
export function plannedLink(
  links: string,
  record: Pick<
    InstalledPackageRecord,
    'alias' | 'purl' | 'storePath' | 'digest'
  >,
): { path: string; text: string } {
  return {
    path: resolveContained(links, record.alias),
    text: `${JSON.stringify(
      {
        alias: record.alias,
        purl: record.purl,
        storePath: record.storePath,
        digest: record.digest,
      },
      null,
      2,
    )}\n`,
  };
}

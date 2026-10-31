import { lstat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import type { PlannedBinShim } from './bins.js';
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

/** Whether `path` is a file that holds exactly `text`, read without following a link. */
async function holds(
  path: string,
  text: string,
  executable: boolean,
): Promise<boolean> {
  const info = await lstat(path).catch(() => undefined);
  if (info?.isFile() !== true) return false;
  if (executable && process.platform !== 'win32' && (info.mode & 0o100) === 0)
    return false;
  return (await readStableFile(path).catch(() => undefined)) === text;
}

/**
 * The first thing in the project that is not what activating `planned` would
 * write there, as a path relative to `root` (`/`-separated); undefined when
 * the project holds all of it, and activation then writes nothing.
 */
export async function outOfDate(input: {
  root: string;
  statePath: string;
  held: ProjectState | undefined;
  planned: readonly PlannedPackage[];
}): Promise<string | undefined> {
  const shown = (path: string) =>
    relative(input.root, path).split(sep).join('/');
  const held = input.held?.packages ?? {};
  if (
    Object.keys(held).length !== input.planned.length ||
    input.planned.some(({ record }) => !sameRecord(held[record.alias], record))
  )
    return shown(input.statePath);
  for (const { shims, link } of input.planned) {
    for (const { shim, script } of shims)
      if (!(await holds(shim.shim, script, true))) return shown(shim.shim);
    if (!(await holds(link.path, link.text, false))) return shown(link.path);
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

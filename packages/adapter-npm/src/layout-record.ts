/**
 * What a layout wrote, as `node_modules/.opm-layout.json` records it, and the
 * removal of what an earlier layout wrote and this one does not.
 *
 * The record is the whole of what opm may take away: a package, a bin or a
 * workspace-member link that is not in it is somebody else's and is left alone.
 * It is read as untrusted input, since a person may have edited it.
 */

import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  memberLinkProblem,
  removeTree,
  writeFileAtomic,
} from '@openpacker/project-io';
import type { LayoutLink } from './layout-links.js';
import { unsafeNameProblem } from './layout-plan.js';

const BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._~+-]*$/u;

/** What opm wrote, so a later layout removes those and nothing else. */
export const LAYOUT_RECORD = '.opm-layout.json';

export interface LayoutRecord {
  layoutVersion: 1;
  /** Package names at the top of node_modules. */
  packages: string[];
  /** File names under node_modules/.bin. */
  bins: string[];
  /**
   * The workspace-member links written, by place and text. Absent when there
   * were none, so a layout with no links is recorded exactly as it always was.
   */
  links?: LayoutLink[];
}

export async function readRecord(root: string): Promise<LayoutRecord> {
  const empty: LayoutRecord = { layoutVersion: 1, packages: [], bins: [] };
  try {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const parsed = JSON.parse(
      await readFile(join(root, LAYOUT_RECORD), 'utf8'),
    ) as Partial<LayoutRecord>;
    if (parsed.layoutVersion !== 1) return empty;
    const strings = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
    return {
      layoutVersion: 1,
      packages: strings(parsed.packages),
      bins: strings(parsed.bins),
      links: recordedLinks(parsed.links),
    };
  } catch {
    return empty;
  }
}

/**
 * The links a record lists, each checked against the member-link rules: a
 * hand-edited record must not turn into a path, or into a link that could not
 * have been written.
 */
function recordedLinks(value: unknown): LayoutLink[] {
  if (!Array.isArray(value)) return [];
  const links: LayoutLink[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const { path, target } = item as { path?: unknown; target?: unknown };
    if (typeof path !== 'string' || typeof target !== 'string') continue;
    if (memberLinkProblem(path, target) === undefined)
      links.push({ path, target });
  }
  return links;
}

/**
 * Remove what an earlier layout wrote and this one does not.
 *
 * Only names the record lists, and only if they still look like what the
 * record can contain: a hand-edited record must not turn into a path.
 */
export async function removeStale(
  root: string,
  previous: LayoutRecord,
  packages: ReadonlySet<string>,
  bins: ReadonlySet<string>,
): Promise<void> {
  for (const name of previous.packages) {
    if (packages.has(name) || unsafeNameProblem(name) !== undefined) continue;
    await removeIfPresent(join(root, ...name.split('/')));
    if (name.startsWith('@'))
      await removeIfEmpty(join(root, name.split('/')[0]!));
  }
  for (const name of previous.bins) {
    if (bins.has(name) || !BIN_NAME.test(name)) continue;
    await removeIfPresent(join(root, '.bin', name));
    await removeIfPresent(join(root, '.bin', `${name}.cmd`));
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch {
    return;
  }
  await removeTree(path);
}

async function removeIfEmpty(directory: string): Promise<void> {
  try {
    if ((await readdir(directory)).length === 0) await removeTree(directory);
  } catch {
    // already gone
  }
}

/**
 * Write the record of this layout: the packages and bins it wrote and the
 * member links it is about to make. Nothing is written when there is nothing to
 * say now and nothing was said before, so an empty project stays without one.
 *
 * It is written before the links are made, not after. A link made and then
 * followed by a failure (a name that holds a directory, a crash) is already in
 * it, so the next layout removes it, and a recorded link that was never made is
 * nothing to remove. Written after, the failure left the earlier links of the
 * same layout unrecorded, and nothing would ever take them away.
 */
export async function writeRecord(
  root: string,
  previous: LayoutRecord,
  now: {
    packages: readonly string[];
    bins: readonly string[];
    links: readonly LayoutLink[];
  },
): Promise<void> {
  if (
    now.packages.length === 0 &&
    previous.packages.length === 0 &&
    now.links.length === 0 &&
    (previous.links?.length ?? 0) === 0
  )
    return;
  await writeFileAtomic(
    join(root, LAYOUT_RECORD),
    `${JSON.stringify(
      {
        layoutVersion: 1,
        packages: [...now.packages].sort(),
        bins: [...now.bins].sort(),
        ...(now.links.length > 0 && {
          links: now.links.map(({ path, target }) => ({ path, target })),
        }),
      } satisfies LayoutRecord,
      undefined,
      2,
    )}\n`,
  );
}

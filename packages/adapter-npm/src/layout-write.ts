/**
 * Write `node_modules/` from the opm store.
 *
 * The plan (`layout-plan.ts`) says where each package goes; this puts it
 * there as hard links to the store's files — the bytes of a package are on
 * disk once, however many projects install it — and writes the executables as
 * script shims. Nothing here runs a package script.
 */

import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeLockEntry } from '@openpacker/adapter-core';
import {
  materialiseTree,
  memberLinkProblem,
  removeTree,
  writeFileAtomic,
} from '@openpacker/project-io';
import {
  interpreterFor,
  readPackageBins,
  renderCmdShim,
  renderPosixShim,
  type PackageBin,
} from './layout-bins.js';
import type { LayoutLink } from './layout-links.js';
import { placePath } from './layout-links.js';
import {
  assertNoUndeclaredSymlinks,
  writeMemberLinks,
} from './layout-write-links.js';
import { chainOfLockPath } from './lock-tree.js';
import {
  planLayout,
  planLayoutFromPaths,
  toLayoutEntries,
  unsafeNameProblem,
  type LayoutEntry,
  type LayoutPlan,
  type Placement,
} from './layout-plan.js';

/** What opm wrote, so a later layout removes those and nothing else. */
export const LAYOUT_RECORD = '.opm-layout.json';

interface LayoutRecord {
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

export interface LayoutOutcome {
  root: string;
  packages: number;
  nested: number;
  linked: number;
  copied: boolean;
  bins: number;
  /** The workspace-member links of the layout, and what writing it did to them. */
  memberLinks: {
    declared: number;
    created: number;
    unchanged: number;
    removed: number;
  };
  skipped: { path: string; reason: string }[];
}

export interface LayoutWriteOptions {
  /**
   * The workspace-member links to leave in `node_modules`. Checked against the
   * packages here (`checkLayoutLinks`), whatever the caller already checked.
   */
  links?: readonly LayoutLink[];
}

const BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._~+-]*$/u;

/** Packages written at the same time within one depth of the tree. */
const PARALLEL_PACKAGES = 4;

export async function writeNodeModules(
  projectRoot: string,
  entries: readonly NativeLockEntry[],
  options: LayoutWriteOptions = {},
): Promise<LayoutOutcome> {
  const root = join(projectRoot, 'node_modules');
  const skipped: { path: string; reason: string }[] = [];
  const storable = entries.filter((entry) => {
    if (entry.storePath) return true;
    skipped.push({
      path: join(root, ...entry.name.split('/')),
      reason: 'the package is not materialised in the opm store',
    });
    return false;
  });
  const plan = planFor(storable, options.links ?? []);
  for (const refusal of plan.skipped)
    skipped.push({
      path: join(root, ...refusal.entry.name.split('/')),
      reason: refusal.reason,
    });

  const outcome: LayoutOutcome = {
    root,
    packages: plan.placements.length,
    nested: plan.placements.filter((place) => place.chain.length > 1).length,
    linked: 0,
    copied: false,
    bins: 0,
    memberLinks: {
      declared: plan.links.length,
      created: 0,
      unchanged: 0,
      removed: 0,
    },
    skipped,
  };

  // A package replaces its own directory, so the packages of one depth are
  // independent and go a few at a time; a nested package waits for the level
  // above it, because writing its parent replaces everything under it.
  const depths = [
    ...new Set(plan.placements.map((place) => place.chain.length)),
  ];
  for (const depth of depths.sort((left, right) => left - right)) {
    const level = plan.placements.filter(
      (place) => place.chain.length === depth,
    );
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(PARALLEL_PACKAGES, level.length) },
        async () => {
          for (;;) {
            const placement = level[next++];
            if (placement === undefined) return;
            // SAFETY: only entries with a store path were planned.
            const stored = placement.entry.source.storePath!;
            const result = await materialiseTree(
              await treeToInstall(stored),
              directoryOf(root, placement.chain),
              root,
              { link: true },
            );
            outcome.linked += result.linked;
            outcome.copied ||= result.copied;
          }
        },
      ),
    );
  }

  const shims = await writeShims(root, plan.placements, skipped);
  outcome.bins = shims.total;

  const previous = await readRecord(root);
  const names = new Set(
    plan.placements
      .filter((place) => place.chain.length === 1)
      .map((place) => place.entry.name),
  );
  await removeStale(root, previous, names, new Set(shims.root));
  // Links last: a name that was a package is gone by now, and a package that
  // takes the place of an old link has already replaced it.
  const links = await writeMemberLinks(
    projectRoot,
    plan.links,
    previous.links ?? [],
    new Set(plan.placements.map((place) => placePath(place.chain))),
  );
  const { kept, ...counts } = links;
  outcome.memberLinks = { declared: plan.links.length, ...counts };
  skipped.push(...kept);
  await assertNoUndeclaredSymlinks(projectRoot, plan.placements, plan.links);
  if (
    plan.placements.length > 0 ||
    previous.packages.length > 0 ||
    plan.links.length > 0 ||
    (previous.links?.length ?? 0) > 0
  )
    await writeFileAtomic(
      join(root, LAYOUT_RECORD),
      `${JSON.stringify(
        {
          layoutVersion: 1,
          packages: [...names].sort(),
          bins: [...shims.root].sort(),
          ...(plan.links.length > 0 && {
            links: plan.links.map(({ path, target }) => ({ path, target })),
          }),
        } satisfies LayoutRecord,
        undefined,
        2,
      )}\n`,
    );
  return outcome;
}

/**
 * Follow the lock's own placements when every entry carries one, else plan.
 *
 * A frozen install names the path of each package (`layoutPath`) and the
 * layout is exactly that. An opm lock names none, and the placement is derived
 * from the edges it records. Half of each would be a layout nobody chose.
 */
function planFor(
  entries: readonly NativeLockEntry[],
  links: readonly LayoutLink[],
): LayoutPlan {
  const withPath = entries.filter((entry) => entry.layoutPath !== undefined);
  if (withPath.length === 0)
    return planLayout(toLayoutEntries(entries), { links });
  if (withPath.length !== entries.length)
    throw new Error(
      'Either every package of a layout names its place in the lock, or none does',
    );
  const seen = new Set<string>();
  const placed = entries.map((source) => {
    const path = source.layoutPath!;
    const chain = chainOfLockPath(path);
    if (chain === undefined)
      throw new Error(`${path} is not a place under node_modules`);
    if (seen.has(path)) throw new Error(`${path} is claimed twice`);
    seen.add(path);
    const entry: LayoutEntry = {
      id: path,
      name: chain.at(-1)!,
      version: source.version,
      digest: source.digest,
      direct: !source.transitive,
      dependencies: [],
      source,
    };
    return { entry, chain };
  });
  return planLayoutFromPaths(placed, { links });
}

/**
 * npm tarballs wrap their contents in one directory, `package/` by
 * convention; node_modules wants what is inside it. npm strips the first path
 * component whatever it is called, so a tarball that wraps in another name
 * (older packages do) is read the same way here.
 */
async function treeToInstall(storePath: string): Promise<string> {
  try {
    const children = await readdir(storePath, { withFileTypes: true });
    const only = children.length === 1 ? children[0] : undefined;
    if (only?.isDirectory() === true) return join(storePath, only.name);
    return storePath;
  } catch {
    return storePath;
  }
}

/** `['b', 'c']` → `<root>/b/node_modules/c`. */
function directoryOf(root: string, chain: readonly string[]): string {
  return join(
    root,
    ...chain.flatMap((name, index) => [
      ...(index === 0 ? [] : ['node_modules']),
      ...name.split('/'),
    ]),
  );
}

/** The `node_modules` directory a package at `chain` sits directly in. */
function containerOf(root: string, chain: readonly string[]): string {
  return chain.length === 1
    ? root
    : join(directoryOf(root, chain.slice(0, -1)), 'node_modules');
}

async function writeShims(
  root: string,
  placements: readonly Placement[],
  skipped: { path: string; reason: string }[],
): Promise<{ total: number; root: string[] }> {
  const byContainer = new Map<
    string,
    Map<string, { placement: Placement; bin: PackageBin }>
  >();
  for (const placement of placements) {
    const directory = directoryOf(root, placement.chain);
    const { bins, refused } = await readPackageBins(
      directory,
      placement.entry.name,
    );
    for (const refusal of refused)
      skipped.push({
        path: join(directory, 'package.json'),
        reason: `${placement.entry.name}: bin ${JSON.stringify(refusal.name)} ${refusal.reason}`,
      });
    const container = containerOf(root, placement.chain);
    const taken = byContainer.get(container) ?? new Map();
    byContainer.set(container, taken);
    for (const bin of bins) {
      const rival = taken.get(bin.name);
      const candidate = { placement, bin };
      if (rival === undefined) {
        taken.set(bin.name, candidate);
        continue;
      }
      const [keep, lose] = outranks(placement, rival.placement)
        ? [candidate, rival]
        : [rival, candidate];
      taken.set(bin.name, keep);
      skipped.push({
        path: join(container, '.bin', bin.name),
        reason: `${lose.placement.entry.name} also declares ${bin.name}; ${keep.placement.entry.name} keeps it`,
      });
    }
  }

  let total = 0;
  const rootNames: string[] = [];
  for (const [container, taken] of byContainer) {
    for (const [name, { placement, bin }] of taken) {
      const directory = directoryOf(root, placement.chain);
      const interpreter = await interpreterFor(
        join(directory, ...bin.target.split('/')),
      );
      const relative = `../${placement.entry.name}/${bin.target}`;
      await writeFileAtomic(
        join(container, '.bin', name),
        renderPosixShim(relative, interpreter),
        { mode: 0o755 },
      );
      if (process.platform === 'win32')
        await writeFileAtomic(
          join(container, '.bin', `${name}.cmd`),
          renderCmdShim(relative, interpreter),
        );
      total += 1;
      if (container === root) rootNames.push(name);
    }
  }
  return { total, root: rootNames };
}

/** A direct requirement keeps a contested name; otherwise the first by name. */
function outranks(candidate: Placement, rival: Placement): boolean {
  if (candidate.entry.direct !== rival.entry.direct)
    return candidate.entry.direct;
  return candidate.entry.name < rival.entry.name;
}

async function readRecord(root: string): Promise<LayoutRecord> {
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
async function removeStale(
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

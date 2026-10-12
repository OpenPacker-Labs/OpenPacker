/**
 * Write `node_modules/` from the opm store.
 *
 * The plan (`layout-plan.ts`) says where each package goes; this puts it
 * there as hard links to the store's files — the bytes of a package are on
 * disk once, however many projects install it — and writes the executables as
 * script shims. Nothing here runs a package script.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  NativeLayoutMember,
  NativeLockEntry,
} from '@openpacker/adapter-core';
import { materialiseTree } from '@openpacker/project-io';
import { directoryOf, modulesOf } from './layout-dirs.js';
import type { LayoutLink } from './layout-links.js';
import { placePath } from './layout-links.js';
import {
  LAYOUT_RECORD,
  readRecord,
  removeStale,
  writeRecord,
} from './layout-record.js';
import { writeShims } from './layout-shims.js';
import {
  assertNoUndeclaredSymlinks,
  placeWantedLinks,
  removeStaleLinks,
} from './layout-write-links.js';
import { placeOfLockPath } from './lock-entry.js';
import {
  planLayout,
  planLayoutFromPaths,
  toLayoutEntries,
  type LayoutEntry,
  type LayoutPlan,
  type PlacedEntry,
} from './layout-plan.js';

/** What opm wrote, so a later layout removes those and nothing else. */
export { LAYOUT_RECORD };

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
  /** Workspace members whose own `node_modules` the layout wrote packages into. */
  memberModules: number;
  skipped: { path: string; reason: string }[];
}

export interface LayoutWriteOptions {
  /**
   * The workspace-member links to leave in `node_modules`. Checked against the
   * packages here (`checkLayoutLinks`), whatever the caller already checked.
   */
  links?: readonly LayoutLink[];
  /**
   * The workspace members this layout installs. A package whose place lies
   * under one of their directories is written in that member's own
   * `node_modules`; under any other directory it is refused. Their executables
   * are shimmed in the project's `.bin`.
   */
  members?: readonly NativeLayoutMember[];
}

/** Packages written at the same time within one depth of the tree. */
const PARALLEL_PACKAGES = 4;

export async function writeNodeModules(
  projectRoot: string,
  entries: readonly NativeLockEntry[],
  options: LayoutWriteOptions = {},
): Promise<LayoutOutcome> {
  const root = modulesOf(projectRoot, '');
  const members = options.members ?? [];
  const skipped: { path: string; reason: string }[] = [];
  const storable = entries.filter((entry) => {
    if (entry.storePath) return true;
    skipped.push({
      path: join(root, ...(entry.installName ?? entry.name).split('/')),
      reason: 'the package is not materialised in the opm store',
    });
    return false;
  });
  const plan = planFor(
    storable,
    options.links ?? [],
    members.map((member) => member.dir),
  );
  for (const refusal of plan.skipped)
    skipped.push({
      path: join(
        root,
        ...(refusal.entry.installName ?? refusal.entry.name).split('/'),
      ),
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
    memberModules: new Set(
      plan.placements.flatMap((place) =>
        place.base === undefined ? [] : [place.base],
      ),
    ).size,
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
            const base = placement.base ?? '';
            // The anchor a write may not leave: the project's own
            // `node_modules`, or, inside a member, the project, walked down
            // one directory at a time without following a link.
            const anchor = base === '' ? root : projectRoot;
            const result = await materialiseTree(
              await treeToInstall(stored),
              directoryOf(modulesOf(projectRoot, base), placement.chain),
              anchor,
              { link: true },
            );
            outcome.linked += result.linked;
            outcome.copied ||= result.copied;
          }
        },
      ),
    );
  }

  const shims = await writeShims(
    projectRoot,
    plan.placements,
    members,
    skipped,
  );
  outcome.bins = shims.total;

  const previous = await readRecord(root);
  // The directory a package sits in is its install name, which for an aliased
  // package is not the name the package calls itself.
  const namesIn = (base: string): Set<string> =>
    new Set(
      plan.placements
        .filter(
          (place) => (place.base ?? '') === base && place.chain.length === 1,
        )
        .map((place) => place.chain[0]!),
    );
  const names = namesIn('');
  const rootBins = shims.names.get(root) ?? [];
  await removeStale(root, previous, names, new Set(rootBins));
  // A member's own `node_modules` is a layout of its own, recorded where it is.
  for (const base of new Set(
    plan.placements.map((place) => place.base ?? ''),
  )) {
    if (base === '') continue;
    const modules = modulesOf(projectRoot, base);
    const earlier = await readRecord(modules);
    const here = namesIn(base);
    const binNames = shims.names.get(modules) ?? [];
    await removeStale(modules, earlier, here, new Set(binNames));
    await writeRecord(modules, earlier, {
      packages: [...here],
      bins: binNames,
      links: [],
    });
  }
  // Links last: a name that was a package is gone by now, and a package that
  // takes the place of an old link has already replaced it. They go in two
  // halves with the record between them, so that a link made is a link recorded
  // even if a later one is refused or the process stops.
  const stale = await removeStaleLinks(
    projectRoot,
    plan.links,
    previous.links ?? [],
    new Set(plan.placements.map((place) => placePath(place.chain, place.base))),
  );
  await writeRecord(root, previous, {
    packages: [...names],
    bins: rootBins,
    links: plan.links,
  });
  const made = await placeWantedLinks(projectRoot, plan.links, stale.emptied);
  outcome.memberLinks = {
    declared: plan.links.length,
    created: made.created,
    unchanged: made.unchanged,
    removed: stale.removed,
  };
  skipped.push(...stale.kept);
  await assertNoUndeclaredSymlinks(projectRoot, plan.placements, plan.links);
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
  members: readonly string[],
): LayoutPlan {
  const withPath = entries.filter((entry) => entry.layoutPath !== undefined);
  if (withPath.length === 0)
    return planLayout(toLayoutEntries(entries), { links });
  if (withPath.length !== entries.length)
    throw new Error(
      'Either every package of a layout names its place in the lock, or none does',
    );
  const seen = new Set<string>();
  const placed = entries.map((source): PlacedEntry => {
    const path = source.layoutPath!;
    const where = placeOfLockPath(path);
    if (where === undefined)
      throw new Error(`${path} is not a place under node_modules`);
    if (seen.has(path)) throw new Error(`${path} is claimed twice`);
    seen.add(path);
    // The directory is where the lock puts the package, whatever the package
    // calls itself: an aliased dependency is `string-width` at
    // `node_modules/string-width-cjs`.
    const installed = where.chain.at(-1)!;
    const entry: LayoutEntry = {
      id: path,
      name: source.name,
      ...(installed !== source.name && { installName: installed }),
      version: source.version,
      digest: source.digest,
      direct: !source.transitive,
      dependencies: [],
      source,
    };
    return { entry, ...where };
  });
  return planLayoutFromPaths(placed, { links, members });
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

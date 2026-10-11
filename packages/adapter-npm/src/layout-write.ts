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
import {
  planLayout,
  toLayoutEntries,
  unsafeNameProblem,
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
}

export interface LayoutOutcome {
  root: string;
  packages: number;
  nested: number;
  linked: number;
  copied: boolean;
  bins: number;
  skipped: { path: string; reason: string }[];
}

const BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._~+-]*$/u;

/** Packages written at the same time within one depth of the tree. */
const PARALLEL_PACKAGES = 4;

export async function writeNodeModules(
  projectRoot: string,
  entries: readonly NativeLockEntry[],
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
  const plan = planLayout(toLayoutEntries(storable));
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
  if (plan.placements.length > 0 || previous.packages.length > 0)
    await writeFileAtomic(
      join(root, LAYOUT_RECORD),
      `${JSON.stringify(
        {
          layoutVersion: 1,
          packages: [...names].sort(),
          bins: [...shims.root].sort(),
        } satisfies LayoutRecord,
        undefined,
        2,
      )}\n`,
    );
  return outcome;
}

/** npm tarballs wrap their contents in `package/`; node_modules wants inside. */
async function treeToInstall(storePath: string): Promise<string> {
  try {
    await readdir(join(storePath, 'package'));
    return join(storePath, 'package');
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
    };
  } catch {
    return empty;
  }
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

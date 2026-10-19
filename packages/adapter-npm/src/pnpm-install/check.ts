/**
 * Hold the lock to the project's files (ADR 0055 §15, §18), in the order a
 * frozen install reports it: the importers against the members on disk, each
 * importer's dependencies against its `package.json`, then `overrides`,
 * `catalogs` and the settings pnpm records, and apart from those, what opm
 * does not do (a declared patch, an override it cannot read as pnpm does).
 * Everything is collected, so one error names all of it.
 */

import type {
  DetectedProject,
  WorkspaceMember,
} from '@openpacker/adapter-core';
import { ProviderError } from '@openpacker/adapter-core';
import { MAXIMUM_MANIFEST_BYTES, readBounded } from '../frozen-read.js';
import { readManifest } from '../frozen-lock.js';
import { readPnpmProjectConfig, type PnpmProjectConfig } from './config.js';
import {
  catalogProblems,
  importerProblems,
  overrideProblems,
  type ManifestLists,
} from './fresh.js';
import type { PnpmModel } from './model.js';
import { applyOverrides } from './overrides.js';
import { quote } from './quote.js';

const show = (dir: string): string => (dir === '' ? '(root)' : quote(dir));

/**
 * The importers of the lock the project still has. pnpm reads the projects on
 * disk and not the lock's list, so an importer whose member is gone is left
 * alone (and kept in the lock); the project itself is always there.
 */
export function presentImporters(
  model: PnpmModel,
  disk: readonly WorkspaceMember[],
): ReadonlySet<string> {
  const onDisk = new Set(disk.map((member) => member.dir));
  return new Set(
    [...model.tops.values()]
      .filter((top) => top.dir === '' || onDisk.has(top.dir))
      .map((top) => top.id),
  );
}

/**
 * The members on disk the lock does not list, as sentences. pnpm takes a member
 * the lock does not list when it has no dependencies (`allProjectsAreUpToDate`
 * asks no more of one), so only one with dependencies is named.
 */
export function memberProblems(
  model: PnpmModel,
  disk: readonly WorkspaceMember[],
): string[] {
  const inLock = new Set([...model.tops.values()].map((top) => top.dir));
  const unlisted = disk
    .filter(
      (member) =>
        !inLock.has(member.dir) &&
        (member.manifest.dependencies.size > 0 ||
          member.manifest.devDependencies.size > 0 ||
          member.manifest.optionalDependencies.size > 0),
    )
    .map((member) => member.dir)
    .sort();
  return unlisted.length === 0
    ? []
    : [
        `the project has ${unlisted.map(show).join(', ')}, which the lock does not list and which ${unlisted.length === 1 ? 'has' : 'have'} dependencies`,
      ];
}

/** What of the project's own files a frozen install reads before it looks at the lock. */
export interface RootProject {
  readonly lists: ManifestLists;
  readonly config: PnpmProjectConfig;
}

const maps = (record: Readonly<Record<string, string>>) =>
  new Map(Object.entries(record));

/** The root `package.json`'s dependencies and the project's pnpm settings. */
export async function readRootProject(
  project: DetectedProject,
): Promise<RootProject> {
  const root = readManifest(
    await readBounded(project.manifestPath, MAXIMUM_MANIFEST_BYTES),
    project.manifestPath,
  );
  const lists: ManifestLists = {
    dependencies: maps(root.dependencies),
    devDependencies: maps(root.devDependencies),
    optionalDependencies: maps(root.optionalDependencies),
    peerDependencies: maps(root.peerDependencies),
  };
  const config = await readPnpmProjectConfig(
    project.root,
    project.manifestPath,
    new Map([
      ...lists.devDependencies,
      ...lists.dependencies,
      ...lists.optionalDependencies,
    ]),
  );
  return { lists, config };
}

/** How the lock differs from the project's files. */
export interface Freshness {
  /**
   * Differences pnpm finds too, each one the review of #179 saw real pnpm
   * refuse: specifiers, lists, overrides, catalogs, `ignoredOptionalDependencies`
   * and `publishConfig.directory`.
   */
  readonly stale: readonly string[];
  /** What opm does not install, by its own rule: a patch the project declares. */
  readonly own: readonly string[];
}

/** How the lock differs from the files of the importers the project has. */
export function freshnessProblems(input: {
  root: RootProject;
  model: PnpmModel;
  present: ReadonlySet<string>;
  disk: readonly WorkspaceMember[];
}): Freshness {
  const { root, model, present, disk } = input;
  const { lists: rootLists, config } = root;
  const byDir = new Map(disk.map((member) => [member.dir, member]));
  const overridden = (dir: string): ManifestLists => {
    const member = byDir.get(dir);
    // A project with no workspace has no members on disk: it is its own root.
    const own = dir === '' ? config.project : {};
    const name = member?.name ?? own.name;
    const version = member?.manifest.version ?? own.version;
    return applyOverrides(member?.manifest ?? rootLists, config.overrides, {
      ...(name !== undefined && { name }),
      ...(version !== undefined && { version }),
      dir,
    });
  };
  const { lock } = model;
  const auto = lock.settings.autoInstallPeers !== false;
  const stale = [
    ...[...model.tops.values()]
      .filter((top) => present.has(top.id))
      .flatMap((top) =>
        importerProblems(
          top.id,
          overridden(top.dir),
          lock.importers.find((importer) => importer.id === top.id)!,
          auto,
        ),
      ),
    ...[...model.tops.values()]
      .filter((top) => present.has(top.id))
      .flatMap((top) => {
        const directory =
          byDir.get(top.dir)?.manifest.publishDirectory ??
          (top.dir === '' ? config.project.publishDirectory : undefined);
        return directory === undefined
          ? []
          : [
              `${top.id === '.' ? 'the project' : quote(top.id)} declares publishConfig.directory ${quote(directory)} and pnpm-lock.yaml records no publishDirectory for it`,
            ];
      }),
    ...overrideProblems(lock, config.overrides),
    ...ignoredProblems(lock.ignoredOptionalDependencies, config),
    ...catalogProblems(lock, config.catalogs),
  ];
  const own = config.patches.map(
    (key) =>
      `the project declares a patch for ${quote(key)}, which opm does not apply`,
  );
  return { stale, own };
}

/** pnpm compares the two lists sorted; the lock's own list is refused before this. */
function ignoredProblems(
  inLock: readonly string[],
  config: PnpmProjectConfig,
): string[] {
  const show = (names: readonly string[]) =>
    `[${[...names].sort().map(quote).join(',')}]`;
  return show(inLock) === show(config.ignoredOptionalDependencies)
    ? []
    : [
        `ignoredOptionalDependencies is ${show(config.ignoredOptionalDependencies)} in the project and ${show(inLock)} in pnpm-lock.yaml`,
      ];
}

/**
 * Throw the error a stale lock is, naming up to twenty differences. Every one
 * is a check `pnpm install --frozen-lockfile` makes as well.
 */
export function refuseStale(problems: readonly string[]): never {
  const shown = problems.slice(0, 20).join('; ');
  const more = problems.length > 20 ? `; and ${problems.length - 20} more` : '';
  throw new ProviderError(
    'INVALID_LOCKFILE',
    `pnpm-lock.yaml is not up to date with the project (pnpm install --frozen-lockfile would refuse too): ${shown}${more}`,
  );
}

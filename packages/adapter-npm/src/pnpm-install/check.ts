/**
 * Hold the lock to the project's files (ADR 0055 §15, §18), in the order a
 * frozen install reports it: the importers against the members on disk, each
 * importer's dependencies against its `package.json`, then `overrides`,
 * `catalogs` and the patches the project declares, then the names links are
 * made under. Everything is collected, so one error names all of it.
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
  linkNameProblems,
  overrideProblems,
  type ManifestLists,
} from './fresh.js';
import type { PnpmModel } from './model.js';
import { applyOverrides } from './overrides.js';

const show = (dir: string): string => (dir === '' ? '(root)' : dir);

/** How the members the lock lists differ from the ones on disk, as sentences. */
export function memberProblems(
  model: PnpmModel,
  disk: readonly WorkspaceMember[],
): string[] {
  const inLock = new Set([...model.tops.values()].map((top) => top.dir));
  // A project that declares no workspace is its root alone.
  const onDisk = new Set(
    disk.length === 0 ? [''] : disk.map((member) => member.dir),
  );
  const lines: string[] = [];
  const unlisted = [...onDisk].filter((dir) => !inLock.has(dir)).sort();
  const missing = [...inLock].filter((dir) => !onDisk.has(dir)).sort();
  if (unlisted.length > 0)
    lines.push(
      `the project has ${unlisted.map(show).join(', ')}, which the lock does not list`,
    );
  if (missing.length > 0)
    lines.push(
      `the lock lists ${missing.map(show).join(', ')}, which the project does not have`,
    );
  return lines;
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

/** How the lock differs from the project's files, as sentences; empty when it is the project's. */
export function freshnessProblems(input: {
  root: RootProject;
  model: PnpmModel;
  tops: ReadonlySet<string>;
  disk: readonly WorkspaceMember[];
}): string[] {
  const { root, model, tops, disk } = input;
  const { lists: rootLists, config } = root;
  const byDir = new Map(disk.map((member) => [member.dir, member]));
  const overridden = (dir: string): ManifestLists => {
    const member = byDir.get(dir);
    return applyOverrides(member?.manifest ?? rootLists, config.overrides, {
      ...(member?.name !== undefined && { name: member.name }),
      ...(member?.manifest.version !== undefined && {
        version: member.manifest.version,
      }),
    });
  };
  const { lock } = model;
  const auto = lock.settings.autoInstallPeers !== false;
  return [
    ...[...model.tops.values()].flatMap((top) =>
      importerProblems(
        top.id,
        overridden(top.dir),
        lock.importers.find((importer) => importer.id === top.id)!,
        auto,
      ),
    ),
    ...overrideProblems(lock, config.overrides),
    ...catalogProblems(lock, config.catalogs),
    ...config.patches.map(
      (key) =>
        `the project declares a patch for ${key}, which opm does not apply`,
    ),
    ...linkNameProblems(
      model,
      tops,
      new Map(
        [...model.tops.values()].map((top) => [
          top.dir,
          byDir.get(top.dir)?.name,
        ]),
      ),
    ),
  ];
}

/** Throw the error a stale lock is, naming up to twenty differences. */
export function refuseStale(problems: readonly string[]): never {
  const shown = problems.slice(0, 20).join('; ');
  const more = problems.length > 20 ? `; and ${problems.length - 20} more` : '';
  throw new ProviderError(
    'INVALID_LOCKFILE',
    `pnpm-lock.yaml is not up to date with the project (pnpm install --frozen-lockfile would refuse too): ${shown}${more}`,
  );
}

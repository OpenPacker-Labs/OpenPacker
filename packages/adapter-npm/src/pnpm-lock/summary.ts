/**
 * What a lock holds, in numbers and the short lists a policy or a person wants
 * first. Every list is sorted by code unit order whatever order the model's own
 * lists are in, so the same lock summarises to the same value.
 */

import { exoticSourcesOf } from './exotic.js';
import { compareKeys } from './order.js';
import type { PnpmLock, PnpmRef } from './types.js';

export interface PnpmPlatformRestriction {
  readonly key: string;
  readonly os?: readonly string[];
  readonly cpu?: readonly string[];
  readonly libc?: readonly string[];
}

export interface PnpmEdgeCounts {
  readonly importers: number;
  readonly snapshots: number;
}

export interface PnpmLockSummary {
  readonly lockfileVersion: '9.0';
  readonly importers: number;
  readonly packages: number;
  readonly snapshots: number;
  /** Direct dependencies listed by importers, and dependencies and optionalDependencies listed by snapshots. */
  readonly dependencyEdges: PnpmEdgeCounts;
  /** Edges to a `link:` directory. */
  readonly linkEdges: PnpmEdgeCounts;
  /** Edges that name another package than the dependency's own name (`npm:` aliases). */
  readonly aliasEdges: PnpmEdgeCounts;
  readonly exoticSources: {
    readonly tarball: number;
    readonly git: number;
    readonly directory: number;
    readonly runtime: number;
  };
  /** Names that `packages` holds in more than one version. */
  readonly multiVersionNames: readonly {
    readonly name: string;
    readonly versions: readonly string[];
  }[];
  /** Packages that restrict `os`, `cpu` or `libc`. */
  readonly platformRestricted: readonly PnpmPlatformRestriction[];
}

interface Counter {
  total: number;
  links: number;
  aliases: number;
}

function tally(counter: Counter, ref: PnpmRef): void {
  counter.total += 1;
  if (ref.kind === 'link') counter.links += 1;
  else if (ref.aliased) counter.aliases += 1;
}

function restriction(
  pkg: PnpmLock['packages'][number],
): PnpmPlatformRestriction | undefined {
  const os = pkg.os !== undefined && pkg.os.length > 0 ? pkg.os : undefined;
  const cpu = pkg.cpu !== undefined && pkg.cpu.length > 0 ? pkg.cpu : undefined;
  const libc =
    pkg.libc !== undefined && pkg.libc.length > 0 ? pkg.libc : undefined;
  if (os === undefined && cpu === undefined && libc === undefined)
    return undefined;
  return {
    key: pkg.key,
    ...(os !== undefined && { os }),
    ...(cpu !== undefined && { cpu }),
    ...(libc !== undefined && { libc }),
  };
}

export function summarizePnpmLock(lock: PnpmLock): PnpmLockSummary {
  const fromImporters: Counter = { total: 0, links: 0, aliases: 0 };
  for (const importer of lock.importers)
    for (const list of [
      importer.dependencies,
      importer.devDependencies,
      importer.optionalDependencies,
    ])
      for (const dependency of list) tally(fromImporters, dependency.ref);
  const fromSnapshots: Counter = { total: 0, links: 0, aliases: 0 };
  for (const snapshot of lock.snapshots)
    for (const list of [snapshot.dependencies, snapshot.optionalDependencies])
      for (const dependency of list) tally(fromSnapshots, dependency.ref);

  const exotic = { tarball: 0, git: 0, directory: 0, runtime: 0 };
  for (const source of exoticSourcesOf(lock)) exotic[source.kind] += 1;

  const versionsByName = new Map<string, string[]>();
  for (const pkg of lock.packages) {
    const versions = versionsByName.get(pkg.name);
    if (versions === undefined) versionsByName.set(pkg.name, [pkg.version]);
    else versions.push(pkg.version);
  }
  const multiVersionNames = [...versionsByName]
    .filter(([, versions]) => versions.length > 1)
    .map(([name, versions]) => ({ name, versions: versions.sort(compareKeys) }))
    .sort((a, b) => compareKeys(a.name, b.name));

  return {
    lockfileVersion: lock.lockfileVersion,
    importers: lock.importers.length,
    packages: lock.packages.length,
    snapshots: lock.snapshots.length,
    dependencyEdges: {
      importers: fromImporters.total,
      snapshots: fromSnapshots.total,
    },
    linkEdges: {
      importers: fromImporters.links,
      snapshots: fromSnapshots.links,
    },
    aliasEdges: {
      importers: fromImporters.aliases,
      snapshots: fromSnapshots.aliases,
    },
    exoticSources: exotic,
    multiVersionNames,
    platformRestricted: lock.packages
      .flatMap((pkg) => restriction(pkg) ?? [])
      .sort((a, b) => compareKeys(a.key, b.key)),
  };
}

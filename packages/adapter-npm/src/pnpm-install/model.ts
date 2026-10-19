/**
 * What a frozen install needs of a `pnpm-lock.yaml`, as the graph Node has to
 * resolve (ADR 0055 §4, §5).
 *
 * A snapshot is an **instance**: a package resolved against one set of peers.
 * Its edges are what it needs, each with the name it finds the dependency by
 * (an `npm:` alias is an edge whose name is not the target's), and a peer is
 * an ordinary edge, because pnpm has already written the resolved peers into
 * the snapshot. An importer is a **top**: its edges are its three dependency
 * lists, and a `link:` to another importer is a member link.
 *
 * Pure: no file is read and nothing is decided. Which of this a machine
 * installs (`select.ts`), where it goes (`place.ts`) and whether it may be
 * installed at all (`refuse.ts`) are asked of the model.
 */

import { PnpmLockError } from '../pnpm-lock/errors.js';
import { packageKeyOf } from '../pnpm-lock/dep-path.js';
import { joinInside } from '../pnpm-lock/validate.js';
import type {
  ImporterField,
  PnpmLock,
  PnpmPackage,
  PnpmRef,
  PnpmSnapshot,
} from '../pnpm-lock/types.js';

/** What an instance needs: the name it finds it by, and the snapshot it is. */
export interface PnpmEdge {
  readonly as: string;
  /** The key of the snapshot this is. */
  readonly to: string;
  /** From `optionalDependencies`: the instance works without it. */
  readonly optional: boolean;
}

/** A `link:` in a snapshot, which is relative to a package this install does not place. */
export interface PnpmSnapshotLink {
  readonly as: string;
  readonly target: string;
}

/** One snapshot: a package resolved against one set of peers. */
export interface PnpmInstance {
  /** `name@version(peer suffix)`: what other snapshots point at. */
  readonly key: string;
  /** `name@version`: the `packages` entry that holds the bytes and the claims. */
  readonly packageKey: string;
  /** The package's own name; an alias is the edge's, not the instance's. */
  readonly name: string;
  readonly version: string;
  readonly pkg: PnpmPackage;
  /** Reachable only through optional dependencies (pnpm's flag, global to the lock). */
  readonly optional: boolean;
  /** `dependencies` then `optionalDependencies`, each by name. */
  readonly edges: readonly PnpmEdge[];
  readonly links: readonly PnpmSnapshotLink[];
}

interface TopEdgeBase {
  /** The name it is installed under: the key in `package.json`. */
  readonly as: string;
  readonly list: ImporterField;
  /** As `package.json` wrote it. */
  readonly specifier: string;
}

export type PnpmTopEdge =
  | (TopEdgeBase & { readonly kind: 'dep'; readonly to: string })
  | (TopEdgeBase & {
      readonly kind: 'link';
      /** The text after `link:`, relative to the importer. */
      readonly target: string;
      /** The importer it lands on; absent when it lands on no importer. */
      readonly memberId?: string;
    });

/** One importer: the project (`.`) or a workspace member. */
export interface PnpmTop {
  /** The id the lock uses: `.`, or the directory relative to the project. */
  readonly id: string;
  /** The directory relative to the project, `''` for the project itself. */
  readonly dir: string;
  readonly edges: readonly PnpmTopEdge[];
}

export interface PnpmModel {
  readonly lock: PnpmLock;
  /** By snapshot key, in code unit order. */
  readonly instances: ReadonlyMap<string, PnpmInstance>;
  /** By importer id, in code unit order. */
  readonly tops: ReadonlyMap<string, PnpmTop>;
}

function instanceOf(
  snapshot: PnpmSnapshot,
  packages: ReadonlyMap<string, PnpmPackage>,
): PnpmInstance {
  const packageKey = packageKeyOf(snapshot.path);
  const pkg = packages.get(packageKey);
  if (pkg === undefined)
    throw new PnpmLockError(
      'inconsistent',
      `has no entry ${JSON.stringify(packageKey)} in packages`,
      `snapshots[${JSON.stringify(snapshot.key)}]`,
    );
  const edges: PnpmEdge[] = [];
  const links: PnpmSnapshotLink[] = [];
  for (const [list, optional] of [
    [snapshot.dependencies, false],
    [snapshot.optionalDependencies, true],
  ] as const)
    for (const dependency of list)
      if (dependency.ref.kind === 'link')
        links.push({ as: dependency.name, target: dependency.ref.target });
      else
        edges.push({
          as: dependency.name,
          to: dependency.ref.target.raw,
          optional,
        });
  return {
    key: snapshot.key,
    packageKey,
    name: snapshot.path.name,
    version: snapshot.path.version,
    pkg,
    optional: snapshot.optional,
    edges,
    links,
  };
}

function topEdge(
  id: string,
  as: string,
  list: ImporterField,
  specifier: string,
  ref: PnpmRef,
  importers: ReadonlySet<string>,
): PnpmTopEdge {
  if (ref.kind === 'dep')
    return { kind: 'dep', as, list, specifier, to: ref.target.raw };
  const landed = joinInside(id, ref.target);
  return {
    kind: 'link',
    as,
    list,
    specifier,
    target: ref.target,
    ...(landed !== undefined && importers.has(landed) && { memberId: landed }),
  };
}

/** Build the model of a lock that `readPnpmLock` accepted. */
export function buildPnpmModel(lock: PnpmLock): PnpmModel {
  const packages = new Map(lock.packages.map((pkg) => [pkg.key, pkg]));
  const instances = new Map<string, PnpmInstance>();
  for (const snapshot of lock.snapshots)
    instances.set(snapshot.key, instanceOf(snapshot, packages));
  const importers = new Set(lock.importers.map((importer) => importer.id));
  const tops = new Map<string, PnpmTop>();
  for (const importer of lock.importers) {
    const edges: PnpmTopEdge[] = [];
    for (const list of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
    ] as const)
      for (const dependency of importer[list])
        edges.push(
          topEdge(
            importer.id,
            dependency.name,
            list,
            dependency.specifier,
            dependency.ref,
            importers,
          ),
        );
    tops.set(importer.id, {
      id: importer.id,
      dir: importer.id === '.' ? '' : importer.id,
      edges,
    });
  }
  return { lock, instances, tops };
}

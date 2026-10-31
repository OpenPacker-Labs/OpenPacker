/**
 * Which instances a machine installs, and why it leaves the others out
 * (ADR 0055 §16 to §19).
 *
 * Start from the edges of the importers being installed, less what `--omit`
 * drops, and follow every `dependencies` and `optionalDependencies` edge.
 * Then the platform: an instance whose package restricts `os`, `cpu` or `libc`
 * to something none of the targets satisfies is left out when pnpm marked it
 * `optional` (reachable only through optional edges), together with whatever
 * only it brings in and whatever needs it outright (arborist's `optionalSet`,
 * which `frozen-graph.ts` computes on an npm lock); and refused by name when
 * it is not optional. Pure: nothing is read.
 */

import type {
  ArchivePlatform,
  FrozenLockPackage,
  FrozenLockRefusal,
  FrozenLockSkip,
  FrozenOmit,
  NativeTarget,
} from '@openpacker/adapter-core';
import type { PnpmPackage } from '../pnpm-lock/types.js';
import {
  describePlatform,
  npmPackageRuns,
  withArchivePlatform,
  type DeclaredPlatform,
} from '../platform.js';
import type { PnpmInstance, PnpmModel, PnpmTopEdge } from './model.js';
import { quote } from './quote.js';

export interface SelectInput {
  readonly model: PnpmModel;
  /** The importer ids being installed. */
  readonly tops: ReadonlySet<string>;
  readonly omit: ReadonlySet<FrozenOmit>;
  /** The machines to install for: a package that runs on any of them is installed. */
  readonly targets: readonly NativeTarget[];
  /** What archives declare, by integrity: a list the lock lacks is taken from here. */
  readonly archivePlatforms?: ReadonlyMap<string, ArchivePlatform>;
}

/** Counts the steps a selection takes, for the tests that hold it to linear time. */
export interface SelectMeter {
  visits: number;
}

export interface Selection {
  /** The instances installed, with the `scope` policy reads them by. */
  readonly included: ReadonlyMap<string, FrozenLockPackage['scope']>;
  /** Each installed importer's edges after `--omit` and the platform. */
  readonly topEdges: ReadonlyMap<string, readonly PnpmTopEdge[]>;
  readonly skipped: readonly FrozenLockSkip[];
  readonly refused: readonly FrozenLockRefusal[];
}

function describeTarget(target: NativeTarget): string {
  return quote(
    `${target.os}/${target.architecture}${target.libc === undefined ? '' : `/${target.libc}`}`,
  );
}

/** The integrity that pins a package's archive, when its resolution has one. */
export function integrityOfPackage(pkg: PnpmPackage): string | undefined {
  const resolution = pkg.resolution;
  return resolution.kind === 'integrity' || resolution.kind === 'tarball'
    ? resolution.integrity
    : undefined;
}

/** What a package is held to: its lock entry's lists, and its archive's where the lock has none. */
export function declaredOf(
  instance: PnpmInstance,
  archivePlatforms: ReadonlyMap<string, ArchivePlatform> | undefined,
): DeclaredPlatform {
  const integrity = integrityOfPackage(instance.pkg);
  return withArchivePlatform(
    instance.pkg,
    integrity === undefined ? undefined : archivePlatforms?.get(integrity),
  );
}

const labelOf = (instance: PnpmInstance): string =>
  quote(`${instance.name}@${instance.version}`);

/** Every instance reachable from `roots`, not entering `blocked`. */
function reach(
  model: PnpmModel,
  roots: Iterable<string>,
  followOptional: boolean,
  meter: SelectMeter,
  blocked: ReadonlySet<string> = new Set(),
): Set<string> {
  const seen = new Set<string>();
  const pending = [...roots].filter((key) => !blocked.has(key));
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    if (seen.has(key)) continue;
    seen.add(key);
    for (const edge of model.instances.get(key)?.edges ?? []) {
      meter.visits += 1;
      if (
        (followOptional || !edge.optional) &&
        !blocked.has(edge.to) &&
        !seen.has(edge.to)
      )
        pending.push(edge.to);
    }
  }
  return seen;
}

/** What a dropped instance takes with it, and what it cannot take. */
interface Dropped {
  /** The failed instances and every optional one that needs one of them outright. */
  readonly dropped: ReadonlySet<string>;
  /** For each instance dropped because of another, the one it needs. */
  readonly needs: ReadonlyMap<string, string>;
  /** Instances that are not optional and need a dropped one outright, with the first such edge. */
  readonly stuck: readonly { key: string; to: string }[];
}

/**
 * The closure of `failed` under "needs outright" (arborist's `optionalSet`),
 * within `among`: a worklist over the reverse edges, so each instance and each
 * edge is looked at a bounded number of times however long the chain is.
 */
function dropClosure(
  model: PnpmModel,
  among: ReadonlySet<string>,
  failed: ReadonlySet<string>,
  meter: SelectMeter,
): Dropped {
  const neededBy = new Map<string, string[]>();
  for (const key of among)
    for (const edge of model.instances.get(key)!.edges) {
      meter.visits += 1;
      if (edge.optional || !among.has(edge.to)) continue;
      const parents = neededBy.get(edge.to);
      if (parents === undefined) neededBy.set(edge.to, [key]);
      else parents.push(key);
    }
  const dropped = new Set(failed);
  const needs = new Map<string, string>();
  const pending = [...failed];
  for (let next = 0; next < pending.length; next += 1) {
    const child = pending[next]!;
    for (const parent of neededBy.get(child) ?? []) {
      meter.visits += 1;
      if (dropped.has(parent) || !model.instances.get(parent)!.optional)
        continue;
      dropped.add(parent);
      needs.set(parent, child);
      pending.push(parent);
    }
  }
  // An instance that is not optional and needs a dropped one is a lock whose
  // flags do not match its graph; it is named once, by its first such edge.
  const stuck: { key: string; to: string }[] = [];
  for (const key of among) {
    const instance = model.instances.get(key)!;
    if (instance.optional) continue;
    meter.visits += 1 + instance.edges.length;
    const edge = instance.edges.find(
      (candidate) => !candidate.optional && dropped.has(candidate.to),
    );
    if (edge !== undefined) stuck.push({ key, to: edge.to });
  }
  return { dropped, needs, stuck };
}

/** The instances a set of importer edges point at (a link points at none). */
function rootsOf(edges: Iterable<PnpmTopEdge>): string[] {
  const out: string[] = [];
  for (const edge of edges) if (edge.kind === 'dep') out.push(edge.to);
  return out;
}

export function selectInstances(
  input: SelectInput,
  meter: SelectMeter = { visits: 0 },
): Selection {
  const { model, tops, omit, targets } = input;
  const followOptional = !omit.has('optional');
  const skipped: FrozenLockSkip[] = [];
  const refused: FrozenLockRefusal[] = [];
  const skip = (
    key: string,
    kind: FrozenLockSkip['kind'],
    reason: string,
  ): void => {
    const instance = model.instances.get(key)!;
    skipped.push({
      path: key,
      name: instance.name,
      version: instance.version,
      kind,
      reason,
    });
  };

  const kept = (edge: PnpmTopEdge): boolean =>
    !(edge.list === 'devDependencies' && omit.has('dev')) &&
    !(edge.list === 'optionalDependencies' && omit.has('optional'));
  const edgesOf = (id: string): readonly PnpmTopEdge[] =>
    model.tops.get(id)?.edges ?? [];
  const everyEdge = [...tops].flatMap(edgesOf);
  const keptEdges = everyEdge.filter(kept);

  // What the selected importers reach with nothing left out, to say why the
  // rest is not installed.
  const wanted = reach(model, rootsOf(everyEdge), true, meter);
  const afterOmit = reach(model, rootsOf(keptEdges), followOptional, meter);

  // The platform, on what the omission left.
  const failed = new Set<string>();
  // An archive's own lists hold an optional package only: one the lock needs
  // outright is installed as the lock says.
  const declared = (instance: PnpmInstance): DeclaredPlatform =>
    declaredOf(
      instance,
      instance.optional ? input.archivePlatforms : undefined,
    );
  for (const key of afterOmit) {
    meter.visits += 1;
    const instance = model.instances.get(key)!;
    if (targets.some((target) => npmPackageRuns(declared(instance), target)))
      continue;
    if (instance.optional) failed.add(key);
    else
      refused.push({
        path: key,
        reason: `${labelOf(instance)} is for ${describePlatform(declared(instance), quote)}, not ${targets.map(describeTarget).join(' or ')}, and is not optional`,
      });
  }
  // What needs a dropped instance outright cannot work either (arborist's
  // optionalSet); an instance that is not optional doing so is a lock whose
  // flags do not match its graph.
  const { dropped, needs, stuck } = dropClosure(
    model,
    afterOmit,
    failed,
    meter,
  );
  for (const { key, to } of stuck) {
    const instance = model.instances.get(key)!;
    refused.push({
      path: key,
      reason: `${labelOf(instance)} needs ${quote(to)}, which is for another platform, and is not optional`,
    });
  }
  const roots = rootsOf(keptEdges).filter((key) => !dropped.has(key));
  const final = reach(model, roots, followOptional, meter, dropped);

  const unselected = tops.size < model.tops.size;
  for (const key of model.instances.keys()) {
    meter.visits += 1;
    if (final.has(key)) continue;
    if (!wanted.has(key)) {
      if (unselected) skip(key, 'workspace', 'outside the importers selected');
    } else if (!afterOmit.has(key)) {
      skip(key, 'omitted', 'left out by --omit');
    } else if (failed.has(key)) {
      const instance = model.instances.get(key)!;
      skip(
        key,
        'platform',
        `optional, and for ${describePlatform(declared(instance), quote)}, not ${targets.map(describeTarget).join(' or ')}`,
      );
    } else
      skip(
        key,
        'orphaned',
        needs.has(key)
          ? `needs ${quote(needs.get(key)!)}, which this machine does not install`
          : 'only needed by packages this machine does not install',
      );
  }

  const runtime = reach(
    model,
    rootsOf(keptEdges.filter((edge) => edge.list === 'dependencies')).filter(
      (key) => !dropped.has(key),
    ),
    false,
    meter,
    dropped,
  );
  const included = new Map<string, FrozenLockPackage['scope']>();
  for (const key of final)
    included.set(
      key,
      runtime.has(key)
        ? 'runtime'
        : model.instances.get(key)!.optional
          ? 'optional'
          : 'development',
    );
  return {
    included,
    topEdges: new Map(
      [...tops].map((id) => [
        id,
        edgesOf(id).filter(
          (edge) => kept(edge) && (edge.kind === 'link' || final.has(edge.to)),
        ),
      ]),
    ),
    skipped,
    refused,
  };
}

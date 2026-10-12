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
  FrozenLockPackage,
  FrozenLockRefusal,
  FrozenLockSkip,
  FrozenOmit,
  NativeTarget,
} from '@openpacker/adapter-core';
import { npmPackageRuns } from '../platform.js';
import type { PnpmInstance, PnpmModel, PnpmTopEdge } from './model.js';

export interface SelectInput {
  readonly model: PnpmModel;
  /** The importer ids being installed. */
  readonly tops: ReadonlySet<string>;
  readonly omit: ReadonlySet<FrozenOmit>;
  /** The machines to install for: a package that runs on any of them is installed. */
  readonly targets: readonly NativeTarget[];
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
  return `${target.os}/${target.architecture}${target.libc === undefined ? '' : `/${target.libc}`}`;
}

function describeDeclared(instance: PnpmInstance): string {
  const { os, cpu, libc } = instance.pkg;
  return [
    os && `os ${os.join(',')}`,
    cpu && `cpu ${cpu.join(',')}`,
    libc && `libc ${libc.join(',')}`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Every instance reachable from `roots`, not entering `blocked`. */
function reach(
  model: PnpmModel,
  roots: Iterable<string>,
  followOptional: boolean,
  blocked: ReadonlySet<string> = new Set(),
): Set<string> {
  const seen = new Set<string>();
  const pending = [...roots].filter((key) => !blocked.has(key));
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    if (seen.has(key)) continue;
    seen.add(key);
    for (const edge of model.instances.get(key)?.edges ?? [])
      if (
        (followOptional || !edge.optional) &&
        !blocked.has(edge.to) &&
        !seen.has(edge.to)
      )
        pending.push(edge.to);
  }
  return seen;
}

/** The instances a set of importer edges point at (a link points at none). */
function rootsOf(edges: Iterable<PnpmTopEdge>): string[] {
  const out: string[] = [];
  for (const edge of edges) if (edge.kind === 'dep') out.push(edge.to);
  return out;
}

export function selectInstances(input: SelectInput): Selection {
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
  const wanted = reach(model, rootsOf(everyEdge), true);
  const afterOmit = reach(model, rootsOf(keptEdges), followOptional);

  // The platform, on what the omission left.
  const failed = new Set<string>();
  for (const key of afterOmit) {
    const instance = model.instances.get(key)!;
    if (targets.some((target) => npmPackageRuns(instance.pkg, target)))
      continue;
    if (instance.optional) failed.add(key);
    else
      refused.push({
        path: key,
        reason: `${instance.name}@${instance.version} is for ${describeDeclared(instance)}, not ${targets.map(describeTarget).join(' or ')}, and is not optional`,
      });
  }
  // What needs a dropped instance outright cannot work either (arborist's
  // optionalSet); an instance that is not optional doing so is a lock whose
  // flags do not match its graph.
  const dropped = new Set(failed);
  const needs = new Map<string, string>();
  const reported = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const key of afterOmit) {
      if (dropped.has(key)) continue;
      const instance = model.instances.get(key)!;
      const edge = instance.edges.find(
        (candidate) => !candidate.optional && dropped.has(candidate.to),
      );
      if (edge === undefined) continue;
      if (!instance.optional) {
        if (reported.has(key)) continue;
        reported.add(key);
        refused.push({
          path: key,
          reason: `${instance.name}@${instance.version} needs ${edge.to}, which is for another platform, and is not optional`,
        });
        continue;
      }
      dropped.add(key);
      needs.set(key, edge.to);
      changed = true;
    }
  }
  const roots = rootsOf(keptEdges).filter((key) => !dropped.has(key));
  const final = reach(model, roots, followOptional, dropped);

  const unselected = tops.size < model.tops.size;
  for (const key of model.instances.keys()) {
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
        `optional, and for ${describeDeclared(instance)}, not ${targets.map(describeTarget).join(' or ')}`,
      );
    } else
      skip(
        key,
        'orphaned',
        needs.has(key)
          ? `needs ${needs.get(key)!}, which this machine does not install`
          : 'only needed by packages this machine does not install',
      );
  }

  const runtime = reach(
    model,
    rootsOf(keptEdges.filter((edge) => edge.list === 'dependencies')).filter(
      (key) => !dropped.has(key),
    ),
    false,
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

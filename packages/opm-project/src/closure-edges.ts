import type { PackageInstance, Requirement } from '@openpacker/contracts';
import type { EmbeddedResolver } from '@openpacker/embedded';
import { codecFor } from './codecs.js';
import {
  nativeRange,
  requirementInstallName,
  satisfiesNative,
} from './requirement-info.js';
import { stripPurlVersion } from './spec.js';
import { OpmError } from './types.js';

/**
 * Which selected package each dependency edge of a closure points at.
 *
 * The engine decides which packages are selected; it does not say which of
 * several selected versions of one name a given dependent uses. That is decided
 * here, after the solve, by a rule that depends only on the selection: an edge
 * goes to the newest selected version its range accepts. See ADR 0054.
 */

/** Requirement kinds that belong in an install. */
export const INSTALLED_KINDS = new Set(['runtime', 'peer', 'optional']);

/** One dependency edge of the closure, resolved to a selected package. */
export interface ClosureEdge {
  fromNodeId: string;
  toNodeId: string;
  /** The directory name the dependent finds the target under. */
  installName: string;
  /** The requirement this edge answers. */
  requirementId: string;
}

/** An edge with the objects it was made from. */
interface AssignedEdge extends ClosureEdge {
  from: PackageInstance;
  to: PackageInstance;
  requirement: Requirement;
}

/** The hard dependency edges a selected package brings with it. */
export function installedRequirements(
  instance: PackageInstance,
): Requirement[] {
  return (instance.requirements ?? []).filter(
    (requirement) =>
      !requirement.optional &&
      INSTALLED_KINDS.has(requirement.kind) &&
      requirement.expression.type === 'package',
  );
}

export function baseOf(requirement: Requirement): string {
  return stripPurlVersion(
    requirement.expression.type === 'package'
      ? requirement.expression.purl
      : '',
  );
}

/** Where a selected package comes from, for a message. */
export function describe(instance: PackageInstance): string {
  return instance.identity.exactPurl ?? instance.nodeId;
}

/**
 * Point every installed requirement of every selected package at the newest
 * selected version of its package that the ecosystem's own range accepts.
 *
 * A requirement nothing selected satisfies is returned, not thrown, so the
 * caller can say who needed what.
 */
export function assignEdges(selected: readonly PackageInstance[]): {
  edges: AssignedEdge[];
  unmet: { from: PackageInstance; requirement: Requirement }[];
} {
  const byBase = new Map<string, PackageInstance[]>();
  for (const instance of selected) {
    const base = instance.identity.canonicalPurl;
    byBase.set(base, [...(byBase.get(base) ?? []), instance]);
  }
  for (const [base, versions] of byBase) {
    const codec = codecFor(versions[0]!.identity.purlType);
    byBase.set(
      base,
      [...versions].sort((left, right) =>
        codec.compareNativeVersions(right.nativeVersion, left.nativeVersion),
      ),
    );
  }
  const edges: AssignedEdge[] = [];
  const unmet: { from: PackageInstance; requirement: Requirement }[] = [];
  for (const from of selected)
    for (const requirement of installedRequirements(from)) {
      const range = nativeRange(requirement);
      const target = (byBase.get(baseOf(requirement)) ?? []).find(
        (candidate) =>
          range === undefined ||
          satisfiesNative(
            candidate.identity.purlType,
            candidate.nativeVersion,
            range,
          ),
      );
      if (target === undefined) {
        unmet.push({ from, requirement });
        continue;
      }
      edges.push({
        fromNodeId: from.nodeId,
        toNodeId: target.nodeId,
        installName: requirementInstallName(requirement),
        requirementId: requirement.id,
        from,
        to: target,
        requirement,
      });
    }
  return { edges, unmet };
}

/**
 * What is reachable from the roots through the assigned edges. The engine may
 * select a version for an edge that a newer selected version also suits; that
 * version has no edge, and no place in the lock.
 */
export function reachableSelection(input: {
  selected: readonly PackageInstance[];
  edges: readonly AssignedEdge[];
  isRoot: (instance: PackageInstance) => boolean;
}): PackageInstance[] {
  const out = new Map<string, AssignedEdge[]>();
  for (const edge of input.edges)
    out.set(edge.fromNodeId, [...(out.get(edge.fromNodeId) ?? []), edge]);
  const reached = new Set<string>();
  const pending = input.selected.filter(input.isRoot);
  while (pending.length > 0) {
    const instance = pending.pop()!;
    if (reached.has(instance.nodeId)) continue;
    reached.add(instance.nodeId);
    for (const edge of out.get(instance.nodeId) ?? [])
      if (!reached.has(edge.toNodeId)) pending.push(edge.to);
  }
  return input.selected.filter((instance) => reached.has(instance.nodeId));
}

/** The selected packages whose name is selected at more than one version. */
export function duplicatedNames(
  selected: readonly PackageInstance[],
): Map<string, PackageInstance[]> {
  const byBase = new Map<string, PackageInstance[]>();
  for (const instance of selected) {
    const base = instance.identity.canonicalPurl;
    byBase.set(base, [...(byBase.get(base) ?? []), instance]);
  }
  return new Map([...byBase].filter(([, versions]) => versions.length > 1));
}

interface Need {
  by: string;
  range: string;
  accepts: (version: string) => boolean;
}

/**
 * Withdraw every candidate of a duplicated name but one that all of its
 * dependents accept, where there is one.
 *
 * The candidate is the newest that satisfies, by the ecosystem's own reading of
 * each range, every edge to the name and the root requirement on it if there is
 * one. A name that no single release suits stays at several versions
 * (`kept`), unless a required peer dependency points at it: a peer has to
 * resolve to the instance its dependent's parent sees, so that is refused, and
 * says who requires what.
 */
export function unifyDuplicates(input: {
  packages: PackageInstance[];
  edges: readonly AssignedEdge[];
  duplicated: ReadonlyMap<string, PackageInstance[]>;
  rootRequirements: readonly { purl: string; vers?: string }[];
  resolver: Pick<EmbeddedResolver, 'versionSatisfies'>;
  /** Names already known to need several versions; not tried again. */
  kept: Set<string>;
}): { packages: PackageInstance[]; changed: boolean } {
  const withdrawn = new Set<string>();
  for (const [base, chosen] of input.duplicated) {
    if (input.kept.has(base)) continue;
    const ecosystem = chosen[0]!.identity.purlType;
    const needs: Need[] = [];
    for (const root of input.rootRequirements)
      if (stripPurlVersion(root.purl) === base && root.vers !== undefined) {
        const vers = root.vers;
        needs.push({
          by: 'the direct requirement',
          range: vers.replace(/^vers:[^/]+\//u, ''),
          accepts: (version) => input.resolver.versionSatisfies(version, vers),
        });
      }
    let peer = false;
    for (const edge of input.edges) {
      if (baseOf(edge.requirement) !== base) continue;
      if (edge.requirement.kind === 'peer') peer = true;
      const range = nativeRange(edge.requirement);
      if (range !== undefined)
        needs.push({
          by: describe(edge.from),
          range,
          accepts: (version) => satisfiesNative(ecosystem, version, range),
        });
    }
    const codec = codecFor(ecosystem);
    const candidates = input.packages
      .filter((item) => item.identity.canonicalPurl === base)
      .sort((left, right) =>
        codec.compareNativeVersions(right.nativeVersion, left.nativeVersion),
      );
    const agreed = candidates.find((candidate) =>
      needs.every((need) => need.accepts(candidate.nativeVersion)),
    );
    if (agreed === undefined) {
      if (peer)
        throw new OpmError(
          'UNRESOLVABLE',
          `${base} is required as a peer dependency and is needed at versions no single release satisfies: ` +
            needs
              .map((need) => `${need.by} requires ${need.range}`)
              .join('; ') +
            `. The closure would need ${chosen.map(describe).join(' and ')}, ` +
            `and a peer dependency has to be the one release its dependent's parent sees`,
        );
      input.kept.add(base);
      continue;
    }
    for (const candidate of candidates)
      if (candidate !== agreed) withdrawn.add(candidate.nodeId);
  }
  return {
    packages: input.packages.filter((item) => !withdrawn.has(item.nodeId)),
    changed: withdrawn.size > 0,
  };
}

/**
 * Who needed what, for a closure the selection cannot satisfy: each unmet edge
 * with the versions the selection does hold of the package it asked for.
 */
export function describeUnmet(
  unmet: readonly { from: PackageInstance; requirement: Requirement }[],
  selected: readonly PackageInstance[],
): string {
  return unmet
    .slice(0, 5)
    .map(({ from, requirement }) => {
      const base = baseOf(requirement);
      const held = selected
        .filter((item) => item.identity.canonicalPurl === base)
        .map((item) => item.nativeVersion);
      return unmetLine(
        from,
        requirement,
        held.length === 0
          ? 'which nothing selected'
          : `but the closure selected ${held.join(', ')}`,
      );
    })
    .join('; ');
}

/** One line saying an instance needs something no release provides. */
function unmetLine(
  item: PackageInstance,
  requirement: Requirement,
  why: string,
): string {
  const base = baseOf(requirement);
  const range = nativeRange(requirement);
  const install = requirementInstallName(requirement);
  return (
    `${describe(item)} requires ${base}${range === undefined ? '' : ` ${range}`}` +
    (install === base.slice(base.lastIndexOf('/') + 1)
      ? ''
      : ` (as ${install})`) +
    `, ${why}`
  );
}

/**
 * The candidates that could be installed at all.
 *
 * A candidate with a hard requirement that nothing left in the universe
 * satisfies cannot be selected, whatever else is chosen, and neither can a
 * candidate that needed it. They are taken out before the solve, to a fixed
 * point, so the engine is asked about candidates that can be selected. (The
 * solutions are the same; a candidate with a dead requirement is one no
 * solution contains. The engine's search does not always find the others when
 * such a candidate depends on another release of its own name.) What was taken
 * out is returned with why, for the message when nothing is left.
 */
export function viableCandidates(packages: readonly PackageInstance[]): {
  kept: PackageInstance[];
  dropped: string[];
} {
  let kept = [...packages];
  const dropped: string[] = [];
  for (;;) {
    const held = new Map<string, PackageInstance[]>();
    for (const item of kept)
      held.set(item.identity.canonicalPurl, [
        ...(held.get(item.identity.canonicalPurl) ?? []),
        item,
      ]);
    const next: PackageInstance[] = [];
    for (const item of kept) {
      const dead = installedRequirements(item).find((requirement) => {
        const range = nativeRange(requirement);
        return !(held.get(baseOf(requirement)) ?? []).some(
          (candidate) =>
            range === undefined ||
            satisfiesNative(
              candidate.identity.purlType,
              candidate.nativeVersion,
              range,
            ),
        );
      });
      if (dead === undefined) next.push(item);
      else
        dropped.push(
          unmetLine(item, dead, 'and no such release can be installed'),
        );
    }
    if (next.length === kept.length) return { kept, dropped };
    kept = next;
  }
}

/**
 * Why a closure has no selection, where one cause is plain: an edge, from a
 * package the walk found or from the project, that nothing installable
 * satisfies. Combinations of releases that exclude each other have no single
 * cause to name, and this says nothing for them.
 */
export function explainUnsatisfiable(input: {
  dropped: readonly string[];
  rootRequirements: readonly { purl: string; vers?: string }[];
  kept: readonly PackageInstance[];
  resolver: Pick<EmbeddedResolver, 'versionSatisfies'>;
}): string[] {
  const out: string[] = [];
  for (const root of input.rootRequirements) {
    const base = stripPurlVersion(root.purl);
    if (
      root.vers !== undefined &&
      !input.kept.some(
        (item) =>
          item.identity.canonicalPurl === base &&
          input.resolver.versionSatisfies(item.nativeVersion, root.vers!),
      )
    )
      out.push(
        `the project requires ${base} ${root.vers.replace(/^vers:[^/]+\//u, '')}, and no such release can be installed`,
      );
  }
  return [...out, ...new Set(input.dropped)];
}

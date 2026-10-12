/**
 * Does the lock agree with itself?
 *
 * `parsePnpmLock` checks each part alone. This checks the parts against each
 * other, the way pnpm would trip over them: every dependency resolves to a
 * snapshot or is a `link:`, every snapshot has the package it is a variant of,
 * a resolution is the kind its key says, a `workspace:` or `catalog:` specifier
 * landed where it should, a patch is declared and used.
 *
 * It returns a report and throws nothing: the caller decides which problems end
 * an install and which only get listed. `assertConsistentPnpmLock` is the
 * decision a frozen install makes.
 */

import { isWorkspaceSpecifier } from '@openpacker/adapter-core';
import { PnpmLockError } from './errors.js';
import { exoticSourcesOf, type PnpmExoticSource } from './exotic.js';
import { packageKeyOf } from './dep-path.js';
import { compareKeys } from './order.js';
import { redactAddresses } from './redact.js';
import { catalogOfSpecifier, patchedPackageName } from './specifier.js';
import type { SourceKind } from './source.js';
import type { PnpmLock, PnpmPackage, PnpmRef } from './types.js';

export type PnpmLockProblemCode =
  | 'importer-dependency-unresolved'
  | 'snapshot-dependency-unresolved'
  | 'snapshot-without-package'
  | 'resolution-source-mismatch'
  | 'conflicting-specifiers'
  | 'workspace-specifier-not-linked'
  | 'catalog-entry-missing'
  | 'patch-undeclared'
  | 'patch-hash-mismatch'
  | 'patch-unused';

export interface PnpmLockProblem {
  readonly code: PnpmLockProblemCode;
  /** The place in the lock, spelled the way the refusals spell it. */
  readonly where: string;
  readonly message: string;
}

/** A `link:` dependency. Only an importer's can be placed: a snapshot's is relative to its own package. */
export interface PnpmLinkEdge {
  readonly owner: 'importer' | 'snapshot';
  /** The importer id or snapshot key that lists it. */
  readonly id: string;
  readonly name: string;
  /** The path after `link:`, as written. */
  readonly target: string;
  /** Where an importer's link lands, relative to the lock's root, or undefined if it leaves the root. */
  readonly resolved?: string;
  /** The link lands on another importer: a workspace member. */
  readonly member?: boolean;
}

export interface PnpmLockReport {
  /** The first `MAXIMUM_REPORTED_PROBLEMS`, in lock order. */
  readonly problems: readonly PnpmLockProblem[];
  /** All of them, counted. */
  readonly problemCount: number;
  /** `packages` entries no snapshot is a variant of. */
  readonly orphanPackages: readonly string[];
  /** Snapshots no importer reaches. */
  readonly orphanSnapshots: readonly string[];
  readonly exoticSources: readonly PnpmExoticSource[];
  readonly links: readonly PnpmLinkEdge[];
}

export const MAXIMUM_REPORTED_PROBLEMS = 1000;

/**
 * Which resolutions a key of each source may have, from what pnpm's resolvers
 * produce: a `git+` key is a git resolution, an `https://` key a tarball (a git
 * host's archive or a plain URL), a `file:` key a directory or an archive.
 */
const RESOLUTIONS_FOR: Readonly<Record<SourceKind, readonly string[]>> = {
  registry: ['integrity', 'tarball'],
  tarball: ['tarball'],
  git: ['git'],
  file: ['directory', 'tarball'],
  runtime: ['variations'],
};

/**
 * The version a git package's key must have, as pnpm's `createGitHostedPkgId`
 * writes it from the resolution: `git+<repo>#<commit>`, then `&path:<dir>`. The
 * key is what policy reads; the resolution is what would be fetched.
 */
function gitKeyVersion(resolution: {
  readonly repo: string;
  readonly commit: string;
  readonly path?: string;
}): string {
  const address = `${resolution.repo.includes('://') ? '' : 'https://'}${resolution.repo}#${resolution.commit}`;
  const id = address.startsWith('git+') ? address : `git+${address}`;
  return resolution.path === undefined ? id : `${id}&path:${resolution.path}`;
}

/** `base/target` with `.` and `..` folded, or undefined when it climbs out of the root. */
export function joinInside(base: string, target: string): string | undefined {
  const parts = base === '.' ? [] : base.split('/');
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.pop() === undefined) return undefined;
    } else parts.push(segment);
  }
  return parts.length === 0 ? '.' : parts.join('/');
}

class Findings {
  readonly problems: PnpmLockProblem[] = [];
  count = 0;

  add(code: PnpmLockProblemCode, where: string, message: string): void {
    this.count += 1;
    if (this.problems.length < MAXIMUM_REPORTED_PROBLEMS)
      this.problems.push({
        code,
        where: redactAddresses(where),
        message: redactAddresses(message),
      });
  }
}

function checkResolutionKinds(lock: PnpmLock, findings: Findings): void {
  for (const pkg of lock.packages) {
    const where = `packages[${JSON.stringify(pkg.key)}]`;
    if (!RESOLUTIONS_FOR[pkg.source].includes(pkg.resolution.kind))
      findings.add(
        'resolution-source-mismatch',
        where,
        `is a ${pkg.source} source but its resolution is ${pkg.resolution.kind}`,
      );
    else if (
      pkg.resolution.kind === 'git' &&
      gitKeyVersion(pkg.resolution) !== pkg.version
    )
      findings.add(
        'resolution-source-mismatch',
        where,
        `names the git source ${JSON.stringify(pkg.version)} but its resolution is ${JSON.stringify(gitKeyVersion(pkg.resolution))}`,
      );
  }
}

/** Patch declarations against the patch hashes snapshots carry. */
function checkPatches(lock: PnpmLock, findings: Findings): void {
  const names = new Set(lock.packages.map((pkg) => pkg.name));
  const patched = new Set(
    [...lock.patchedDependencies.keys()].map(patchedPackageName),
  );
  for (const snapshot of lock.snapshots) {
    const hash = snapshot.path.patchHash;
    if (hash === undefined) continue;
    const exact = packageKeyOf(snapshot.path);
    const declared =
      lock.patchedDependencies.get(exact) ??
      lock.patchedDependencies.get(snapshot.path.name);
    const where = `snapshots[${JSON.stringify(snapshot.key)}]`;
    if (declared === undefined) {
      // A key that is a range is not evaluated here: it only has to name this package.
      if (!patched.has(snapshot.path.name))
        findings.add(
          'patch-undeclared',
          where,
          `carries a patch_hash but no patch is declared for ${exact}`,
        );
    } else if (declared.hash !== hash)
      findings.add(
        'patch-hash-mismatch',
        where,
        `has patch_hash ${hash}, and the declared patch hash is ${declared.hash}`,
      );
  }
  for (const key of lock.patchedDependencies.keys()) {
    const name = patchedPackageName(key);
    if (!names.has(name))
      findings.add(
        'patch-unused',
        `patchedDependencies[${JSON.stringify(key)}]`,
        `patches ${name}, which the lock does not install`,
      );
  }
}

function checkImporters(
  lock: PnpmLock,
  snapshotKeys: ReadonlySet<string>,
  findings: Findings,
  links: PnpmLinkEdge[],
): string[] {
  const importerIds = new Set(lock.importers.map((importer) => importer.id));
  const roots: string[] = [];
  for (const importer of lock.importers) {
    const seen = new Map<string, string>();
    for (const list of [
      importer.dependencies,
      importer.devDependencies,
      importer.optionalDependencies,
    ]) {
      for (const dependency of list) {
        const where = `importers[${JSON.stringify(importer.id)}][${JSON.stringify(dependency.name)}]`;
        const earlier = seen.get(dependency.name);
        if (earlier !== undefined && earlier !== dependency.specifier)
          findings.add(
            'conflicting-specifiers',
            where,
            `is listed with the specifiers ${JSON.stringify(earlier)} and ${JSON.stringify(dependency.specifier)}`,
          );
        seen.set(dependency.name, dependency.specifier);
        checkSpecifier(
          lock,
          dependency.name,
          dependency.specifier,
          dependency.ref,
          where,
          findings,
        );
        const { ref } = dependency;
        if (ref.kind === 'link') {
          const resolved = joinInside(importer.id, ref.target);
          links.push({
            owner: 'importer',
            id: importer.id,
            name: dependency.name,
            target: ref.target,
            ...(resolved !== undefined && {
              resolved,
              member: importerIds.has(resolved),
            }),
          });
        } else if (snapshotKeys.has(ref.target.raw)) roots.push(ref.target.raw);
        else
          findings.add(
            'importer-dependency-unresolved',
            where,
            `resolves to ${JSON.stringify(ref.target.raw)}, which is not in snapshots`,
          );
      }
    }
  }
  return roots;
}

function checkSpecifier(
  lock: PnpmLock,
  name: string,
  specifier: string,
  ref: PnpmRef,
  where: string,
  findings: Findings,
): void {
  if (
    isWorkspaceSpecifier(specifier) &&
    ref.kind === 'dep' &&
    ref.target.source !== 'file'
  )
    findings.add(
      'workspace-specifier-not-linked',
      where,
      `asks for ${specifier} but resolved to the ${ref.target.source} package ${ref.target.raw}`,
    );
  const catalog = catalogOfSpecifier(specifier);
  if (catalog !== undefined && lock.catalogs.get(catalog)?.has(name) !== true)
    findings.add(
      'catalog-entry-missing',
      where,
      `asks for the catalog ${JSON.stringify(catalog)}, which has no entry for ${name}`,
    );
}

/** Snapshot keys reachable from `roots` through dependencies and optionalDependencies. */
function reachableFrom(lock: PnpmLock, roots: readonly string[]): Set<string> {
  const byKey = new Map(
    lock.snapshots.map((snapshot) => [snapshot.key, snapshot]),
  );
  const reached = new Set<string>();
  const queue = [...roots];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    if (reached.has(next)) continue;
    reached.add(next);
    const snapshot = byKey.get(next);
    if (snapshot === undefined) continue;
    for (const list of [snapshot.dependencies, snapshot.optionalDependencies])
      for (const dependency of list)
        if (dependency.ref.kind === 'dep')
          queue.push(dependency.ref.target.raw);
  }
  return reached;
}

function checkSnapshots(
  lock: PnpmLock,
  snapshotKeys: ReadonlySet<string>,
  packageKeys: ReadonlySet<string>,
  findings: Findings,
  links: PnpmLinkEdge[],
): void {
  for (const snapshot of lock.snapshots) {
    const where = `snapshots[${JSON.stringify(snapshot.key)}]`;
    if (!packageKeys.has(packageKeyOf(snapshot.path)))
      findings.add(
        'snapshot-without-package',
        where,
        `has no entry ${JSON.stringify(packageKeyOf(snapshot.path))} in packages`,
      );
    for (const list of [snapshot.dependencies, snapshot.optionalDependencies]) {
      for (const dependency of list) {
        const { ref } = dependency;
        if (ref.kind === 'link')
          links.push({
            owner: 'snapshot',
            id: snapshot.key,
            name: dependency.name,
            target: ref.target,
          });
        else if (!snapshotKeys.has(ref.target.raw))
          findings.add(
            'snapshot-dependency-unresolved',
            `${where}[${JSON.stringify(dependency.name)}]`,
            `resolves to ${JSON.stringify(ref.target.raw)}, which is not in snapshots`,
          );
      }
    }
  }
}

export function validatePnpmLock(lock: PnpmLock): PnpmLockReport {
  const findings = new Findings();
  const links: PnpmLinkEdge[] = [];
  const snapshotKeys = new Set(lock.snapshots.map((snapshot) => snapshot.key));
  const packageKeys = new Set(lock.packages.map((pkg: PnpmPackage) => pkg.key));
  const roots = checkImporters(lock, snapshotKeys, findings, links);
  checkSnapshots(lock, snapshotKeys, packageKeys, findings, links);
  checkResolutionKinds(lock, findings);
  checkPatches(lock, findings);
  const reached = reachableFrom(lock, roots);
  const variantsOf = new Set(
    lock.snapshots.map((snapshot) => packageKeyOf(snapshot.path)),
  );
  return {
    problems: findings.problems,
    problemCount: findings.count,
    orphanPackages: lock.packages
      .filter((pkg) => !variantsOf.has(pkg.key))
      .map((pkg) => pkg.key)
      .sort(compareKeys),
    orphanSnapshots: lock.snapshots
      .filter((snapshot) => !reached.has(snapshot.key))
      .map((snapshot) => snapshot.key)
      .sort(compareKeys),
    exoticSources: exoticSourcesOf(lock),
    links,
  };
}

/** The decision a frozen install makes: a lock that disagrees with itself is not installed. */
export function assertConsistentPnpmLock(report: PnpmLockReport): void {
  if (report.problemCount === 0) return;
  const shown = report.problems
    .slice(0, 5)
    .map((problem) => `${problem.where} ${problem.message}`);
  const more =
    report.problemCount > shown.length
      ? `, and ${report.problemCount - shown.length} more`
      : '';
  throw new PnpmLockError(
    'inconsistent',
    `disagrees with itself in ${report.problemCount} place${report.problemCount === 1 ? '' : 's'}: ${shown.join('; ')}${more}`,
  );
}

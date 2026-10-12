/**
 * Which entries of a `package-lock.json` a machine installs.
 *
 * `npm ci` installs what the lock says and resolves nothing. This is the part
 * of that which decides, from the lock alone, which entries this machine
 * installs, which it leaves out and why, and which the lock holds that cannot
 * be installed at all.
 *
 * The rules follow npm's, because the lock's flags (`dev`, `optional`, `peer`)
 * mean what npm's tree walk means by them:
 *
 * - `--omit` leaves out an entry that is reachable only through the omitted
 *   kind of edge.
 * - An `optional` entry whose `os`, `cpu` or `libc` does not match is not
 *   installed, nor is anything only it needs (npm's `optionalSet`). The same
 *   mismatch on an entry that is not optional is an error: npm refuses it
 *   (EBADPLATFORM), and so does this.
 * - An entry shipped inside its parent's tarball is not fetched on its own.
 *
 * Pure: no file is read and nothing is fetched. Whether a package is allowed
 * (policy) and whether its bytes are what the lock pinned (integrity) are the
 * host's to judge.
 */

import { echoed } from '@openpacker/adapter-core';
import type {
  FrozenLockOptions,
  FrozenLockPackage,
  FrozenLockRefusal,
  FrozenLockSkip,
  FrozenSourceKind,
  NativeTarget,
} from '@openpacker/adapter-core';
import {
  resolveFromChain,
  type LockEntry,
  type PackageLockTree,
} from './lock-tree.js';
import { npmPackageRuns } from './platform.js';
import { npmPurl } from './purl.js';

interface Edge {
  /** Null for an edge from the project's own manifest. */
  from: LockEntry | null;
  to: LockEntry;
  /** An optionalDependencies edge, or an optional peer. */
  optional: boolean;
}

export interface FrozenInstallPlan {
  packages: FrozenLockPackage[];
  skipped: FrozenLockSkip[];
  refused: FrozenLockRefusal[];
}

/** A locked package as a message names it: its name, `@`, its version. */
function label(entry: LockEntry): string {
  return `${echoed(entry.packageName)}@${echoed(entry.version)}`;
}

function describeTarget(target: NativeTarget): string {
  return `${target.os}/${target.architecture}${target.libc === undefined ? '' : `/${target.libc}`}`;
}

function describeDeclared(entry: LockEntry): string {
  return [
    entry.os && `os ${entry.os.map((item) => echoed(item)).join(',')}`,
    entry.cpu && `cpu ${entry.cpu.map((item) => echoed(item)).join(',')}`,
    entry.libc && `libc ${entry.libc.map((item) => echoed(item)).join(',')}`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Where an entry's `resolved` points, as far as its shape shows. */
export function classifyResolved(entry: {
  packageName: string;
  version: string;
  resolved?: string | undefined;
}): { kind: FrozenSourceKind } | { problem: string } {
  const resolved = entry.resolved;
  if (resolved === undefined)
    return { problem: 'has no resolved URL, so there is nothing to fetch' };
  if (
    /^(?:git(?:\+[a-z]+)?:|github:|gitlab:|bitbucket:|gist:)/iu.test(resolved)
  )
    return { kind: 'git' };
  if (
    /^(?:file|link):/iu.test(resolved) ||
    !/^[a-z][a-z0-9+.-]*:/iu.test(resolved)
  )
    return { kind: 'path' };
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    return { problem: `resolved ${JSON.stringify(resolved)} is not a URL` };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return { problem: `resolved uses ${url.protocol}, not https` };
  if (url.username !== '' || url.password !== '')
    return { problem: 'resolved carries credentials in its URL' };
  // A registry serves `/<name>/-/<last segment>-<version>.tgz`, behind whatever
  // prefix it is mounted at. Any other https archive is a URL dependency.
  const base = entry.packageName.split('/').at(-1)!;
  const archiveSuffix = `/${entry.packageName}/-/${base}-${entry.version}.tgz`;
  return {
    kind: url.pathname.endsWith(archiveSuffix) ? 'registry' : 'tarball',
  };
}

/**
 * The edges of the lock's dependency graph: for each declared dependency, the
 * entry Node would find for it from where the declaring package lives.
 */
function buildEdges(
  tree: PackageLockTree,
  byPath: ReadonlyMap<string, LockEntry>,
) {
  const into = new Map<LockEntry, Edge[]>();
  const out = new Map<LockEntry, Edge[]>();
  const connect = (
    from: LockEntry | null,
    chain: readonly string[],
    name: string,
    optional: boolean,
  ): void => {
    const to = resolveFromChain(byPath, chain, name);
    if (to === undefined) return;
    const edge: Edge = { from, to, optional };
    into.set(to, [...(into.get(to) ?? []), edge]);
    if (from !== null) out.set(from, [...(out.get(from) ?? []), edge]);
  };
  const root = tree.root;
  if (root !== undefined) {
    for (const name of Object.keys(root.dependencies))
      if (!(name in root.optionalDependencies)) connect(null, [], name, false);
    for (const name of Object.keys(root.devDependencies))
      connect(null, [], name, false);
    for (const name of Object.keys(root.optionalDependencies))
      connect(null, [], name, true);
    for (const name of Object.keys(root.peerDependencies))
      connect(null, [], name, false);
  }
  for (const entry of tree.entries) {
    for (const name of Object.keys(entry.dependencies))
      if (!(name in entry.optionalDependencies))
        connect(entry, entry.chain, name, false);
    for (const name of Object.keys(entry.optionalDependencies))
      connect(entry, entry.chain, name, true);
    for (const name of Object.keys(entry.peerDependencies))
      connect(
        entry,
        entry.chain,
        name,
        entry.peerDependenciesMeta[name]?.optional === true,
      );
  }
  return { into, out };
}

/**
 * What npm drops when an optional package cannot be installed (arborist's
 * `optionalSet`): the package, the packages above it that need it outright,
 * and whatever is then needed only from inside that set.
 */
function optionalSet(
  failed: LockEntry,
  into: ReadonlyMap<LockEntry, readonly Edge[]>,
  out: ReadonlyMap<LockEntry, readonly Edge[]>,
): Set<LockEntry> {
  const set = new Set<LockEntry>([failed]);
  for (const node of set)
    for (const edge of into.get(node) ?? [])
      if (!edge.optional && edge.from !== null) set.add(edge.from);
  const deps = new Set(set);
  for (const node of deps)
    for (const edge of out.get(node) ?? [])
      if (!edge.optional) deps.add(edge.to);
  let changed = true;
  while (changed && deps.size > 0) {
    changed = false;
    for (const dep of deps) {
      const outside = (into.get(dep) ?? []).some(
        (edge) =>
          !edge.optional && (edge.from === null || !deps.has(edge.from)),
      );
      if (outside) {
        deps.delete(dep);
        changed = true;
      }
    }
  }
  return deps;
}

/**
 * Decide what a frozen install of `tree` installs on `options.target`.
 *
 * Pure: no file is read. Refusals are collected, not thrown, so that one run
 * names everything the lock holds that cannot be installed.
 */
export function planFrozenPackageLock(input: {
  tree: PackageLockTree;
  options: FrozenLockOptions;
}): FrozenInstallPlan {
  const { tree, options } = input;
  const { omit, target } = options;
  const byPath = new Map(tree.entries.map((entry) => [entry.path, entry]));
  const { into, out } = buildEdges(tree, byPath);
  const skipped: FrozenLockSkip[] = [];
  const refused: FrozenLockRefusal[] = [];
  const skip = (
    entry: LockEntry,
    kind: FrozenLockSkip['kind'],
    reason: string,
  ): void => {
    skipped.push({
      path: entry.path,
      name: entry.name,
      version: entry.version,
      kind,
      reason,
    });
  };

  const left = new Set<LockEntry>();
  for (const entry of tree.entries) {
    if (entry.inBundle) {
      skip(entry, 'bundled', "shipped inside its parent's tarball");
      continue;
    }
    const why =
      (entry.peer && omit.has('peer') && 'peer dependency (omitted)') ||
      (entry.dev && omit.has('dev') && 'dev dependency (omitted)') ||
      (entry.optional &&
        omit.has('optional') &&
        'optional dependency (omitted)') ||
      (entry.devOptional &&
        omit.has('optional') &&
        omit.has('dev') &&
        'dev and optional dependency (omitted)');
    if (why) skip(entry, 'omitted', why);
    else left.add(entry);
  }

  const failed: LockEntry[] = [];
  for (const entry of left) {
    if (npmPackageRuns(entry, target)) continue;
    if (entry.optional) failed.push(entry);
    else {
      left.delete(entry);
      refused.push({
        path: entry.path,
        reason: `${label(entry)} is for ${describeDeclared(entry)}, not this machine (${describeTarget(target)}), and is not optional`,
      });
    }
  }
  for (const entry of failed) {
    left.delete(entry);
    skip(
      entry,
      'platform',
      `optional, and for ${describeDeclared(entry)}, not ${describeTarget(target)}`,
    );
  }
  for (const entry of failed)
    for (const dropped of optionalSet(entry, into, out)) {
      if (dropped === entry || !left.delete(dropped)) continue;
      skip(
        dropped,
        'orphaned',
        `only needed by ${echoed(entry.path)}, which this machine does not install`,
      );
    }

  const roots = tree.root;
  const named = new Set([
    ...Object.keys(roots?.dependencies ?? {}),
    ...Object.keys(roots?.devDependencies ?? {}),
    ...Object.keys(roots?.optionalDependencies ?? {}),
    ...Object.keys(roots?.peerDependencies ?? {}),
  ]);
  const packages: FrozenLockPackage[] = [];
  for (const entry of [...left].sort(byDepthThenPath)) {
    const parent = entry.chain.length > 1 ? parentPath(entry) : undefined;
    if (parent !== undefined && !installed(left, byPath.get(parent))) {
      refused.push({
        path: entry.path,
        reason: `${label(entry)} lives inside ${echoed(parent)}, which is not installed; the lock's flags do not match its dependency graph`,
      });
      continue;
    }
    const source = classifyResolved(entry);
    if ('problem' in source) {
      refused.push({
        path: entry.path,
        reason: `${label(entry)} ${source.problem}`,
      });
      continue;
    }
    if (entry.integrity === undefined) {
      refused.push({
        path: entry.path,
        reason: `${label(entry)} has no integrity, so the lock does not pin its bytes`,
      });
      continue;
    }
    packages.push({
      path: entry.path,
      name: entry.name,
      packageName: entry.packageName,
      version: entry.version,
      purl: npmPurl(entry.packageName),
      exactPurl: `${npmPurl(entry.packageName)}@${entry.version}`,
      source: entry.resolved!,
      sourceKind: source.kind,
      integrity: entry.integrity,
      direct: entry.chain.length === 1 && named.has(entry.name),
      scope: entry.peer
        ? 'peer'
        : entry.optional
          ? 'optional'
          : entry.dev
            ? 'development'
            : 'runtime',
      hasInstallScript: entry.hasInstallScript,
      ...(entry.deprecated !== undefined && { deprecated: entry.deprecated }),
    });
  }
  return { packages, skipped, refused };
}

function installed(left: ReadonlySet<LockEntry>, entry: LockEntry | undefined) {
  return entry !== undefined && left.has(entry);
}

function parentPath(entry: LockEntry): string {
  return entry.path.slice(0, entry.path.lastIndexOf('/node_modules/'));
}

function byDepthThenPath(left: LockEntry, right: LockEntry): number {
  return (
    left.chain.length - right.chain.length ||
    (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  );
}

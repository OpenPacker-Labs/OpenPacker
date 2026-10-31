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

import {
  echoed,
  echoedValue,
  hasOverlongHost,
  LONGEST_HOST_LENGTH,
  parseUntrustedUrl,
  redactAddress,
  shownScheme,
} from '@openpacker/adapter-core';
import type {
  FrozenLockOptions,
  FrozenLockPackage,
  FrozenLockRefusal,
  FrozenLockSkip,
  FrozenLockWorkspace,
  FrozenSourceKind,
  NativeTarget,
} from '@openpacker/adapter-core';
import { buildGraph, optionalSet } from './frozen-graph.js';
import type { LockEntry, PackageLockTree } from './lock-tree.js';
import { npmPackageRuns } from './platform.js';
import { npmPurl } from './purl.js';
import { scopeOfWorkspace, workspaceLayout } from './frozen-workspace.js';

export interface FrozenInstallPlan {
  packages: FrozenLockPackage[];
  skipped: FrozenLockSkip[];
  refused: FrozenLockRefusal[];
  workspace?: FrozenLockWorkspace;
}

/** A locked package as a message names it: its name, `@`, its version. */
function label(entry: LockEntry): string {
  return `${echoedValue(entry.packageName)}@${echoedValue(entry.version)}`;
}

function describeTarget(target: NativeTarget): string {
  return `${target.os}/${target.architecture}${target.libc === undefined ? '' : `/${target.libc}`}`;
}

function describeTargets(targets: readonly NativeTarget[]): string {
  return targets.map(describeTarget).join(' or ');
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
  // Before any parser reads it: Node's takes the square of the length of a host
  // of many non-ASCII labels, and no DNS name is longer than 253 characters.
  if (hasOverlongHost(resolved))
    return {
      problem: `resolved names a host longer than ${LONGEST_HOST_LENGTH} characters, which no DNS name can be`,
    };
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
    url = parseUntrustedUrl(resolved);
  } catch {
    // The text is not a URL, so it was never parsed: it can hold userinfo, a
    // query and a fragment that must not reach a terminal.
    return {
      problem: `resolved ${JSON.stringify(redactAddress(resolved))} is not a URL`,
    };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    // The scheme of `user:password@host:path` is the user name.
    const scheme = shownScheme(url);
    return {
      problem:
        scheme === undefined
          ? `resolved is ${redactAddress(resolved)}, not an https URL`
          : `resolved uses ${scheme}, not https`,
    };
  }
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
  const targets = options.targets ?? [target];
  const all = [...tree.entries, ...(tree.workspace?.entries ?? [])];
  const byPath = new Map(all.map((entry) => [entry.path, entry]));
  const graph = buildGraph(tree, all, byPath);
  const selection = scopeOfWorkspace(tree, graph, options.workspace?.scope);
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
  for (const entry of all) {
    if (selection.entries !== undefined && !selection.entries.has(entry)) {
      skip(entry, 'workspace', 'outside the workspaces selected');
      continue;
    }
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
    if (targets.some((candidate) => npmPackageRuns(entry, candidate))) continue;
    if (entry.optional) failed.push(entry);
    else {
      left.delete(entry);
      refused.push({
        path: entry.path,
        reason: `${label(entry)} is for ${describeDeclared(entry)}, not this machine (${describeTargets(targets)}), and is not optional`,
      });
    }
  }
  for (const entry of failed) {
    left.delete(entry);
    skip(
      entry,
      'platform',
      `optional, and for ${describeDeclared(entry)}, not ${describeTargets(targets)}`,
    );
  }
  for (const entry of failed)
    for (const dropped of optionalSet(entry, graph)) {
      if (dropped === entry || !left.delete(dropped)) continue;
      skip(
        dropped,
        'orphaned',
        `only needed by ${echoedValue(entry.path)}, which this machine does not install`,
      );
    }

  const named = namedByTops(tree);
  const packages: FrozenLockPackage[] = [];
  for (const entry of [...left].sort(byDepthThenPath)) {
    const parent = entry.chain.length > 1 ? parentPath(entry) : undefined;
    if (parent !== undefined && !installed(left, byPath.get(parent))) {
      refused.push({
        path: entry.path,
        reason: `${label(entry)} lives inside ${echoedValue(parent)}, which is not installed; the lock's flags do not match its dependency graph`,
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
      direct: entry.chain.length === 1 && isNamedFor(named, entry),
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
  const workspace = workspaceLayout(tree, selection.members);
  return { packages, skipped, refused, ...(workspace && { workspace }) };
}

/** The names each top (the project `''`, or a member by directory) declares. */
function namedByTops(tree: PackageLockTree): Map<string, Set<string>> {
  const names = (declared: {
    dependencies: object;
    optionalDependencies: object;
    peerDependencies: object;
    devDependencies?: object;
  }) =>
    new Set([
      ...Object.keys(declared.dependencies),
      ...Object.keys(declared.devDependencies ?? {}),
      ...Object.keys(declared.optionalDependencies),
      ...Object.keys(declared.peerDependencies),
    ]);
  const named = new Map<string, Set<string>>();
  if (tree.root !== undefined) named.set('', names(tree.root));
  for (const member of tree.workspace?.members ?? [])
    named.set(member.dir, names(member));
  return named;
}

/**
 * Whether a top names the package: a package inside a member is named by that
 * member alone; one in the project's own `node_modules` by the project or by
 * any member, since a member's dependency is hoisted there.
 */
function isNamedFor(
  named: ReadonlyMap<string, ReadonlySet<string>>,
  entry: LockEntry,
): boolean {
  if (entry.member !== '')
    return named.get(entry.member)?.has(entry.name) === true;
  return [...named.values()].some((names) => names.has(entry.name));
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

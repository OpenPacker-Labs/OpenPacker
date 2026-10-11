/**
 * `package-lock.json` as a frozen install reads it.
 *
 * `npm ci` installs what the lock says and resolves nothing. This is that
 * reading, as npm does it: which entries this machine installs, which it
 * leaves out and why, and which the lock holds that cannot be installed at all.
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
 * Nothing here touches the network or writes a file. Whether a package is
 * allowed (policy) and whether its bytes are what the lock pinned (integrity)
 * are the host's to judge.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ProviderError,
  type DetectedProject,
  type FrozenLock,
  type FrozenLockOptions,
  type FrozenLockPackage,
  type FrozenLockRefusal,
  type FrozenLockSkip,
  type FrozenSourceKind,
  type NativeTarget,
} from '@openpacker/adapter-core';
import {
  parsePackageLockText,
  resolveFromChain,
  type LockEntry,
  type PackageLockTree,
} from './lock-tree.js';
import { npmSatisfies } from './npm-range.js';
import { npmPackageRuns } from './platform.js';
import { npmPurl } from './purl.js';

const MAXIMUM_LOCK_BYTES = 64 * 1024 * 1024;
const MAXIMUM_MANIFEST_BYTES = 4 * 1024 * 1024;

type StringMap = Readonly<Record<string, string>>;

/** The parts of `package.json` a frozen install checks the lock against. */
export interface FrozenManifest {
  dependencies: StringMap;
  devDependencies: StringMap;
  optionalDependencies: StringMap;
  peerDependencies: StringMap;
  workspaces?: unknown;
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

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

function describeTarget(target: NativeTarget): string {
  return `${target.os}/${target.architecture}${target.libc === undefined ? '' : `/${target.libc}`}`;
}

function describeDeclared(entry: LockEntry): string {
  return [
    entry.os && `os ${entry.os.join(',')}`,
    entry.cpu && `cpu ${entry.cpu.join(',')}`,
    entry.libc && `libc ${entry.libc.join(',')}`,
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
        reason: `${entry.packageName}@${entry.version} is for ${describeDeclared(entry)}, not this machine (${describeTarget(target)}), and is not optional`,
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
        `only needed by ${entry.path}, which this machine does not install`,
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
        reason: `${entry.packageName}@${entry.version} lives inside ${parent}, which is not installed; the lock's flags do not match its dependency graph`,
      });
      continue;
    }
    const source = classifyResolved(entry);
    if ('problem' in source) {
      refused.push({
        path: entry.path,
        reason: `${entry.packageName}@${entry.version} ${source.problem}`,
      });
      continue;
    }
    if (entry.integrity === undefined) {
      refused.push({
        path: entry.path,
        reason: `${entry.packageName}@${entry.version} has no integrity, so the lock does not pin its bytes`,
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

/**
 * Why the lock does not match `package.json`, one line per difference.
 *
 * `npm ci` refuses to install when they disagree, and so does this: a lock
 * that is behind its manifest installs something other than what the project
 * asks for.
 */
export function lockDisagreements(
  tree: PackageLockTree,
  manifest: FrozenManifest,
): string[] {
  const problems: string[] = [];
  const root = tree.root;
  const byPath = new Map(tree.entries.map((entry) => [entry.path, entry]));
  for (const field of DEPENDENCY_FIELDS) {
    const declared = manifest[field];
    const locked = root?.[field] ?? {};
    for (const name of Object.keys(declared))
      if (!(name in locked))
        problems.push(
          `${field}.${name} is in package.json and not in the lock`,
        );
    for (const name of Object.keys(locked))
      if (!(name in declared))
        problems.push(
          `${field}.${name} is in the lock and no longer in package.json`,
        );
    for (const [name, spec] of Object.entries(declared)) {
      const entry = byPath.get(`node_modules/${name}`);
      if (entry === undefined) {
        if (field === 'dependencies' || field === 'devDependencies')
          problems.push(`${name} (${field}) has no entry in the lock`);
        continue;
      }
      const problem = specProblem(entry, spec);
      if (problem !== undefined) problems.push(`${field}.${name}: ${problem}`);
    }
  }
  return problems;
}

/** Why a locked entry does not satisfy a manifest spec, or undefined. */
function specProblem(entry: LockEntry, spec: string): string | undefined {
  let range = spec.trim();
  if (range.startsWith('npm:')) {
    const alias = /^npm:((?:@[^/@]+\/)?[^@/]+)(?:@(.+))?$/u.exec(range);
    if (alias === null) return undefined;
    if (alias[1] !== entry.packageName)
      return `package.json asks for ${spec}, the lock has ${entry.packageName}@${entry.version}`;
    range = alias[2] ?? '*';
  }
  // Only a plain semver range can be checked against a version. A tag, a URL,
  // a path and a git ref name something else, which the lock pins in its own way.
  if (/[:/]/u.test(range)) return undefined;
  try {
    return npmSatisfies(entry.version, range)
      ? undefined
      : `package.json asks for ${spec}, the lock has ${entry.version}`;
  } catch {
    return undefined;
  }
}

/** The members a workspace lock holds, as refusals. */
function workspaceRefusals(
  tree: PackageLockTree,
  manifest: FrozenManifest,
): FrozenLockRefusal[] {
  const refused: FrozenLockRefusal[] = [];
  for (const link of tree.links)
    refused.push({
      path: link.path,
      reason: `a link to ${link.target || '(no target)'}; workspace members and links are not installed yet`,
    });
  const members = tree.foreign.filter(
    (entry) => !entry.path.includes('/node_modules/'),
  );
  for (const member of members)
    refused.push({
      path: member.path,
      reason: `a workspace member${member.name === undefined ? '' : ` (${member.name})`}; workspaces are not installed yet`,
    });
  const inside = tree.foreign.length - members.length;
  if (inside > 0)
    refused.push({
      path: '(inside the members)',
      reason: `${inside} package${inside === 1 ? '' : 's'} installed inside workspace members`,
    });
  if (
    refused.length === 0 &&
    (manifest.workspaces !== undefined || tree.root?.workspaces !== undefined)
  )
    refused.push({
      path: 'package.json',
      reason: 'declares workspaces, which are not installed yet',
    });
  return refused;
}

async function readBounded(path: string, maximum: number): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    // SAFETY: Node file errors carry a string `code`.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT')
      throw new ProviderError('NOT_FOUND', `${path} does not exist`);
    if (code === 'ELOOP')
      throw new ProviderError(
        'UNSAFE_PATH',
        `${path} is a symbolic link; a frozen install reads the file itself`,
      );
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `${path} is not a regular file`,
      );
    if (info.size > maximum)
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `${path} is ${info.size} bytes, more than the ${maximum} this reads`,
      );
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function readManifest(text: string, path: string): FrozenManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ProviderError(
      'INVALID_MANIFEST',
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new ProviderError(
      'INVALID_MANIFEST',
      `${path} must be a JSON object`,
    );
  // SAFETY: checked above to be a plain object; fields are validated below.
  const record = parsed as Record<string, unknown>;
  const field = (name: (typeof DEPENDENCY_FIELDS)[number]): StringMap => {
    const value = record[name];
    if (value === undefined) return {};
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new ProviderError(
        'INVALID_MANIFEST',
        `${path}: ${name} must be an object`,
      );
    const out: Record<string, string> = {};
    for (const [key, spec] of Object.entries(value)) {
      if (typeof spec !== 'string')
        throw new ProviderError(
          'INVALID_MANIFEST',
          `${path}: ${name}.${key} must be a string`,
        );
      out[key] = spec;
    }
    return out;
  };
  return {
    dependencies: field('dependencies'),
    devDependencies: field('devDependencies'),
    optionalDependencies: field('optionalDependencies'),
    peerDependencies: field('peerDependencies'),
    ...(record.workspaces !== undefined && { workspaces: record.workspaces }),
  };
}

/** Read `package.json` and `package-lock.json` in `project` for a frozen install. */
export async function readFrozenPackageLock(
  project: DetectedProject,
  options: FrozenLockOptions,
): Promise<FrozenLock> {
  const lockPath =
    project.relatedPaths?.lock ?? join(project.root, 'package-lock.json');
  const lockText = await readBounded(lockPath, MAXIMUM_LOCK_BYTES).catch(
    (error: unknown) => {
      if (error instanceof ProviderError && error.code === 'NOT_FOUND')
        throw new ProviderError(
          'NOT_FOUND',
          `No package-lock.json in ${project.root}. A frozen install installs exactly what a lock says; create one with npm install --package-lock-only`,
        );
      throw error;
    },
  );
  const manifestText = await readBounded(
    project.manifestPath,
    MAXIMUM_MANIFEST_BYTES,
  ).catch((error: unknown) => {
    if (error instanceof ProviderError && error.code === 'NOT_FOUND')
      throw new ProviderError(
        'NOT_FOUND',
        `No package.json in ${project.root}`,
      );
    throw error;
  });
  const tree = parsePackageLockText(lockText);
  const manifest = readManifest(manifestText, project.manifestPath);
  const common = {
    lockPath,
    lockDigest: createHash('sha256').update(lockText).digest('hex'),
    lockfileVersion: tree.lockfileVersion,
    // npm's own extractor takes `./` segments and a repeated identical file
    // as they come, and agent-base@7.1.4 is published with both.
    extraction: { acceptRedundantEntries: true },
  };
  const workspaces = workspaceRefusals(tree, manifest);
  if (workspaces.length > 0)
    return { ...common, packages: [], skipped: [], refused: workspaces };
  const disagreements = lockDisagreements(tree, manifest);
  if (disagreements.length > 0)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      `package.json and package-lock.json are not in sync (npm ci would refuse too): ${disagreements.slice(0, 20).join('; ')}${disagreements.length > 20 ? `; and ${disagreements.length - 20} more` : ''}`,
    );
  return { ...common, ...planFrozenPackageLock({ tree, options }) };
}

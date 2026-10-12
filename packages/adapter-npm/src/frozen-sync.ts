/**
 * Whether a lock still matches the files it was written from.
 *
 * `npm ci` refuses to install when `package.json` and the lock disagree: a lock
 * that is behind its manifest installs something other than what the project
 * asks for. In a workspace that holds for every member too, and for the list of
 * members itself: a directory added or removed since the lock was written
 * makes the lock describe a different tree.
 */

import type { WorkspaceMember } from '@openpacker/adapter-core';
import {
  resolveFromChain,
  type LockEntry,
  type PackageLockTree,
} from './lock-tree.js';
import type { LockMember } from './lock-workspace.js';
import { npmSatisfies } from './npm-range.js';

type StringMap = Readonly<Record<string, string>>;

/** The parts of `package.json` a frozen install checks the lock against. */
export interface FrozenManifest {
  dependencies: StringMap;
  devDependencies: StringMap;
  optionalDependencies: StringMap;
  peerDependencies: StringMap;
  workspaces?: unknown;
}

export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** What a name resolves to in the lock: a package, or a workspace member's link. */
interface Found {
  packageName: string;
  /** Undefined for a member whose entry carries no version. */
  version: string | undefined;
}

/** The dependency lists the lock recorded for a project or a member. */
type Locked = Pick<FrozenManifest, (typeof DEPENDENCY_FIELDS)[number]>;

/** Why a locked package does not satisfy a manifest spec, or undefined. */
function specProblem(found: Found, spec: string): string | undefined {
  let range = spec.trim();
  if (range.startsWith('npm:')) {
    const alias = /^npm:((?:@[^/@]+\/)?[^@/]+)(?:@(.+))?$/u.exec(range);
    if (alias === null) return undefined;
    if (alias[1] !== found.packageName)
      return `package.json asks for ${spec}, the lock has ${found.packageName}@${found.version ?? '(no version)'}`;
    range = alias[2] ?? '*';
  }
  // Only a plain semver range can be checked against a version. A tag, a URL,
  // a path and a git ref name something else, which the lock pins in its own way.
  if (/[:/]/u.test(range) || found.version === undefined) return undefined;
  try {
    return npmSatisfies(found.version, range)
      ? undefined
      : `package.json asks for ${spec}, the lock has ${found.version}`;
  } catch {
    return undefined;
  }
}

function disagreements(
  declaredBy: FrozenManifest,
  locked: Locked,
  lookup: (name: string) => Found | undefined,
  label: string,
): string[] {
  const problems: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const declared = declaredBy[field];
    const inLock = locked[field];
    for (const name of Object.keys(declared))
      if (!(name in inLock))
        problems.push(
          `${label}${field}.${name} is in package.json and not in the lock`,
        );
    for (const name of Object.keys(inLock))
      if (!(name in declared))
        problems.push(
          `${label}${field}.${name} is in the lock and no longer in package.json`,
        );
    for (const [name, spec] of Object.entries(declared)) {
      const found = lookup(name);
      if (found === undefined) {
        if (field === 'dependencies' || field === 'devDependencies')
          problems.push(`${label}${name} (${field}) has no entry in the lock`);
        continue;
      }
      const problem = specProblem(found, spec);
      if (problem !== undefined)
        problems.push(`${label}${field}.${name}: ${problem}`);
    }
  }
  return problems;
}

function foundIn(
  tree: PackageLockTree,
  entry: LockEntry | undefined,
  name: string,
): Found | undefined {
  if (entry !== undefined)
    return { packageName: entry.packageName, version: entry.version };
  const link = tree.workspace?.links.find((item) => item.name === name);
  const member = tree.workspace?.members.find((item) => item.dir === link?.dir);
  return member === undefined
    ? undefined
    : { packageName: member.name, version: member.version };
}

const byPathOf = new WeakMap<PackageLockTree, Map<string, LockEntry>>();

/** Every package of the lock by its key; built once per lock, since each member asks. */
function entriesByPath(tree: PackageLockTree): Map<string, LockEntry> {
  let map = byPathOf.get(tree);
  if (map === undefined) {
    map = new Map(
      [...tree.entries, ...(tree.workspace?.entries ?? [])].map((entry) => [
        entry.path,
        entry,
      ]),
    );
    byPathOf.set(tree, map);
  }
  return map;
}

/**
 * Why the lock does not match `package.json`, one line per difference.
 *
 * `npm ci` refuses to install when they disagree, and so does this.
 */
export function lockDisagreements(
  tree: PackageLockTree,
  manifest: FrozenManifest,
): string[] {
  const byPath = entriesByPath(tree);
  return disagreements(
    manifest,
    tree.root ?? emptyLocked,
    (name) => foundIn(tree, byPath.get(`node_modules/${name}`), name),
    '',
  );
}

const emptyLocked: Locked = {
  dependencies: {},
  devDependencies: {},
  optionalDependencies: {},
  peerDependencies: {},
};

/** The same for one member, against the `package.json` the workspace holds for it. */
export function memberDisagreements(
  tree: PackageLockTree,
  member: LockMember,
  manifest: FrozenManifest,
): string[] {
  const byPath = entriesByPath(tree);
  return disagreements(
    manifest,
    member,
    (name) =>
      foundIn(tree, resolveFromChain(byPath, [], name, member.dir), name),
    `${member.dir}: `,
  );
}

/** A member's `package.json` as the workspace model read it. */
export function manifestOfMember(member: WorkspaceMember): FrozenManifest {
  const { manifest } = member;
  return {
    dependencies: Object.fromEntries(manifest.dependencies),
    devDependencies: Object.fromEntries(manifest.devDependencies),
    optionalDependencies: Object.fromEntries(manifest.optionalDependencies),
    peerDependencies: Object.fromEntries(manifest.peerDependencies),
  };
}

function listed(
  members: readonly { dir: string; name: string | undefined }[],
): string {
  return members.length === 0
    ? '(none)'
    : members.map((member) => member.dir).join(', ');
}

/**
 * How the members the lock lists differ from the members the project's own
 * files declare, naming both sides; empty when they are the same directories
 * with the same names and versions.
 */
export function memberListDisagreements(
  lockMembers: readonly LockMember[],
  diskMembers: readonly WorkspaceMember[],
): string[] {
  const disk = diskMembers.filter((member) => !member.root);
  const onDisk = new Map(disk.map((member) => [member.dir, member]));
  const inLock = new Map(lockMembers.map((member) => [member.dir, member]));
  const lines: string[] = [];
  for (const member of lockMembers)
    if (!onDisk.has(member.dir))
      lines.push(
        `${member.dir} (${member.name}) is a member in the lock and is not on disk`,
      );
  for (const member of disk)
    if (!inLock.has(member.dir))
      lines.push(
        `${member.dir} (${member.name ?? 'unnamed'}) is a member on disk and is not in the lock`,
      );
  for (const member of lockMembers) {
    const there = onDisk.get(member.dir);
    if (there === undefined) continue;
    if (there.name !== member.name)
      lines.push(
        `${member.dir} is named ${JSON.stringify(member.name)} in the lock and ${JSON.stringify(there.name ?? null)} on disk`,
      );
    const version = there.manifest.version;
    if (version !== member.version)
      lines.push(
        `${member.dir} is version ${JSON.stringify(member.version ?? null)} in the lock and ${JSON.stringify(version ?? null)} on disk`,
      );
  }
  if (lines.length === 0) return [];
  return [
    `the lock lists the members ${listed(lockMembers)}`,
    `the project declares the members ${listed(disk)}`,
    ...lines,
  ];
}

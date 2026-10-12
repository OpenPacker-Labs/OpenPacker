/**
 * The workspace a `package-lock.json` describes.
 *
 * npm writes a workspace into the lock three times over. The root entry (`""`)
 * carries the `workspaces` patterns; each member has an entry under its own
 * directory (`packages/x`) holding what its `package.json` declares; and each
 * is linked from the project's `node_modules` (`node_modules/x`, `link: true`,
 * `resolved: packages/x`). A version of a registry package only one member wants
 * sits inside that member (`packages/x/node_modules/a`).
 *
 * The lock is untrusted input, and a `link: true` entry is a request to put a
 * symlink in `node_modules`. ADR 0050 allows exactly one kind: a member's own
 * name linked to the member's own directory. So a link is accepted only when
 * its target is a member *of the lock's own member list* (the directories its
 * root's `workspaces` patterns select, not whatever is on disk), the link is
 * named for that member, and nothing else about it is surprising. Anything else
 * the lock holds that is not an installable registry package is refused by name
 * rather than skipped, because an install that leaves out what the lock names
 * has not installed the lock.
 */

import {
  WorkspaceError,
  compileWorkspacePatterns,
  nameFromDirectory,
  resolveWorkspaceLimits,
  workspaceNameProblem,
  workspacePatternsOf,
} from '@openpacker/adapter-core';
import type { JsonValue } from '@openpacker/contracts';
import { posix } from 'node:path';
import { memberLinkProblem } from '@openpacker/project-io';
import { linkTargetBetween } from './layout-links.js';
import {
  chainOfLockPath,
  readEntry,
  splitNestedLockPath,
  type LockEntry,
} from './lock-entry.js';
import {
  flag,
  invalid,
  isRecord,
  metaMap,
  optionalString,
  stringMap,
  type StringMap,
} from './lock-json.js';

/** A workspace member as the lock records it. */
export interface LockMember {
  /** Root-relative directory, `/`-separated: the lock entry's key. */
  dir: string;
  name: string;
  version?: string;
  dependencies: StringMap;
  devDependencies: StringMap;
  optionalDependencies: StringMap;
  peerDependencies: StringMap;
  peerDependenciesMeta: Readonly<Record<string, { optional?: boolean }>>;
  /** Executables, name to path inside the member, as `npm-normalize-package-bin` reads them. */
  bin: Readonly<Record<string, string>>;
}

/** A link from a member's name to its directory that the lock may carry out. */
export interface LockMemberLink {
  /** The lock's key: `node_modules/<member name>`. */
  path: string;
  name: string;
  /** The member's directory. */
  dir: string;
  /** The text of the link, relative to its directory: `../packages/x`. */
  target: string;
}

export interface LockWorkspace {
  /** The root entry's `workspaces` patterns, as written. */
  patterns: readonly string[];
  /** Sorted by directory. */
  members: readonly LockMember[];
  /** One per member, sorted by place. */
  links: readonly LockMemberLink[];
  /** Registry packages placed inside a member's own `node_modules`. */
  entries: readonly LockEntry[];
  /** What the lock holds that is neither a member, a member's link nor a package. */
  refused: readonly { path: string; reason: string }[];
}

/** What the reader of the whole lock hands over. */
export interface WorkspaceInput {
  /** The root entry's `workspaces` field, as written. */
  workspaces: unknown;
  /** Every `link: true` entry under `node_modules`: key and `resolved`. */
  links: readonly { path: string; chain: readonly string[]; target: string }[];
  /** Every key outside `node_modules` (a member, or something inside one), with its record. */
  foreign: ReadonlyMap<string, Record<string, unknown>>;
}

function patternsOf(workspaces: unknown): readonly string[] {
  if (workspaces === undefined) return [];
  try {
    // SAFETY: the value came out of JSON.parse, and the function checks its shape.
    return workspacePatternsOf(workspaces as JsonValue, 'package-lock.json');
  } catch (error) {
    if (error instanceof WorkspaceError) throw invalid(error.message);
    throw error;
  }
}

function normalizedBin(
  value: unknown,
  name: string,
  where: string,
): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (typeof value === 'string')
    return value === '' ? {} : { [name.split('/').at(-1)!]: value };
  if (!isRecord(value))
    throw invalid(`${where}.bin must be a string or an object`);
  const out: Record<string, string> = {};
  for (const [key, path] of Object.entries(value)) {
    if (typeof path !== 'string')
      throw invalid(`${where}.bin.${key} must be a string`);
    out[key] = path;
  }
  return out;
}

function readMember(
  dir: string,
  record: Record<string, unknown>,
  where: string,
): LockMember {
  const written = optionalString(record, 'name', where);
  const name = written ?? nameFromDirectory(dir) ?? dir;
  const problem = workspaceNameProblem(name);
  if (problem !== undefined) throw invalid(`${where}: ${problem}`);
  const version = optionalString(record, 'version', where);
  return {
    dir,
    name,
    ...(version !== undefined && { version }),
    dependencies: stringMap(record.dependencies, `${where}.dependencies`),
    devDependencies: stringMap(
      record.devDependencies,
      `${where}.devDependencies`,
    ),
    optionalDependencies: stringMap(
      record.optionalDependencies,
      `${where}.optionalDependencies`,
    ),
    peerDependencies: stringMap(
      record.peerDependencies,
      `${where}.peerDependencies`,
    ),
    peerDependenciesMeta: metaMap(
      record.peerDependenciesMeta,
      `${where}.peerDependenciesMeta`,
    ),
    bin: normalizedBin(record.bin, name, where),
  };
}

/** Why a link's `resolved` text cannot be a member's directory, or undefined. */
function targetProblem(target: string): string | undefined {
  if (target === '') return 'has no target';
  if (['\0', '\\'].some((bad) => target.includes(bad)))
    return `points at ${JSON.stringify(target)}, which is not a path inside the project`;
  if (target.startsWith('/') || /^[A-Za-z]:/u.test(target))
    return `points at ${target}, an absolute path; a workspace link points inside the project`;
  if (posix.normalize(target) !== target || target.endsWith('/'))
    return `points at ${JSON.stringify(target)}, which is not in normal form`;
  if (target === '..' || target.startsWith('../'))
    return `points at ${target}, which leaves the project root`;
  if (target === '.') return 'points at the project root itself';
  return undefined;
}

function sameNameProblem(members: readonly LockMember[]): void {
  const byName = new Map<string, string[]>();
  for (const member of members)
    byName.set(member.name, [...(byName.get(member.name) ?? []), member.dir]);
  for (const [name, dirs] of byName)
    if (dirs.length > 1)
      throw invalid(
        `${dirs.length === 2 ? 'Two' : dirs.length} workspace members are named ${JSON.stringify(name)}: ${dirs.join(', ')}`,
      );
}

/**
 * Take the workspace out of a lock, or undefined when the lock has none: no
 * `workspaces` patterns, no link and no key outside `node_modules`.
 */
export function readLockWorkspace(
  input: WorkspaceInput,
): LockWorkspace | undefined {
  const patterns = patternsOf(input.workspaces);
  if (
    patterns.length === 0 &&
    input.links.length === 0 &&
    input.foreign.size === 0
  )
    return undefined;
  let compiled: ReturnType<typeof compileWorkspacePatterns> | undefined;
  try {
    compiled =
      patterns.length === 0
        ? undefined
        : compileWorkspacePatterns(patterns, 'npm', resolveWorkspaceLimits());
  } catch (error) {
    if (error instanceof WorkspaceError) throw invalid(error.message);
    throw error;
  }
  const selects = `the lock's workspaces select ${patterns.length === 0 ? 'nothing' : patterns.join(', ')}`;
  const refused: { path: string; reason: string }[] = [];
  const members: LockMember[] = [];
  const nested: [string, Record<string, unknown>][] = [];
  for (const [path, record] of [...input.foreign].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const where = `packages[${JSON.stringify(path)}]`;
    if (path.includes('/node_modules/')) {
      nested.push([path, record]);
      continue;
    }
    if (compiled?.isMember(path.split('/')) !== true) {
      refused.push({
        path,
        reason: `not a workspace member (${selects}), and not something opm ci can install`,
      });
      continue;
    }
    if (flag(record, 'link', where)) {
      refused.push({
        path,
        reason:
          'a workspace member recorded as a link; a member is a directory',
      });
      continue;
    }
    members.push(readMember(path, record, where));
  }
  sameNameProblem(members);
  const byDir = new Map(members.map((member) => [member.dir, member]));

  const entries: LockEntry[] = [];
  for (const [path, record] of nested) {
    const where = `packages[${JSON.stringify(path)}]`;
    const split = splitNestedLockPath(path)!;
    if (!byDir.has(split.directory)) {
      refused.push({
        path,
        reason: `inside ${split.directory}, which is not a workspace member (${selects})`,
      });
      continue;
    }
    const chain = chainOfLockPath(split.place);
    if (chain === undefined)
      throw invalid(`The lock path ${JSON.stringify(path)} is malformed`);
    if (flag(record, 'link', where)) {
      refused.push({
        path,
        reason: `a link inside the workspace member ${split.directory}; only a member's name directly in the project's node_modules is linked`,
      });
      continue;
    }
    const entry = readEntry(path, split.directory, chain, record, where);
    if (entry.inBundle && chain.length === 1) {
      refused.push({
        path,
        reason: `${entry.packageName}@${entry.version} is bundled in the workspace member ${split.directory}, a directory with no archive to take it from`,
      });
      continue;
    }
    entries.push(entry);
  }

  const links: LockMemberLink[] = [];
  const linked = new Set<string>();
  // A member whose link was refused is named in that refusal already: it is
  // the member of the link's name, or the one the link points at.
  const answered = new Set<string>();
  const byName = new Map(members.map((member) => [member.name, member]));
  const answerFor = (name: string): void => {
    const owner = byName.get(name);
    if (owner !== undefined) answered.add(owner.dir);
  };
  for (const link of input.links) {
    if (link.chain.length !== 1) {
      refused.push({
        path: link.path,
        reason: `a link inside a package; only a member's name directly in the project's node_modules is linked`,
      });
      continue;
    }
    const name = link.chain[0]!;
    const problem = targetProblem(link.target);
    if (problem !== undefined) {
      answerFor(name);
      refused.push({
        path: link.path,
        reason: `a link that ${problem}; only a workspace member may be linked`,
      });
      continue;
    }
    const member = byDir.get(link.target);
    if (member === undefined) {
      answerFor(name);
      refused.push({
        path: link.path,
        reason: `a link to ${link.target}, which is not a workspace member (${selects}); only a workspace member may be linked`,
      });
      continue;
    }
    if (member.name !== name) {
      answered.add(member.dir);
      answerFor(name);
      refused.push({
        path: link.path,
        reason: `a link named ${name} to the member ${member.name} (${member.dir}); a member is linked under its own name only`,
      });
      continue;
    }
    // The layout refuses a link the rules of ADR 0050 do not allow, and does so
    // after the old node_modules is gone; the lock is told no before that.
    const target = linkTargetBetween(link.path, member.dir);
    const rule = memberLinkProblem(link.path, target);
    if (rule !== undefined) {
      answered.add(member.dir);
      refused.push({
        path: link.path,
        reason: `a link to ${member.dir} that the layout's link rules refuse (${rule})`,
      });
      continue;
    }
    linked.add(member.dir);
    links.push({ path: link.path, name, dir: member.dir, target });
  }
  for (const member of members)
    if (!linked.has(member.dir) && !answered.has(member.dir))
      throw invalid(
        `The workspace member ${member.name} (${member.dir}) has no node_modules/${member.name} link in the lock (npm ci would refuse too)`,
      );
  return {
    patterns,
    members: members.sort((a, b) =>
      a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0,
    ),
    links: links.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    entries,
    refused,
  };
}

/**
 * `package-lock.json` (lockfileVersion 2 or 3) read as the tree it describes.
 *
 * npm's lock is a map from install path to package: the key
 * `node_modules/a/node_modules/b` says that `b` lives inside `a`, and the same
 * `name@version` may appear under many keys. That placement is part of what the
 * lock pins, so it is kept here as `chain` rather than collapsed to a name.
 *
 * This is the one reader of that file. The codec's lock capture and the frozen
 * install both go through it, so the root entry, a package locked at several
 * paths, a link and a workspace member are classified the same way by both. The
 * workspace itself (members, their links, the packages inside them) is read by
 * `lock-workspace.ts` and arrives as `workspace`; `entries`, `links` and
 * `foreign` keep their meaning for the readers that predate it.
 *
 * Everything in the file is input. A key becomes a directory name and a
 * `resolved` value becomes a request, so the shapes are checked here and a
 * malformed lock is refused rather than read generously.
 */

import {
  chainOfLockPath,
  readEntry,
  resolveFromChain,
  type LockEntry,
} from './lock-entry.js';
import {
  findDuplicateJsonKey,
  invalid,
  isRecord,
  optionalString,
  stringMap,
  type StringMap,
} from './lock-json.js';
import { readLockWorkspace, type LockWorkspace } from './lock-workspace.js';

export { chainOfLockPath, findDuplicateJsonKey, resolveFromChain };
export type { LockEntry, LockWorkspace };

/** Most entries a lock may hold; the layout planner's own ceiling. */
export const MAXIMUM_LOCK_ENTRIES = 50_000;

/** `link: true`: a symlink in npm, a workspace member or a `file:` link. */
export interface LockLink {
  path: string;
  /** Where the link points, as the lock spells it. */
  target: string;
}

/** A key outside `node_modules`: a workspace member, or something nested in one. */
export interface LockForeignEntry {
  path: string;
  name?: string;
  version?: string;
}

/** The project's own entry (key `""`), copied from its package.json. */
export interface LockRoot {
  name?: string;
  version?: string;
  dependencies: StringMap;
  devDependencies: StringMap;
  optionalDependencies: StringMap;
  peerDependencies: StringMap;
  /** The `workspaces` field exactly as the manifest wrote it. */
  workspaces?: unknown;
}

export interface PackageLockTree {
  lockfileVersion: 2 | 3;
  root: LockRoot | undefined;
  /**
   * Sorted by path, so the tree reads the same however the file was ordered.
   * Registry packages in the project's own `node_modules`; the ones inside a
   * workspace member are `workspace.entries`.
   */
  entries: readonly LockEntry[];
  links: readonly LockLink[];
  foreign: readonly LockForeignEntry[];
  /** Members, their links and what is installed inside them; absent in a lock with none. */
  workspace: LockWorkspace | undefined;
}

function hasUnsafeSegments(path: string): boolean {
  return (
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  );
}

/**
 * Read a parsed `package-lock.json`.
 *
 * Throws `INVALID_LOCKFILE` for a lock this cannot read faithfully: a
 * lockfileVersion other than 2 or 3 (version 1 has no `packages` section to
 * read), a malformed key, or a field of the wrong type.
 */
export function readPackageLock(lock: unknown): PackageLockTree {
  if (!isRecord(lock)) throw invalid('package-lock.json must be a JSON object');
  const version = lock.lockfileVersion;
  if (version === 1 || version === undefined)
    throw invalid(
      'This package-lock.json is lockfileVersion 1 (or has none), which has no `packages` section to install from; regenerate it with npm 7 or later',
    );
  if (version !== 2 && version !== 3)
    throw invalid(
      `Expected package-lock v2 or v3, received ${String(version)}`,
    );
  const packages = lock.packages;
  if (!isRecord(packages))
    throw invalid('package-lock.json has no `packages` object');
  const keys = Object.keys(packages);
  if (keys.length > MAXIMUM_LOCK_ENTRIES)
    throw invalid(
      `The lock has ${keys.length} entries, more than the ${MAXIMUM_LOCK_ENTRIES} this reads`,
    );

  let root: LockRoot | undefined;
  const entries: LockEntry[] = [];
  const links: LockLink[] = [];
  const linkChains: { path: string; chain: string[]; target: string }[] = [];
  const foreign: LockForeignEntry[] = [];
  const foreignRecords = new Map<string, Record<string, unknown>>();
  for (const path of keys.sort()) {
    const record = packages[path];
    const where =
      path === '' ? 'packages[""]' : `packages[${JSON.stringify(path)}]`;
    if (!isRecord(record)) throw invalid(`${where} must be an object`);
    if (path === '') {
      root = readRoot(record, where);
      continue;
    }
    if (hasUnsafeSegments(path))
      throw invalid(
        `The lock path ${JSON.stringify(path)} is not a relative path inside the project`,
      );
    const chain = chainOfLockPath(path);
    if (chain === undefined) {
      const name = optionalString(record, 'name', where);
      const entryVersion = optionalString(record, 'version', where);
      foreign.push({
        path,
        ...(name !== undefined && { name }),
        ...(entryVersion !== undefined && { version: entryVersion }),
      });
      foreignRecords.set(path, record);
      continue;
    }
    if (record.link === true) {
      const target = optionalString(record, 'resolved', where) ?? '';
      links.push({ path, target });
      linkChains.push({ path, chain, target });
      continue;
    }
    if (record.link !== undefined && typeof record.link !== 'boolean')
      throw invalid(`${where}.link must be true or false`);
    entries.push(readEntry(path, '', chain, record, where));
  }
  return {
    lockfileVersion: version,
    root,
    entries,
    links,
    foreign,
    workspace: readLockWorkspace({
      workspaces: root?.workspaces,
      links: linkChains,
      foreign: foreignRecords,
    }),
  };
}

function readRoot(record: Record<string, unknown>, where: string): LockRoot {
  const name = optionalString(record, 'name', where);
  const version = optionalString(record, 'version', where);
  return {
    ...(name !== undefined && { name }),
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
    ...(record.workspaces !== undefined && { workspaces: record.workspaces }),
  };
}

/** Parse the text of a lock, refusing a key that appears twice in one object. */
export function parsePackageLockText(text: string): PackageLockTree {
  const duplicate = findDuplicateJsonKey(text);
  if (duplicate !== undefined)
    throw invalid(
      `package-lock.json lists the key ${JSON.stringify(duplicate)} twice in one object`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalid(
      `package-lock.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return readPackageLock(parsed);
}

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
 * paths, a link and a workspace member are classified the same way by both.
 *
 * Everything in the file is input. A key becomes a directory name and a
 * `resolved` value becomes a request, so the shapes are checked here and a
 * malformed lock is refused rather than read generously.
 */

import { ProviderError } from '@openpacker/adapter-core';
import { unsafeNameProblem } from './layout-plan.js';

/** Most entries a lock may hold; the layout planner's own ceiling. */
export const MAXIMUM_LOCK_ENTRIES = 50_000;

type StringMap = Readonly<Record<string, string>>;

/** One package the lock installs somewhere under `node_modules`. */
export interface LockEntry {
  /** The lock's key, e.g. `node_modules/a/node_modules/b`. */
  path: string;
  /**
   * Directory names from the project down: `['a', 'b']` is the example above.
   * A scoped name is one element, `@scope/name`.
   */
  chain: readonly string[];
  /** The name the package lives under: the alias, for an aliased dependency. */
  name: string;
  /** The package's own name; differs from `name` only for an `npm:` alias. */
  packageName: string;
  version: string;
  resolved?: string;
  integrity?: string;
  /** Reachable only through devDependencies. */
  dev: boolean;
  /** Reachable only through optionalDependencies. */
  optional: boolean;
  /** Reachable only through dev or optional edges, but through both kinds. */
  devOptional: boolean;
  /** Reachable only through peerDependencies. */
  peer: boolean;
  /** Shipped inside its parent's tarball rather than fetched on its own. */
  inBundle: boolean;
  os?: readonly string[];
  cpu?: readonly string[];
  libc?: readonly string[];
  hasInstallScript: boolean;
  deprecated?: string;
  dependencies: StringMap;
  optionalDependencies: StringMap;
  peerDependencies: StringMap;
  peerDependenciesMeta: Readonly<Record<string, { optional?: boolean }>>;
}

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
  /** Sorted by path, so the tree reads the same however the file was ordered. */
  entries: readonly LockEntry[];
  links: readonly LockLink[];
  foreign: readonly LockForeignEntry[];
}

function invalid(message: string): ProviderError {
  return new ProviderError('INVALID_LOCKFILE', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Directory names for a `node_modules/...` key, or undefined for a key that is
 * not under `node_modules` at all. A key that starts there and is not a clean
 * sequence of `node_modules/<name>` pairs is refused.
 */
export function chainOfLockPath(path: string): string[] | undefined {
  if (!path.startsWith('node_modules/')) return undefined;
  const segments = path.split('/');
  const chain: string[] = [];
  let at = 0;
  while (at < segments.length) {
    if (segments[at] !== 'node_modules')
      throw invalid(`The lock path ${JSON.stringify(path)} is malformed`);
    at += 1;
    let name = segments[at];
    if (name === undefined || name === '')
      throw invalid(`The lock path ${JSON.stringify(path)} is malformed`);
    at += 1;
    if (name.startsWith('@')) {
      const second = segments[at];
      if (second === undefined || second === '')
        throw invalid(`The lock path ${JSON.stringify(path)} is malformed`);
      name = `${name}/${second}`;
      at += 1;
    }
    const problem = unsafeNameProblem(name);
    if (problem !== undefined)
      throw invalid(`The lock path ${JSON.stringify(path)}: ${problem}`);
    chain.push(name);
  }
  return chain;
}

/**
 * The first key that appears twice in one JSON object, or undefined.
 *
 * `JSON.parse` keeps the last of two equal keys, so a lock that lists one path
 * twice would install whichever came second without anyone having chosen it.
 */
export function findDuplicateJsonKey(text: string): string | undefined {
  const objects: (Set<string> | undefined)[] = [];
  let expectKey = false;
  let at = 0;
  while (at < text.length) {
    const character = text[at]!;
    if (character === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== '"')
        end += text[end] === '\\' ? 2 : 1;
      const open = objects.at(-1);
      if (open !== undefined && expectKey) {
        const raw = text.slice(at + 1, end);
        const key = raw.includes('\\') ? parseKey(raw) : raw;
        if (open.has(key)) return key;
        open.add(key);
        expectKey = false;
      }
      at = end + 1;
      continue;
    }
    if (character === '{') {
      objects.push(new Set());
      expectKey = true;
    } else if (character === '[') {
      objects.push(undefined);
      expectKey = false;
    } else if (character === '}' || character === ']') {
      objects.pop();
      expectKey = false;
    } else if (character === ',') {
      expectKey = objects.at(-1) !== undefined;
    } else if (character === ':') {
      expectKey = false;
    }
    at += 1;
  }
  return undefined;
}

function parseKey(raw: string): string {
  try {
    // SAFETY: JSON.parse of a quoted string yields a string.
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function stringMap(value: unknown, where: string): StringMap {
  if (value === undefined) return {};
  if (!isRecord(value)) throw invalid(`${where} must be an object`);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string')
      throw invalid(`${where}.${key} must be a string`);
    out[key] = entry;
  }
  return out;
}

function stringList(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw invalid(`${where} must be a list of strings`);
  return value as string[];
}

function flag(record: Record<string, unknown>, key: string, where: string) {
  const value = record[key];
  if (value === undefined) return false;
  if (typeof value !== 'boolean')
    throw invalid(`${where}.${key} must be true or false`);
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string')
    throw invalid(`${where}.${key} must be a string`);
  return value;
}

function metaMap(value: unknown, where: string) {
  if (value === undefined) return {};
  if (!isRecord(value)) throw invalid(`${where} must be an object`);
  const out: Record<string, { optional?: boolean }> = {};
  for (const [key, entry] of Object.entries(value))
    out[key] =
      isRecord(entry) && entry.optional === true ? { optional: true } : {};
  return out;
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
  const foreign: LockForeignEntry[] = [];
  for (const path of keys.sort()) {
    const record = packages[path];
    const where =
      path === '' ? 'packages[""]' : `packages[${JSON.stringify(path)}]`;
    if (!isRecord(record)) throw invalid(`${where} must be an object`);
    if (path === '') {
      root = readRoot(record, where);
      continue;
    }
    if (
      path.includes('\\') ||
      path.includes('\0') ||
      path.startsWith('/') ||
      path
        .split('/')
        .some(
          (segment) => segment === '' || segment === '.' || segment === '..',
        )
    )
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
      continue;
    }
    if (flag(record, 'link', where)) {
      links.push({
        path,
        target: optionalString(record, 'resolved', where) ?? '',
      });
      continue;
    }
    entries.push(readEntry(path, chain, record, where));
  }
  return {
    lockfileVersion: version,
    root,
    entries,
    links,
    foreign,
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

function readEntry(
  path: string,
  chain: string[],
  record: Record<string, unknown>,
  where: string,
): LockEntry {
  const version = record.version;
  if (typeof version !== 'string' || version === '')
    throw invalid(`${where}.version must be a non-empty string`);
  const name = chain.at(-1)!;
  const packageName = optionalString(record, 'name', where) ?? name;
  const resolved = optionalString(record, 'resolved', where);
  const integrity = optionalString(record, 'integrity', where);
  const deprecated = optionalString(record, 'deprecated', where);
  const os = stringList(record.os, `${where}.os`);
  const cpu = stringList(record.cpu, `${where}.cpu`);
  const libc = stringList(record.libc, `${where}.libc`);
  return {
    path,
    chain,
    name,
    packageName,
    version,
    ...(resolved !== undefined && { resolved }),
    ...(integrity !== undefined && { integrity }),
    dev: flag(record, 'dev', where),
    optional: flag(record, 'optional', where),
    devOptional: flag(record, 'devOptional', where),
    peer: flag(record, 'peer', where),
    inBundle: flag(record, 'inBundle', where),
    ...(os !== undefined && { os }),
    ...(cpu !== undefined && { cpu }),
    ...(libc !== undefined && { libc }),
    hasInstallScript: flag(record, 'hasInstallScript', where),
    ...(deprecated !== undefined && { deprecated }),
    dependencies: stringMap(record.dependencies, `${where}.dependencies`),
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

/**
 * Where Node finds `name` from the directory a package lives in: its own
 * `node_modules`, then each ancestor's, then the project's.
 */
export function resolveFromChain(
  byPath: ReadonlyMap<string, LockEntry>,
  from: readonly string[],
  name: string,
): LockEntry | undefined {
  for (let depth = from.length; depth >= 0; depth -= 1) {
    const base = from.slice(0, depth);
    const key = [
      ...base.flatMap((part) => ['node_modules', part]),
      'node_modules',
      name,
    ].join('/');
    const hit = byPath.get(key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

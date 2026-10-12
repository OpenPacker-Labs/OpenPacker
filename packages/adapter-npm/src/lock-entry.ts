/**
 * One package a lock installs somewhere under a `node_modules`, and the places
 * Node looks for a dependency from where it lives.
 *
 * A key is a path: `node_modules/a/node_modules/b` says `b` lives inside `a`.
 * In a workspace the same chain can start in a member's own directory,
 * `packages/x/node_modules/a`, which is where npm puts a version only that
 * member wants. The chain is kept (`chain`) beside the member it starts in
 * (`member`) because the placement is part of what the lock pins.
 */

import { unsafeNameProblem } from './layout-plan.js';
import {
  flag,
  invalid,
  metaMap,
  optionalString,
  stringList,
  stringMap,
  type StringMap,
} from './lock-json.js';

/** One package the lock installs somewhere under `node_modules`. */
export interface LockEntry {
  /** The lock's key, e.g. `node_modules/a/node_modules/b`. */
  path: string;
  /**
   * The workspace member whose `node_modules` the chain starts in, as its
   * directory (`packages/x`); `''` for the project's own `node_modules`.
   */
  member: string;
  /**
   * Directory names from that `node_modules` down: `['a', 'b']` is the example
   * above. A scoped name is one element, `@scope/name`.
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
 * A key that lies inside some directory's `node_modules`, split at the first
 * one: `packages/x/node_modules/a` is the directory `packages/x` and the place
 * `node_modules/a`. Undefined for a key with no `node_modules` segment.
 */
export function splitNestedLockPath(
  path: string,
): { directory: string; place: string } | undefined {
  const at = path.indexOf('/node_modules/');
  if (at <= 0) return undefined;
  return { directory: path.slice(0, at), place: path.slice(at + 1) };
}

/** A lock's place for a package: in the project's `node_modules`, or a member's. */
export function placeOfLockPath(
  path: string,
): { chain: string[]; base?: string } | undefined {
  const own = chainOfLockPath(path);
  if (own !== undefined) return { chain: own };
  const nested = splitNestedLockPath(path);
  if (nested === undefined) return undefined;
  const chain = chainOfLockPath(nested.place);
  return chain === undefined ? undefined : { chain, base: nested.directory };
}

export function readEntry(
  path: string,
  member: string,
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
    member,
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

/** The lock key of `name` in the `node_modules` reached by `chain` under `member`. */
export function lockKeyOf(
  member: string,
  chain: readonly string[],
  name: string,
): string {
  return [
    ...(member === '' ? [] : [member]),
    ...chain.flatMap((part) => ['node_modules', part]),
    'node_modules',
    name,
  ].join('/');
}

/**
 * Where Node finds `name` from the directory a package lives in: its own
 * `node_modules`, then each ancestor's, then, for a package inside a member,
 * the project's own.
 */
export function resolveFromChain(
  byPath: ReadonlyMap<string, LockEntry>,
  from: readonly string[],
  name: string,
  member = '',
): LockEntry | undefined {
  for (let depth = from.length; depth >= 0; depth -= 1) {
    const hit = byPath.get(lockKeyOf(member, from.slice(0, depth), name));
    if (hit !== undefined) return hit;
  }
  return member === '' ? undefined : byPath.get(lockKeyOf('', [], name));
}

/**
 * Whether an npm package runs on a machine, from the `os`, `cpu` and `libc`
 * lists a package declares.
 *
 * The lists are npm's own vocabulary (`process.platform`, `process.arch`,
 * `glibc` or `musl`), and a leading `!` negates an entry. They become a
 * `TargetPredicate` once, here, and are evaluated by the one evaluator the
 * closure walk uses (`evaluateTargetPredicate`), so a package the walk would
 * leave out is a package a frozen install leaves out.
 */

import {
  evaluateTargetPredicate,
  type ArchivePlatform,
  type NativeTarget,
} from '@openpacker/adapter-core';
import type { TargetPredicate } from '@openpacker/contracts';

/**
 * npm's own reading of one list: `["any"]` on its own constrains nothing, and
 * a list matches when no negated entry equals the value and, if there are
 * plain entries, one of them does.
 */
export function npmTargetPredicate(
  os: readonly string[] | undefined,
  cpu: readonly string[] | undefined,
  libc: readonly string[] | undefined,
): TargetPredicate | undefined {
  const predicates: TargetPredicate[] = [];
  for (const [path, values] of [
    ['os', os],
    ['architecture', cpu],
    ['libc', libc],
  ] as const) {
    if (values?.length === 1 && values[0] === 'any') continue;
    const included = (values ?? []).filter(
      (value) => value !== '*' && !value.startsWith('!'),
    );
    const excluded = (values ?? [])
      .filter((value) => value.startsWith('!'))
      .map((value) => value.slice(1));
    if (included.length > 0)
      predicates.push({ type: 'in', path, values: included });
    if (excluded.length > 0)
      predicates.push({ type: 'notIn', path, values: excluded });
  }
  return predicates.length === 0
    ? undefined
    : predicates.length === 1
      ? predicates[0]
      : { type: 'allOf', predicates };
}

/** True when a package that declares these lists runs on `target`. */
export function npmPackageRuns(
  declared: {
    os?: readonly string[] | undefined;
    cpu?: readonly string[] | undefined;
    libc?: readonly string[] | undefined;
  },
  target: NativeTarget,
): boolean {
  const predicate = npmTargetPredicate(
    declared.os,
    declared.cpu,
    declared.libc,
  );
  return (
    predicate === undefined ||
    evaluateTargetPredicate(predicate, target) === true
  );
}

/** The lists a package is held to: the lock's, and the archive's where the lock has none. */
export interface DeclaredPlatform {
  os?: readonly string[] | undefined;
  cpu?: readonly string[] | undefined;
  libc?: readonly string[] | undefined;
  /** The lists taken from the archive's own package.json. */
  fromArchive?: readonly ('os' | 'cpu' | 'libc')[];
}

/** `lock`'s lists, each one it lacks taken from `archive` when that declares it. */
export function withArchivePlatform(
  lock: {
    os?: readonly string[] | undefined;
    cpu?: readonly string[] | undefined;
    libc?: readonly string[] | undefined;
  },
  archive: ArchivePlatform | undefined,
): DeclaredPlatform {
  const declared: DeclaredPlatform = {
    os: lock.os,
    cpu: lock.cpu,
    libc: lock.libc,
  };
  if (archive === undefined) return declared;
  const fromArchive: ('os' | 'cpu' | 'libc')[] = [];
  for (const field of ['os', 'cpu', 'libc'] as const)
    if (declared[field] === undefined && archive[field] !== undefined) {
      declared[field] = archive[field];
      fromArchive.push(field);
    }
  return fromArchive.length === 0 ? declared : { ...declared, fromArchive };
}

/**
 * Whether an optional package's archive has to be read to know if it runs:
 * its lock entry restricts the platform (it is a native build) but names no C
 * library. Registry metadata long lacked `libc`, so locks written from it list
 * a musl build as for linux/x64, and its own package.json says musl.
 */
export function libcUnstated(declared: DeclaredPlatform): boolean {
  return (
    declared.libc === undefined &&
    (declared.os !== undefined || declared.cpu !== undefined)
  );
}

/** How a message names the lists, saying which came from the package.json. */
export function describePlatform(
  declared: DeclaredPlatform,
  quote: (value: string) => string,
): string {
  const list = (field: 'os' | 'cpu' | 'libc') => {
    const values = declared[field];
    return values === undefined
      ? undefined
      : `${field} ${values.map(quote).join(',')}`;
  };
  const fromArchive = new Set(declared.fromArchive ?? []);
  const lock = (['os', 'cpu', 'libc'] as const)
    .filter((field) => !fromArchive.has(field))
    .map(list)
    .filter(Boolean);
  const archive = (['os', 'cpu', 'libc'] as const)
    .filter((field) => fromArchive.has(field))
    .map(list)
    .filter(Boolean);
  return archive.length === 0
    ? lock.join(' ')
    : `${[...lock, ...archive].join(' ')} (${archive.join(' ')} from its package.json; the lock does not say)`;
}

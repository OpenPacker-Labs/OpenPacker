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

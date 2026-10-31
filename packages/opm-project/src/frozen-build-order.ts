/**
 * The order an install runs the install scripts a project approved in
 * (ADR 0060 §7).
 *
 * A package's scripts run after those of every approved package it depends on:
 * the names in its `dependencies`, `optionalDependencies` and
 * `peerDependencies`, each resolved to the place in the lock Node loads it
 * from (the nearest `node_modules` at or above the package that the lock
 * fills), directly or through packages and workspace members that run
 * nothing. Where nothing orders two packages, the lock's order does. Packages
 * that depend on each other run in the lock's order, and a cycle in which two
 * or more run a script is reported: their order is the lock's, not one their
 * dependencies chose.
 */

import { posix } from 'node:path';

export interface BuildOrderInput<P extends { readonly path: string }> {
  /** Every package the lock installs, in the lock's order. */
  readonly packages: readonly P[];
  /** Which of them run a script. */
  readonly runs: (pkg: P) => boolean;
  /** The workspace links the layout writes: a place, and the member directory its text leads to. */
  readonly links?: readonly {
    readonly path: string;
    readonly target: string;
  }[];
  /** Places the lock leaves to a parent's own archive (bundled): Node loads that copy, and the walk stops there. */
  readonly stops?: ReadonlySet<string>;
  /** The names the package or member at a project-relative directory depends on, from its three lists. */
  readonly dependencyNames: (dir: string) => Promise<readonly string[]>;
}

export interface BuildOrder<P> {
  /** The packages that run a script, in the order they run. */
  order: P[];
  /** Each cycle in which more than one package runs a script, in the lock's order. */
  cycles: P[][];
}

/** The parent of a project-relative `/` path; `''` is the project. */
function parentOf(dir: string): string {
  const slash = dir.lastIndexOf('/');
  return slash === -1 ? '' : dir.slice(0, slash);
}

/** Where Node looks for `name` from `dir`, nearest first. */
function* lookups(dir: string, name: string): Generator<string> {
  for (let current = dir; ; current = parentOf(current)) {
    if (posix.basename(current) !== 'node_modules')
      yield current === ''
        ? `node_modules/${name}`
        : `${current}/node_modules/${name}`;
    if (current === '') return;
  }
}

/** A link's member directory, project-relative, or undefined when its text leaves the project. */
function memberDirectory(link: { path: string; target: string }) {
  if (posix.isAbsolute(link.target)) return undefined;
  const dir = posix.normalize(
    posix.join(posix.dirname(link.path), link.target),
  );
  return dir === '.' || dir === '..' || dir.startsWith('../') ? undefined : dir;
}

/** Strongly connected components of `edges`, Tarjan's, without recursion. */
function components(edges: ReadonlyMap<string, readonly string[]>) {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let next = 0;
  for (const start of edges.keys()) {
    if (index.has(start)) continue;
    const work: { node: string; at: number }[] = [{ node: start, at: 0 }];
    index.set(start, next);
    low.set(start, next);
    next += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const targets = edges.get(frame.node) ?? [];
      if (frame.at < targets.length) {
        const target = targets[frame.at]!;
        frame.at += 1;
        if (!index.has(target)) {
          index.set(target, next);
          low.set(target, next);
          next += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, at: 0 });
        } else if (onStack.has(target))
          low.set(
            frame.node,
            Math.min(low.get(frame.node)!, index.get(target)!),
          );
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined)
        low.set(
          parent.node,
          Math.min(low.get(parent.node)!, low.get(frame.node)!),
        );
      if (low.get(frame.node) === index.get(frame.node)) {
        const members: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          members.push(member);
          if (member === frame.node) break;
        }
        out.push(members);
      }
    }
  }
  return out;
}

/** The order the approved scripts run in, and the cycles among them. */
export async function buildOrder<P extends { readonly path: string }>(
  input: BuildOrderInput<P>,
): Promise<BuildOrder<P>> {
  const running = input.packages.filter((pkg) => input.runs(pkg));
  if (running.length <= 1) return { order: running, cycles: [] };
  const position = new Map(input.packages.map((pkg, at) => [pkg.path, at]));
  const byPath = new Map(input.packages.map((pkg) => [pkg.path, pkg]));
  const members = new Map<string, string>();
  for (const link of input.links ?? []) {
    const dir = memberDirectory(link);
    if (dir !== undefined) members.set(link.path, dir);
  }
  const resolveFrom = (dir: string, name: string): string | undefined => {
    for (const place of lookups(dir, name)) {
      if (position.has(place)) return place;
      const member = members.get(place);
      if (member !== undefined) return member;
      if (input.stops?.has(place) === true) return undefined;
    }
    return undefined;
  };

  // The graph reachable from what runs: nothing else can order it.
  const edges = new Map<string, string[]>();
  const pending = running.map((pkg) => pkg.path).reverse();
  while (pending.length > 0) {
    const dir = pending.pop()!;
    if (edges.has(dir)) continue;
    const targets: string[] = [];
    for (const name of await input.dependencyNames(dir)) {
      const target = resolveFrom(dir, name);
      if (target !== undefined && target !== dir && !targets.includes(target))
        targets.push(target);
    }
    edges.set(dir, targets);
    for (const target of [...targets].reverse())
      if (!edges.has(target)) pending.push(target);
  }

  const groups = components(edges).map((members) => {
    const runs = members
      .map((dir) => byPath.get(dir))
      .filter((pkg): pkg is P => pkg !== undefined && input.runs(pkg))
      .sort((a, b) => position.get(a.path)! - position.get(b.path)!);
    return {
      members,
      runs,
      // What runs nothing goes as soon as it can: it only lets others go.
      key: runs.length === 0 ? -1 : position.get(runs[0]!.path)!,
    };
  });
  const groupOf = new Map<string, number>();
  groups.forEach((group, at) => {
    for (const member of group.members) groupOf.set(member, at);
  });
  const waiting = groups.map(() => 0);
  const dependents = groups.map((): number[] => []);
  groups.forEach((group, at) => {
    const needs = new Set<number>();
    for (const member of group.members)
      for (const target of edges.get(member) ?? []) {
        const other = groupOf.get(target)!;
        if (other !== at) needs.add(other);
      }
    waiting[at] = needs.size;
    for (const other of needs) dependents[other]!.push(at);
  });

  const ready = groups.flatMap((_, at) => (waiting[at] === 0 ? [at] : []));
  const order: P[] = [];
  const cycles: P[][] = [];
  while (ready.length > 0) {
    let best = 0;
    for (let at = 1; at < ready.length; at += 1)
      if (groups[ready[at]!]!.key < groups[ready[best]!]!.key) best = at;
    const chosen = ready.splice(best, 1)[0]!;
    const group = groups[chosen]!;
    order.push(...group.runs);
    if (group.runs.length > 1) cycles.push(group.runs);
    for (const other of dependents[chosen]!) {
      waiting[other] = waiting[other]! - 1;
      if (waiting[other] === 0) ready.push(other);
    }
  }
  return { order, cycles };
}

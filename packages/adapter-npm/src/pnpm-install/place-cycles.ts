/**
 * Which importers reach packages that need each other (ADR 0055 §9).
 *
 * Instances that depend on one another, directly or through a chain (a host
 * and its plugin, which peers the host), cannot all be written as high as
 * their peers allow when more than one version of them is wanted: each copy
 * nested beside its dependent is shadowed by the one above it. An importer
 * that keeps all it needs in its own `node_modules` has one copy of each name
 * there, which a cycle cannot split, so those are the importers worth keeping
 * to themselves when sharing does not work.
 */

import type { PlaceInput } from './place-types.js';

/** Instances in a strongly connected component of more than one instance, or that need themselves (Tarjan, without recursion). */
export function cyclicInstances(input: PlaceInput): Set<string> {
  const { instances } = input;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cyclic = new Set<string>();
  let counter = 0;
  for (const root of instances.keys()) {
    if (index.has(root)) continue;
    const work: { key: string; next: number }[] = [{ key: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work.at(-1)!;
      const edges = instances.get(frame.key)!.edges;
      if (frame.next < edges.length) {
        const to = edges[frame.next]!.to;
        frame.next += 1;
        if (to === frame.key) cyclic.add(to);
        if (!instances.has(to)) continue;
        if (!index.has(to)) {
          index.set(to, counter);
          low.set(to, counter);
          counter += 1;
          stack.push(to);
          onStack.add(to);
          work.push({ key: to, next: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.key, Math.min(low.get(frame.key)!, index.get(to)!));
        }
        continue;
      }
      work.pop();
      const parent = work.at(-1);
      if (parent !== undefined)
        low.set(
          parent.key,
          Math.min(low.get(parent.key)!, low.get(frame.key)!),
        );
      if (low.get(frame.key) === index.get(frame.key)) {
        const component: string[] = [];
        for (let key = stack.pop()!; ; key = stack.pop()!) {
          onStack.delete(key);
          component.push(key);
          if (key === frame.key) break;
        }
        if (component.length > 1) for (const key of component) cyclic.add(key);
      }
    }
  }
  return cyclic;
}

/** The members (by directory) whose dependencies, followed to the end, include an instance that is in a cycle. */
export function cyclicImporters(input: PlaceInput): Set<string> {
  const cyclic = cyclicInstances(input);
  const out = new Set<string>();
  if (cyclic.size === 0) return out;
  for (const top of input.tops) {
    if (top.dir === '') continue;
    const seen = new Set<string>();
    const pending = top.edges.map((edge) => edge.to);
    for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
      if (seen.has(key) || !input.instances.has(key)) continue;
      seen.add(key);
      if (cyclic.has(key)) {
        out.add(top.dir);
        break;
      }
      for (const edge of input.instances.get(key)!.edges) pending.push(edge.to);
    }
  }
  return out;
}

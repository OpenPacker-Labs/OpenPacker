import { WorkspaceError } from './errors.js';
import type { WorkspaceEdge, WorkspaceGraph } from './graph.js';
import { DEPENDENCY_FIELDS, type DependencyField } from './manifest.js';
import { compareText } from './names.js';
import { describeMember } from './members.js';

/** The lists whose members must exist at run time; `devDependencies` is the one that does not. */
export const RUNTIME_FIELDS: readonly DependencyField[] = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
];

export interface WalkOptions {
  /** Which lists count. All four, as pnpm orders by, when absent. */
  readonly fields?: readonly DependencyField[];
}

function counted(
  edges: readonly WorkspaceEdge[],
  options: WalkOptions,
): readonly WorkspaceEdge[] {
  const fields = options.fields ?? DEPENDENCY_FIELDS;
  return fields.length === DEPENDENCY_FIELDS.length
    ? edges
    : edges.filter((edge) => fields.includes(edge.field));
}

function reach(
  start: string,
  next: (dir: string) => readonly string[],
  transitive: boolean,
): string[] {
  const seen = new Set<string>();
  const queue = [...next(start)];
  for (let head = 0; head < queue.length; head += 1) {
    const dir = queue[head]!;
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (transitive) queue.push(...next(dir));
  }
  return [...seen].sort(compareText);
}

export interface ReachOptions extends WalkOptions {
  /** Follow dependencies of dependencies. Direct ones only when false. */
  readonly transitive?: boolean;
}

/** The directories of the members `dir` depends on, in code-unit order. A member in a cycle with itself is its own dependency. */
export function dependenciesOf(
  graph: WorkspaceGraph,
  dir: string,
  options: ReachOptions = {},
): readonly string[] {
  return reach(
    dir,
    (at) => counted(graph.outgoing.get(at) ?? [], options).map((e) => e.to),
    options.transitive ?? false,
  );
}

/** The directories of the members that depend on `dir`, in code-unit order. */
export function dependentsOf(
  graph: WorkspaceGraph,
  dir: string,
  options: ReachOptions = {},
): readonly string[] {
  return reach(
    dir,
    (at) => counted(graph.incoming.get(at) ?? [], options).map((e) => e.from),
    options.transitive ?? false,
  );
}

/** Strongly connected components (Tarjan, iterative: a chain of thousands must not overflow the stack). */
function components(
  nodes: readonly string[],
  successors: (dir: string) => readonly string[],
): string[][] {
  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (indexOf.has(root)) continue;
    const work: { node: string; next: string[] }[] = [];
    const enter = (node: string) => {
      indexOf.set(node, counter);
      lowlink.set(node, counter);
      counter += 1;
      stack.push(node);
      onStack.add(node);
      work.push({ node, next: [...successors(node)] });
    };
    enter(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const child = frame.next.shift();
      if (child !== undefined) {
        if (!indexOf.has(child)) enter(child);
        else if (onStack.has(child))
          lowlink.set(
            frame.node,
            Math.min(lowlink.get(frame.node)!, indexOf.get(child)!),
          );
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined)
        lowlink.set(
          parent.node,
          Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!),
        );
      if (lowlink.get(frame.node) === indexOf.get(frame.node)) {
        const component: string[] = [];
        let member: string | undefined;
        do {
          member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        found.push(component.sort(compareText));
      }
    }
  }
  return found;
}

export interface WorkspaceCycle {
  /** The members that depend on each other, in code-unit order. */
  readonly members: readonly string[];
  /** One way round, `a -> b -> a`, by member directory. */
  readonly path: readonly string[];
  /** Whether the members still depend on each other without `devDependencies`. */
  readonly runtime: boolean;
}

/** A shortest way from the first member back to itself, staying inside the component. */
function wayRound(
  members: readonly string[],
  successors: (dir: string) => readonly string[],
): string[] {
  const inside = new Set(members);
  const start = members[0]!;
  const parent = new Map<string, string>();
  const seen = new Set([start]);
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const at = queue[head]!;
    for (const next of successors(at)) {
      if (!inside.has(next)) continue;
      if (next === start) {
        const path = [at];
        for (let step = at; step !== start; ) {
          step = parent.get(step)!;
          path.push(step);
        }
        return [...path.reverse(), start];
      }
      if (!seen.has(next)) {
        seen.add(next);
        parent.set(next, at);
        queue.push(next);
      }
    }
  }
  return [start];
}

export type CycleMode = 'error' | 'tolerate';

export interface OrderOptions extends WalkOptions {
  /**
   * What a cycle does. Required, because the two tools differ and neither is a
   * default for the other: `tolerate` is pnpm's (it warns, runs the members of
   * a cycle together and goes on; `--disallow-workspace-cycles` is `error`),
   * `error` refuses with the members named. npm does not order at all.
   */
  readonly cycles: CycleMode;
  /** Order only these members (directories); all of them when absent. */
  readonly among?: readonly string[];
}

export interface WorkspaceOrder {
  /** Every ordered member, each after the members it depends on. */
  readonly order: readonly string[];
  /**
   * The same members in layers: a member is in the first layer after all that
   * it depends on, so a layer holds members that do not depend on each other,
   * and the members of one cycle share a layer. Code-unit order within a layer.
   */
  readonly chunks: readonly (readonly string[])[];
  readonly cycles: readonly WorkspaceCycle[];
}

/**
 * A dependency order of the workspace. A cycle among the counted lists is an
 * error or a reported group, as `options.cycles` says. `devDependencies` are
 * counted unless `fields` leaves them out; a cycle that only they close is
 * reported with `runtime: false`.
 */
export function topologicalOrder(
  graph: WorkspaceGraph,
  options: OrderOptions,
): WorkspaceOrder {
  const nodes = [...(options.among ?? graph.members.map((m) => m.dir))].sort(
    compareText,
  );
  const present = new Set(nodes);
  const successors = (fields: WalkOptions) => (dir: string) =>
    counted(graph.outgoing.get(dir) ?? [], fields)
      .map((edge) => edge.to)
      .filter((to) => present.has(to));
  const forward = successors(options);
  const groups = components(nodes, forward);
  const cyclic = groups.filter((group) => group.length > 1);
  const runtimeGroups = components(
    nodes,
    successors({
      fields: (options.fields ?? DEPENDENCY_FIELDS).filter((field) =>
        RUNTIME_FIELDS.includes(field),
      ),
    }),
  ).filter((group) => group.length > 1);
  const cycles: WorkspaceCycle[] = cyclic
    .map((members) => ({
      members,
      path: wayRound(members, forward),
      runtime: runtimeGroups.some((group) =>
        group.every((dir) => members.includes(dir)),
      ),
    }))
    .sort((a, b) => compareText(a.members[0]!, b.members[0]!));
  if (cycles.length > 0 && options.cycles === 'error') {
    const named = (dir: string) =>
      describeMember(graph.index.byDir.get(dir) ?? { dir, name: undefined });
    throw new WorkspaceError(
      'WORKSPACE_CYCLE',
      `There are cyclic workspace dependencies: ${cycles
        .map((cycle) => cycle.path.map(named).join(' -> '))
        .join('; ')}`,
      cycles.flatMap((cycle) => cycle.members),
    );
  }
  // Layers over the condensed graph: a component waits for every component it depends on.
  const groupOf = new Map<string, number>();
  groups.forEach((group, at) => group.forEach((dir) => groupOf.set(dir, at)));
  const needs = groups.map(
    (group) =>
      new Set(
        group.flatMap((dir) =>
          forward(dir)
            .map((to) => groupOf.get(to)!)
            .filter((other) => groupOf.get(dir) !== other),
        ),
      ),
  );
  const remaining = needs.map((set) => set.size);
  const waiting = groups.map(() => [] as number[]);
  needs.forEach((set, at) => set.forEach((need) => waiting[need]!.push(at)));
  const chunks: string[][] = [];
  let layer = groups.map((_, at) => at).filter((at) => remaining[at] === 0);
  while (layer.length > 0) {
    chunks.push(layer.flatMap((at) => groups[at]!).sort(compareText));
    const following: number[] = [];
    for (const at of layer)
      for (const next of waiting[at]!) {
        remaining[next] = remaining[next]! - 1;
        if (remaining[next] === 0) following.push(next);
      }
    layer = following;
  }
  return { order: chunks.flat(), chunks, cycles };
}

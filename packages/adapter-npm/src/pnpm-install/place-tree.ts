/**
 * The tree a pnpm lock's places are planned on (ADR 0055 §9): one node for each
 * top and each placed instance, and Node's lookup over it.
 *
 * A node's `children` are the names in its `node_modules`. What an edge finds
 * is the first node that holds its name, from the dependent's own
 * `node_modules` up. Once an edge is answered somewhere above its dependent,
 * every `node_modules` it looked in on the way is `passed` for that name: a
 * copy written in one of them later would answer that edge instead, so none is.
 */

export interface Node {
  /** The instance; absent for a top and for a member link. */
  readonly key: string | undefined;
  readonly parent: Node | undefined;
  readonly children: Map<string, Node>;
  /** The member whose `node_modules` the chain starts in; `''` for the project's. */
  readonly base: string;
  readonly chain: readonly string[];
  readonly installName: string;
  readonly entry: { name: string; version: string; label?: string };
  readonly direct: boolean;
  /** Names an answered edge looked for here and found further up. */
  readonly passed: Set<string>;
}

/** The node Node finds `name` at from `from`, walking up as it does. */
export function lookup(from: Node, name: string): Node | undefined {
  for (let at: Node | undefined = from; at !== undefined; at = at.parent) {
    const hit = at.children.get(name);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Record that `from`'s edge for `name` is answered in `holder`'s
 * `node_modules`: every `node_modules` from `from`'s own up to `holder`'s,
 * not counting `holder`'s, may no longer take that name.
 */
export function settle(from: Node, name: string, holder: Node): void {
  for (
    let at: Node | undefined = from;
    at !== undefined && at !== holder;
    at = at.parent
  )
    at.passed.add(name);
}

/** A top's node: the project's (`dir` empty) or a member's. */
export function topNode(dir: string, parent: Node | undefined): Node {
  return {
    key: undefined,
    parent,
    children: new Map(),
    base: dir,
    chain: [],
    installName: '',
    entry: { name: dir === '' ? '(project)' : dir, version: '' },
    direct: false,
    passed: new Set(),
  };
}

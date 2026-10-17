/**
 * Where each instance of a pnpm lock goes in `node_modules` (ADR 0055 §8 to
 * §11).
 *
 * An npm lock records a place for every package, because arborist chose it when
 * npm wrote the lock. A pnpm lock records only what each package needs, so the
 * places are chosen here, once, the way the closure planner chooses them
 * (`layout-plan.ts`), for several tops instead of one:
 *
 * - a top's direct dependencies live in the top's own `node_modules`, the
 *   project's for the project (`.`), a member's for a member;
 * - everything else is placed breadth first: if Node already finds the wanted
 *   instance from where the dependent lives, nothing is written; if it finds
 *   another instance of that name, the wanted one is nested beside the
 *   dependent; if it finds nothing, the instance of that name the most
 *   packages want goes to the project's `node_modules` and any other beside its
 *   dependent;
 * - a member link takes `node_modules/<member name>` in the project;
 * - a member nested inside another member's directory looks in that member's
 *   `node_modules` before the project's, as Node does.
 *
 * Pure. `place-check.ts` resolves every edge on the result with Node's lookup
 * and is how a plan is proved.
 */

import { compareText, compareVersions } from '../layout-compare.js';
import {
  caseCollision,
  caseVariant,
  unsafeNameProblem,
} from '../layout-names.js';
import {
  LayoutTooLargeError,
  MAXIMUM_PLACEMENTS,
} from '../layout-plan-types.js';
import { quote } from './quote.js';

/** What the planner needs of an instance. */
export interface PlaceInstance {
  readonly key: string;
  /** The package's own name. */
  readonly name: string;
  readonly version: string;
  /** Edges to instances of the plan only: the install name and the instance. */
  readonly edges: readonly { readonly as: string; readonly to: string }[];
}

/** An importer the plan installs. */
export interface PlaceTop {
  readonly id: string;
  /** `''` for the project. */
  readonly dir: string;
  readonly edges: readonly { readonly as: string; readonly to: string }[];
  /** Members it links, by the name it finds them by. */
  readonly links: readonly {
    readonly as: string;
    readonly memberDir: string;
  }[];
}

export interface PlaceInput {
  readonly instances: ReadonlyMap<string, PlaceInstance>;
  /** The project first when it is installed, then the members. */
  readonly tops: readonly PlaceTop[];
  readonly maximumPlacements?: number;
}

/** One instance at one place. */
export interface PlacedInstance {
  readonly key: string;
  /** The member whose `node_modules` the chain starts in; `''` for the project's. */
  readonly base: string;
  /** Install names from that `node_modules` down. */
  readonly chain: readonly string[];
  /** A direct dependency of the top whose `node_modules` it is in. */
  readonly direct: boolean;
}

export interface PlacedLink {
  /** The name it takes in the project's `node_modules`. */
  readonly name: string;
  readonly memberDir: string;
}

export interface Placement {
  readonly placed: readonly PlacedInstance[];
  readonly links: readonly PlacedLink[];
  /** Things that cannot be laid out; any one stops the install. */
  readonly problems: readonly string[];
}

/** The deepest `node_modules` chain a plan may hold. Real locks stay far under it. */
export const MAXIMUM_DEPTH = 32;

interface Node {
  readonly key: string | undefined;
  readonly parent: Node | undefined;
  readonly children: Map<string, Node>;
  readonly base: string;
  readonly chain: readonly string[];
  readonly installName: string;
  readonly entry: { name: string; version: string; label?: string };
  readonly direct: boolean;
}

/** The member directories that enclose `dir`, nearest first (never `dir`, never the project). */
export function enclosingDirs(
  dir: string,
  members: ReadonlySet<string>,
): string[] {
  const segments = dir.split('/');
  const out: string[] = [];
  for (let length = segments.length - 1; length > 0; length -= 1) {
    const candidate = segments.slice(0, length).join('/');
    if (members.has(candidate)) out.push(candidate);
  }
  return out;
}

/** An instance's edges in the order they are placed: a package under its own name before an alias. */
function orderedEdges(
  instance: PlaceInstance,
  instances: ReadonlyMap<string, PlaceInstance>,
): readonly { as: string; to: string }[] {
  const aliased = (edge: { as: string; to: string }): number =>
    Number(instances.get(edge.to)?.name !== edge.as);
  return [...instance.edges].sort(
    (left, right) =>
      aliased(left) - aliased(right) ||
      compareText(left.as, right.as) ||
      compareText(left.to, right.to),
  );
}

/**
 * The instance of each install name that earns the project's `node_modules`:
 * the one the most instances need under that name, then the newest, then the
 * smaller key.
 */
function rootChoice(
  instances: ReadonlyMap<string, PlaceInstance>,
): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const instance of instances.values())
    for (const edge of instance.edges) {
      const byTarget = counts.get(edge.as) ?? new Map<string, number>();
      counts.set(edge.as, byTarget);
      byTarget.set(edge.to, (byTarget.get(edge.to) ?? 0) + 1);
    }
  const choice = new Map<string, string>();
  for (const [as, byTarget] of counts) {
    const best = [...byTarget].sort(
      ([leftKey, left], [rightKey, right]) =>
        right - left ||
        compareVersions(
          instances.get(rightKey)?.version ?? '',
          instances.get(leftKey)?.version ?? '',
        ) ||
        compareText(leftKey, rightKey),
    )[0];
    if (best !== undefined) choice.set(as, best[0]);
  }
  return choice;
}

export function planPlacement(input: PlaceInput): Placement {
  const { instances } = input;
  const maximum = input.maximumPlacements ?? MAXIMUM_PLACEMENTS;
  const problems: string[] = [];
  const preferred = rootChoice(instances);
  const tops = new Map<string, Node>();
  const placed: Node[] = [];
  const queue: Node[] = [];
  const links = new Map<string, string>();

  const topNode = (dir: string, parent: Node | undefined): Node => ({
    key: undefined,
    parent,
    children: new Map(),
    base: dir,
    chain: [],
    installName: '',
    entry: { name: dir === '' ? '(project)' : dir, version: '' },
    direct: false,
  });
  const project = topNode('', undefined);
  tops.set('', project);
  const memberDirs = new Set(
    input.tops.map((top) => top.dir).filter((dir) => dir !== ''),
  );
  for (const top of [...input.tops].sort(
    (a, b) =>
      a.dir.split('/').length - b.dir.split('/').length ||
      compareText(a.dir, b.dir),
  ))
    if (top.dir !== '') {
      const outer = enclosingDirs(top.dir, memberDirs)[0];
      tops.set(
        top.dir,
        topNode(top.dir, outer === undefined ? project : tops.get(outer)),
      );
    }

  const tooDeep = new Set<string>();
  const place = (
    parent: Node,
    instance: PlaceInstance,
    name: string,
    direct: boolean,
  ): void => {
    if (placed.length >= maximum) throw new LayoutTooLargeError(maximum);
    // Two versions of two packages that need each other have no finite tree:
    // each copy nested beside its dependent is shadowed by the one above it.
    // pnpm writes that with symlinks, which a node_modules without them cannot.
    if (parent.chain.length >= MAXIMUM_DEPTH) {
      if (!tooDeep.has(instance.key) && tooDeep.size < 10)
        problems.push(
          `${quote(instance.key)} would sit more than ${MAXIMUM_DEPTH} directories deep: packages that need each other at different versions cannot be laid out as a tree without symlinks`,
        );
      tooDeep.add(instance.key);
      return;
    }
    const node: Node = {
      key: instance.key,
      parent,
      children: new Map(),
      base: parent.base,
      chain: [...parent.chain, name],
      installName: name,
      entry: { name: instance.name, version: instance.version },
      direct,
    };
    parent.children.set(name, node);
    placed.push(node);
    queue.push(node);
  };
  const lookup = (from: Node, name: string): Node | undefined => {
    for (let at: Node | undefined = from; at !== undefined; at = at.parent) {
      const hit = at.children.get(name);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };
  const held = (node: Node): string =>
    node.key === undefined ? 'a link' : quote(node.key);
  const refuseName = (name: string, who: string): boolean => {
    const problem = unsafeNameProblem(name);
    if (problem === undefined) return false;
    problems.push(`${who} needs ${problem}`);
    return true;
  };

  // Round 0: links, then each top's own dependencies.
  for (const top of input.tops)
    for (const link of top.links) {
      if (refuseName(link.as, `${quote(top.id)}'s link`)) continue;
      const earlier = links.get(link.as);
      if (earlier !== undefined && earlier !== link.memberDir) {
        problems.push(
          `${quote(top.id)} links ${quote(link.memberDir)} as ${quote(link.as)}, which another importer links to ${quote(earlier)}; ${quote(`node_modules/${link.as}`)} cannot be both`,
        );
        continue;
      }
      links.set(link.as, link.memberDir);
    }
  for (const [name, memberDir] of links) {
    const earlier = project.children.get(name);
    if (earlier?.key !== undefined) continue;
    project.children.set(name, {
      key: undefined,
      parent: project,
      children: new Map(),
      base: '',
      chain: [name],
      installName: name,
      entry: {
        name,
        version: '',
        label: `the link to ${quote(memberDir)}`,
      },
      direct: false,
    });
  }
  for (const top of input.tops) {
    const node = tops.get(top.dir)!;
    for (const edge of top.edges) {
      const instance = instances.get(edge.to);
      if (instance === undefined || refuseName(edge.as, quote(top.id)))
        continue;
      const taken = node.children.get(edge.as);
      if (taken !== undefined) {
        if (taken.key !== edge.to)
          problems.push(
            taken.key === undefined
              ? `${quote(top.id)} needs ${quote(edge.as)} (${quote(edge.to)}), and ${quote(`node_modules/${edge.as}`)} is the link to a workspace member that another importer needs`
              : `${quote(top.id)} needs ${quote(edge.as)} twice, as ${quote(taken.key)} and ${quote(edge.to)}`,
          );
        continue;
      }
      const variant = caseVariant(node, edge.as);
      if (variant !== undefined) {
        problems.push(
          `${quote(top.id)}: ${caseCollision(instance, edge.as, variant)}`,
        );
        continue;
      }
      place(node, instance, edge.as, true);
    }
  }

  // Everything the placed instances need.
  for (let next = 0; next < queue.length; next += 1) {
    const node = queue[next]!;
    const instance = instances.get(node.key!)!;
    for (const { as, to } of orderedEdges(instance, instances)) {
      const wanted = instances.get(to);
      if (wanted === undefined || refuseName(as, quote(instance.key))) continue;
      const found = lookup(node, as);
      let where: Node;
      if (found === undefined) {
        const home = preferred.get(as) === to ? project : node;
        where = caseVariant(home, as) === undefined ? home : node;
      } else if (found.key === to) continue;
      else where = node;
      const variant = caseVariant(where, as);
      if (variant !== undefined) {
        problems.push(
          `${quote(instance.key)}: ${caseCollision(wanted, as, variant)}`,
        );
        continue;
      }
      if (where.children.has(as)) {
        problems.push(
          `${quote(instance.key)} needs ${quote(as)} as ${quote(to)}, and its own node_modules already holds ${held(where.children.get(as)!)} under that name`,
        );
        continue;
      }
      place(where, wanted, as, false);
    }
  }

  return {
    placed: placed
      .map((node) => ({
        key: node.key!,
        base: node.base,
        chain: node.chain,
        direct: node.direct,
      }))
      .sort(
        (left, right) =>
          left.chain.length - right.chain.length ||
          compareText(left.base, right.base) ||
          compareText(left.chain.join('\0'), right.chain.join('\0')),
      ),
    links: [...links]
      .map(([name, memberDir]) => ({ name, memberDir }))
      .sort((left, right) => compareText(left.name, right.name)),
    problems,
  };
}

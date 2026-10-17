/**
 * Workspace-member links in a layout plan.
 *
 * ADR 0048 keeps symlinks out of `node_modules`; ADR 0050 allows one kind, a
 * link from a workspace member's name to the member's own directory. The plan
 * carries those links beside the packages and refuses, before anything is
 * written, every shape that would let the exception grow:
 *
 * - a link's place and text meet the rules in `@openpacker/project-io`
 *   (`memberLinkProblem`): a `node_modules` directory or a scope in one, one
 *   package directory name, a relative target that stays inside the project and
 *   is not under `node_modules`;
 * - the `node_modules` directory it sits in is one the plan owns: the root's, or
 *   that of a package the plan places;
 * - no link is inside another, and no two share a place;
 * - a link never takes the place of a package the plan installs, and no package
 *   is installed where a link would carry it into a member's directory.
 *
 * Pure: nothing is read or written here.
 */

import { memberLinkProblem } from '@openpacker/project-io';
import type { Placement } from './layout-plan.js';

/** One member link: where it goes and what it says, both relative. */
export interface LayoutLink {
  /**
   * Project-root relative, as a lock spells a place: `node_modules/name`,
   * `node_modules/@scope/name`, or the same inside a package's own
   * `node_modules`.
   */
  path: string;
  /** The text of the link, relative to its directory: `../../packages/name`. */
  target: string;
}

/** Links that cannot be laid out as asked. */
export class LayoutLinksError extends Error {
  readonly code = 'LAYOUT_LINKS_INVALID';
  constructor(readonly problems: readonly string[]) {
    super(
      `The workspace links cannot be written as asked: ${problems.slice(0, 10).join('; ')}${problems.length > 10 ? `; and ${problems.length - 10} more` : ''}`,
    );
    this.name = 'LayoutLinksError';
  }
}

/**
 * `['b', 'c']` is `node_modules/b/node_modules/c`; under a workspace member
 * (`base`, its directory) the same chain starts in the member's own
 * `node_modules`: `packages/x/node_modules/b/node_modules/c`.
 */
export function placePath(chain: readonly string[], base = ''): string {
  return `${base === '' ? '' : `${base}/`}node_modules/${chain.join('/node_modules/')}`;
}

/**
 * The package directory names from the project down for a place such as
 * `node_modules/@s/a/node_modules/b`: `['@s/a', 'b']`. Undefined when the path
 * is not a clean sequence of `node_modules/<name>` pairs.
 */
export function chainOfPlace(path: string): string[] | undefined {
  const segments = path.split('/');
  const chain: string[] = [];
  let at = 0;
  while (at < segments.length) {
    if (segments[at] !== 'node_modules') return undefined;
    const first = segments[at + 1];
    if (first === undefined) return undefined;
    if (first.startsWith('@')) {
      const second = segments[at + 2];
      if (second === undefined) return undefined;
      chain.push(`${first}/${second}`);
      at += 3;
    } else {
      chain.push(first);
      at += 2;
    }
  }
  return chain;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The links of a plan, checked against the packages it places and returned in
 * path order. Throws {@link LayoutLinksError} naming every problem found.
 */
export function checkLayoutLinks(
  links: readonly LayoutLink[],
  placements: readonly Pick<Placement, 'chain' | 'base'>[],
): readonly LayoutLink[] {
  if (links.length === 0) return [];
  const problems: string[] = [];
  const placed = new Set(
    placements.map((place) => placePath(place.chain, place.base)),
  );
  const seen = new Set<string>();
  const valid: LayoutLink[] = [];
  for (const link of links) {
    const problem = memberLinkProblem(link.path, link.target);
    if (problem !== undefined) {
      problems.push(`${link.path}: ${problem}`);
      continue;
    }
    if (seen.has(link.path)) {
      problems.push(`${link.path} is linked twice`);
      continue;
    }
    seen.add(link.path);
    const chain = chainOfPlace(link.path);
    if (chain === undefined) {
      problems.push(`${link.path} is not a place under node_modules`);
      continue;
    }
    const owner = chain.slice(0, -1);
    if (owner.length > 0 && !placed.has(placePath(owner)))
      problems.push(
        `${link.path} sits in the node_modules of ${owner.join(' > ')}, which the plan does not install`,
      );
    if (placed.has(link.path))
      problems.push(
        `${link.path} would replace the package the plan installs there`,
      );
    valid.push(link);
  }
  const linked = new Set(valid.map((link) => link.path));
  // Every place on the way down to a link or a package, nearest the root first.
  const enclosing = (chain: readonly string[], base = ''): string[] =>
    chain
      .slice(0, -1)
      .map((_, index) => placePath(chain.slice(0, index + 1), base));
  for (const link of valid) {
    const chain = chainOfPlace(link.path)!;
    for (const outer of enclosing(chain))
      if (linked.has(outer))
        problems.push(`${link.path} is inside the link ${outer}`);
  }
  for (const place of placements)
    for (const outer of enclosing(place.chain, place.base))
      if (linked.has(outer))
        problems.push(
          `the package at ${placePath(place.chain, place.base)} would be written through the link ${outer}`,
        );
  if (problems.length > 0) throw new LayoutLinksError(problems);
  return [...valid].sort((left, right) => compareText(left.path, right.path));
}

/**
 * The text of a link from `path` to a member at `memberPath` (project-root
 * relative, `/`-separated), as a lock gives the member's place: the relative
 * path from the link's directory.
 */
export function linkTargetBetween(path: string, memberPath: string): string {
  const from = path.split('/').slice(0, -1);
  const to = memberPath
    .split('/')
    .filter((part) => part !== '' && part !== '.');
  let shared = 0;
  while (
    shared < from.length &&
    shared < to.length &&
    from[shared] === to[shared]
  )
    shared += 1;
  return [...from.slice(shared).map(() => '..'), ...to.slice(shared)].join('/');
}

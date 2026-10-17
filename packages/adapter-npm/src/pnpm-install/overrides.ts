/**
 * `overrides` as they apply to an importer's own `package.json` (ADR 0055 §18).
 *
 * pnpm applies a project's overrides to every manifest it reads, the
 * workspace's importers included, before it compares their specifiers with the
 * lock. So an importer that asks for `ts-autocode-grounding@0.1.0` has
 * `workspace:*` in the lock when the root says
 * `"ts-autocode-grounding": "workspace:*"`. A frozen install applies no
 * override to what it installs (the lock already holds the result); this
 * applies them to the importers' manifests, to know what the lock should say.
 *
 * This is pnpm 10's own procedure (`createVersionsOverrider` in
 * `@pnpm/hooks.read-package-hook`): `parent>name` selectors whose parent is the
 * importer (its range satisfied by the importer's version) before plain ones; a
 * `name@range` selector applies when its range intersects the dependency's
 * (`ranges.ts`); of several that apply, the one pnpm's own comparator sorts
 * first, sorted here the same way on the same engine; `-` drops the
 * dependency; a `file:` or `link:` replacement is made relative to the
 * importer; and a peer is overridden too, moving to `dependencies` when the
 * replacement is not a peer range. Every range is read as node-semver reads
 * it, as pnpm does, so there is no range whose override is left in doubt.
 */

import { posix } from 'node:path';
import type { ManifestLists } from './fresh.js';
import { isRange, overrideRangeApplies, versionSatisfies } from './ranges.js';

interface Selector {
  readonly parent?: { readonly name: string; readonly range?: string };
  readonly name: string;
  readonly range?: string;
}

/** `name`, `name@range`, `@scope/name`, `@scope/name@range`. */
function named(text: string): { name: string; range?: string } {
  const at = text.indexOf('@', 1);
  return at === -1
    ? { name: text }
    : { name: text.slice(0, at), range: text.slice(at + 1) };
}

/**
 * `parent>name` is split as pnpm splits it (`parsePkgAndParentSelector`): at
 * the first `>` that follows neither a space, a `|` nor an `@`, so a range such
 * as `name@>1` or `name@1 || >2` stays the target's.
 */
export function parseSelector(text: string): Selector {
  const before = text.search(/[^ |@]>/u);
  if (before === -1) return named(text);
  return {
    ...named(text.slice(before + 2)),
    parent: named(text.slice(0, before + 1)),
  };
}

/** The importer the overrides are applied to. */
export interface OverrideTarget {
  readonly name?: string;
  readonly version?: string;
  /** Its directory relative to the project, `''` for the project. */
  readonly dir?: string;
}

interface Override {
  readonly text: string;
  readonly selector: Selector;
  readonly value: string;
}

type MutableLists = {
  -readonly [K in keyof ManifestLists]: Map<string, string>;
};

/** pnpm's `pickMostSpecificVersionOverride`: its comparator, its sort. */
function mostSpecific(candidates: readonly Override[]): Override | undefined {
  return [...candidates].sort((a, b) =>
    overrideRangeApplies(b.selector.range ?? '', a.selector.range ?? '')
      ? -1
      : 1,
  )[0];
}

/**
 * Where the project is, for a relative path: deep enough that no path in a
 * manifest climbs above it, so the relative path between two places under it
 * is the one between the real directories.
 */
const PROJECT = `/${Array.from({ length: 256 }, () => 'p').join('/')}`;

/** A `file:` or `link:` replacement, relative to the importer as pnpm writes it. */
function replacementFor(value: string, dir: string): string {
  const protocol = ['file:', 'link:'].find((p) => value.startsWith(p));
  if (protocol === undefined) return value;
  const path = value.slice(protocol.length);
  if (posix.isAbsolute(path)) return value;
  return `${protocol}${posix.relative(posix.join(PROJECT, dir), posix.join(PROJECT, path))}`;
}

/** pnpm's `isValidPeerRange`. */
const isPeerRange = (value: string): boolean =>
  value.includes('workspace:') || value.includes('catalog:') || isRange(value);

/** `manifest` with the overrides that apply to it applied, as pnpm applies them to `importer`. */
export function applyOverrides(
  manifest: ManifestLists,
  overrides: ReadonlyMap<string, string>,
  importer: OverrideTarget,
): ManifestLists {
  if (overrides.size === 0) return manifest;
  // pnpm keeps them in an object: its key order, integer-like keys first.
  const all: Override[] = Object.entries(Object.fromEntries(overrides)).map(
    ([text, value]) => ({ text, selector: parseSelector(text), value }),
  );
  const parentRangeHolds = (range: string | undefined): boolean =>
    range === undefined ||
    range === '' ||
    versionSatisfies(importer.version ?? '', range);
  const scoped = all.filter(
    ({ selector }) =>
      selector.parent !== undefined &&
      selector.parent.name === importer.name &&
      parentRangeHolds(selector.parent.range),
  );
  const plain = all.filter(({ selector }) => selector.parent === undefined);
  const applying = (
    group: readonly Override[],
    name: string,
    specifier: string,
  ) =>
    group.filter(
      ({ selector }) =>
        selector.name === name &&
        overrideRangeApplies(selector.range, specifier),
    );
  const pick = (name: string, specifier: string) =>
    mostSpecific(applying(scoped, name, specifier)) ??
    mostSpecific(applying(plain, name, specifier));

  const lists: MutableLists = {
    dependencies: new Map(manifest.dependencies),
    devDependencies: new Map(manifest.devDependencies),
    optionalDependencies: new Map(manifest.optionalDependencies),
    peerDependencies: new Map(manifest.peerDependencies),
  };
  const dir = importer.dir ?? '';
  // Changing or deleting the entry being visited leaves a Map's iteration intact.
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'devDependencies',
  ] as const)
    for (const [name, specifier] of lists[field]) {
      const hit = pick(name, specifier);
      if (hit === undefined) continue;
      if (hit.value === '-') lists[field].delete(name);
      else lists[field].set(name, replacementFor(hit.value, dir));
    }
  for (const [name, specifier] of lists.peerDependencies) {
    const hit = pick(name, specifier);
    if (hit === undefined) continue;
    const value = replacementFor(hit.value, dir);
    if (hit.value === '-') lists.peerDependencies.delete(name);
    else if (isPeerRange(value)) lists.peerDependencies.set(name, value);
    else lists.dependencies.set(name, value);
  }
  return lists;
}

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
 * Read: `name`, `name@range`, and `parent>name` (the parent being the
 * importer itself), with a replacement that is a specifier, `-` to drop the
 * dependency, or `$other` (resolved before they get here). A `name@range`
 * selector applies when the dependency asks for exactly that range. That is
 * narrower than pnpm, which also applies it when the two ranges intersect, so
 * a lock written under an intersecting override is called stale where pnpm
 * would not.
 */

import type { ManifestLists } from './fresh.js';

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

export function parseSelector(text: string): Selector {
  const cut = text.lastIndexOf('>');
  const target = named(cut === -1 ? text : text.slice(cut + 1));
  return cut === -1 ? target : { ...target, parent: named(text.slice(0, cut)) };
}

type MutableLists = {
  -readonly [K in keyof ManifestLists]: Map<string, string>;
};

/**
 * `manifest` with the overrides that apply to it applied. `importer` is the
 * importer's own name and version, for a `parent>name` selector.
 */
export function applyOverrides(
  manifest: ManifestLists,
  overrides: ReadonlyMap<string, string>,
  importer: { readonly name?: string; readonly version?: string },
): ManifestLists {
  if (overrides.size === 0) return manifest;
  const selectors = [...overrides].map(
    ([text, value]) => [parseSelector(text), value] as const,
  );
  const lists: MutableLists = {
    dependencies: new Map(manifest.dependencies),
    devDependencies: new Map(manifest.devDependencies),
    optionalDependencies: new Map(manifest.optionalDependencies),
    peerDependencies: new Map(manifest.peerDependencies),
  };
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
  ] as const)
    for (const [name, specifier] of lists[field]) {
      const hit = selectors.find(([selector]) => {
        if (selector.name !== name) return false;
        if (selector.range !== undefined && selector.range !== specifier)
          return false;
        const parent = selector.parent;
        return (
          parent === undefined ||
          (parent.name === importer.name &&
            (parent.range === undefined || parent.range === importer.version))
        );
      });
      if (hit === undefined) continue;
      if (hit[1] === '-') lists[field].delete(name);
      else lists[field].set(name, hit[1]);
    }
  return lists;
}

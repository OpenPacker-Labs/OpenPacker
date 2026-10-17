/**
 * Is the lock the one the project's files would write? (ADR 0055 §18)
 *
 * `pnpm install --frozen-lockfile` refuses a lock that has gone stale, and so
 * does this, before anything is fetched. Each importer's specifiers are held to
 * its `package.json` by pnpm's own rule (`satisfiesPackageManifest`); the
 * lock's `overrides` and `catalogs` are held to what the project configures. A
 * frozen install installs what the lock says and applies none of them: this is
 * only the check that the lock says what the project does.
 *
 * Every function returns sentences, none throws, and the caller decides.
 */

import type { PnpmLock, PnpmImporter } from '../pnpm-lock/types.js';
import type { PnpmModel } from './model.js';
import { quote } from './quote.js';

/** The four dependency lists of a manifest. */
export interface ManifestLists {
  readonly dependencies: ReadonlyMap<string, string>;
  readonly devDependencies: ReadonlyMap<string, string>;
  readonly optionalDependencies: ReadonlyMap<string, string>;
  readonly peerDependencies: ReadonlyMap<string, string>;
}

type ListName = 'dependencies' | 'devDependencies' | 'optionalDependencies';

const LISTS: readonly ListName[] = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
];

/**
 * The list pnpm records each dependency of a manifest in: `optionalDependencies`
 * wins, then `dependencies`, then `devDependencies`; and with `autoInstallPeers`
 * a peer nobody lists is installed, as a `dependency`.
 */
function listsOf(
  manifest: ManifestLists,
  autoInstallPeers: boolean,
): Map<string, { list: ListName; specifier: string }> {
  const out = new Map<string, { list: ListName; specifier: string }>();
  if (autoInstallPeers)
    for (const [name, specifier] of manifest.peerDependencies)
      out.set(name, { list: 'dependencies', specifier });
  for (const list of [
    'devDependencies',
    'dependencies',
    'optionalDependencies',
  ] as const)
    for (const [name, specifier] of manifest[list])
      out.set(name, { list, specifier });
  return out;
}

/** How an importer's dependencies differ from its `package.json`, as sentences. */
export function importerProblems(
  id: string,
  manifest: ManifestLists,
  importer: PnpmImporter,
  autoInstallPeers: boolean,
): string[] {
  const where = id === '.' ? 'the project' : quote(id);
  const wanted = listsOf(manifest, autoInstallPeers);
  const recorded = new Map<string, { list: ListName; specifier: string }>();
  for (const list of LISTS)
    for (const dependency of importer[list])
      recorded.set(dependency.name, { list, specifier: dependency.specifier });
  const problems: string[] = [];
  for (const [name, want] of wanted) {
    const have = recorded.get(name);
    if (have === undefined)
      problems.push(
        `${where}: ${quote(name)} is in package.json (${want.list}) and not in pnpm-lock.yaml`,
      );
    else if (have.specifier !== want.specifier)
      problems.push(
        `${where}: ${quote(name)} is ${quote(want.specifier)} in package.json and ${quote(have.specifier)} in pnpm-lock.yaml`,
      );
    else if (have.list !== want.list)
      problems.push(
        `${where}: ${quote(name)} is in ${want.list} of package.json and in ${have.list} of pnpm-lock.yaml`,
      );
  }
  for (const name of recorded.keys())
    if (!wanted.has(name))
      problems.push(
        `${where}: ${quote(name)} is in pnpm-lock.yaml and not in package.json`,
      );
  return problems;
}

/** How the lock's `overrides` differ from the project's, as sentences. */
export function overrideProblems(
  lock: PnpmLock,
  project: ReadonlyMap<string, string>,
): string[] {
  const problems: string[] = [];
  for (const [selector, value] of project) {
    const have = lock.overrides.get(selector);
    if (have === undefined)
      problems.push(
        `the override ${quote(selector)} (${quote(value)}) is in the project and not in pnpm-lock.yaml`,
      );
    else if (have !== value)
      problems.push(
        `the override ${quote(selector)} is ${quote(value)} in the project and ${quote(have)} in pnpm-lock.yaml`,
      );
  }
  for (const selector of lock.overrides.keys())
    if (!project.has(selector))
      problems.push(
        `the override ${quote(selector)} is in pnpm-lock.yaml and not in the project`,
      );
  return problems;
}

/**
 * How the lock's `catalogs` differ from the project's. A lock records only the
 * entries something uses, so a catalog entry the project has and the lock lacks
 * is nothing; one the lock records must be the project's.
 */
export function catalogProblems(
  lock: PnpmLock,
  project: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string[] {
  const problems: string[] = [];
  for (const [catalog, entries] of lock.catalogs)
    for (const [name, entry] of entries) {
      const have = project.get(catalog)?.get(name);
      if (have === undefined)
        problems.push(
          `the catalog ${quote(catalog)} has ${quote(name)} (${quote(entry.specifier)}) in pnpm-lock.yaml and not in the project`,
        );
      else if (have !== entry.specifier)
        problems.push(
          `the catalog ${quote(catalog)} has ${quote(name)} as ${quote(have)} in the project and ${quote(entry.specifier)} in pnpm-lock.yaml`,
        );
    }
  return problems;
}

/**
 * A link is installed under the member's own name (ADR 0055 §11), so the name
 * a dependency links it by must be the name the member's `package.json` gives.
 */
export function linkNameProblems(
  model: PnpmModel,
  tops: ReadonlySet<string>,
  names: ReadonlyMap<string, string | undefined>,
): string[] {
  const problems: string[] = [];
  for (const id of tops)
    for (const edge of model.tops.get(id)?.edges ?? [])
      if (edge.kind === 'link' && edge.memberId !== undefined) {
        const dir = model.tops.get(edge.memberId)!.dir;
        const name = names.get(dir);
        if (name !== edge.as)
          problems.push(
            `${id === '.' ? 'the project' : quote(id)} links ${quote(dir)} as ${quote(edge.as)}, and the member there is ${name === undefined ? 'nameless' : `called ${quote(name)}`}: opm links a member under its own name only`,
          );
      }
  return problems;
}

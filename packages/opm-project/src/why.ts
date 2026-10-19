import { canonicalPurlOrSelf } from './catalog.js';
import { lockEdges } from './lock-edges.js';
import { LOCK_NAME, MANIFEST_NAME } from './paths.js';
import { purlPackageName, stripPurlVersion } from './spec.js';
import type { LockPackage, OpmLockfile, OpmManifest } from './types.js';
import { OpmError } from './types.js';

/**
 * Why a package is in the project, answered from the manifest and the lock.
 *
 * With several versions of one package and aliases, a name is not one entry, so
 * a question is answered per entry: a manifest alias, a lock key, a package
 * name or an install name all find entries, and each says what requires it and
 * under what name.
 */

/** Who requires an entry, and the install name when it is not the package's own. */
export interface Requirer {
  key: string;
  installName?: string;
}

export function requirersOf(lock: OpmLockfile, key: string): Requirer[] {
  const out: Requirer[] = [];
  for (const [from, pkg] of Object.entries(lock.packages))
    for (const edge of lockEdges(pkg))
      if (edge.key === key)
        out.push({
          key: from,
          ...(!(edge.installName === undefined) && {
            installName: edge.installName,
          }),
        });
  return out.sort((left, right) => (left.key < right.key ? -1 : 1));
}

/** The names an entry is installed under, other than its package's own. */
export function installedAs(lock: OpmLockfile, key: string): string[] {
  const names = new Set<string>();
  const own = lock.packages[key]?.installName;
  if (own !== undefined) names.add(own);
  for (const pkg of Object.values(lock.packages))
    for (const edge of lockEdges(pkg))
      if (edge.key === key && edge.installName !== undefined)
        names.add(edge.installName);
  return [...names].sort();
}

function packageName(pkg: LockPackage): string {
  return purlPackageName(stripPurlVersion(pkg.purl));
}

/**
 * A PURL as the lock spells it, whichever way the npm scope was typed
 * (`@vercel/sdk` or `%40vercel/sdk`); with `base`, without its version.
 */
function canonical(purl: string, base = false): string {
  return canonicalPurlOrSelf(base ? stripPurlVersion(purl) : purl);
}

/** The lock keys (and unlocked manifest aliases) a PURL names. */
function entriesForPurl(
  manifest: OpmManifest,
  lock: OpmLockfile | undefined,
  purl: string,
): string[] {
  const versioned = stripPurlVersion(purl) !== purl;
  const wanted = canonical(purl, !versioned);
  const keys = new Set<string>();
  for (const [key, pkg] of Object.entries(lock?.packages ?? {}))
    if (canonical(pkg.purl, !versioned) === wanted) keys.add(key);
  if (!versioned)
    for (const [alias, requirement] of Object.entries(manifest.packages))
      if (canonical(requirement.purl, true) === wanted) keys.add(alias);
  return [...keys].sort();
}

/**
 * The manifest alias `name` means: the alias itself, or the one direct
 * requirement a PURL names. Two requirements on one package (a plain one and
 * an `npm:` alias of it) cannot be told apart by the PURL, so that is refused.
 */
export function manifestAliasNamed(
  manifest: OpmManifest,
  name: string,
): string | undefined {
  if (manifest.packages[name] !== undefined) return name;
  if (!name.startsWith('pkg:')) return undefined;
  const wanted = canonical(name, true);
  const aliases = Object.entries(manifest.packages)
    .filter(([, requirement]) => canonical(requirement.purl, true) === wanted)
    .map(([alias]) => alias)
    .sort();
  if (aliases.length > 1)
    throw new OpmError(
      'AMBIGUOUS_SPEC',
      `${name} is ${aliases.length} requirements in ${MANIFEST_NAME} (${aliases.join(', ')}); name one by its alias`,
    );
  return aliases[0];
}

/** The lock keys a question about `name` is about. */
export function entriesNamed(
  manifest: OpmManifest,
  lock: OpmLockfile | undefined,
  name: string,
): string[] {
  if (manifest.packages[name] !== undefined) return [name];
  if (name.startsWith('pkg:')) return entriesForPurl(manifest, lock, name);
  if (lock === undefined) return [];
  if (lock.packages[name] !== undefined) return [name];
  return Object.entries(lock.packages)
    .filter(
      ([key, pkg]) =>
        packageName(pkg) === name || installedAs(lock, key).includes(name),
    )
    .map(([key]) => key)
    .sort();
}

/** One entry's explanation, in the words `opm why` has always used. */
export function explainEntry(
  manifest: OpmManifest,
  lock: OpmLockfile | undefined,
  key: string,
): string {
  const requirement = manifest.packages[key];
  const locked = lock?.packages[key];
  const lines: string[] = [];
  if (requirement !== undefined) {
    lines.push(
      `"${key}" is a direct dependency in ${MANIFEST_NAME}`,
      `  purl: ${requirement.purl}`,
    );
    if (requirement.installName !== undefined)
      lines.push(`  installed as: ${requirement.installName}`);
    if (requirement.version)
      lines.push(`  version constraint: ${requirement.version}`);
    if (requirement.source) lines.push(`  source: ${requirement.source}`);
    lines.push(
      locked
        ? `  locked: ${locked.purl} (${locked.digest})`
        : '  locked: (none)',
    );
  } else if (locked !== undefined) {
    lines.push(
      `"${key}" is in ${LOCK_NAME} as ${locked.reason} dependency`,
      `  ${locked.purl}`,
    );
  }
  if (lock !== undefined && locked !== undefined) {
    for (const requirer of requirersOf(lock, key)) {
      const by = lock.packages[requirer.key];
      lines.push(
        `  required by ${requirer.key}${by === undefined ? '' : ` (${by.purl})`}` +
          (requirer.installName === undefined
            ? ''
            : ` as ${requirer.installName}`),
      );
    }
  }
  return lines.join('\n');
}

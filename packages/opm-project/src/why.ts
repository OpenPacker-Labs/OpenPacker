import { plainLine } from '@openpacker/canonical';
import { lockEdges } from './lock-edges.js';
import { LOCK_NAME, MANIFEST_NAME } from './paths.js';
import { shownSource } from './shown-source.js';
import { purlPackageName, stripPurlVersion } from './spec.js';
import type { LockPackage, OpmLockfile, OpmManifest } from './types.js';

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

/** The lock keys a question about `name` is about. */
export function entriesNamed(
  manifest: OpmManifest,
  lock: OpmLockfile | undefined,
  name: string,
): string[] {
  if (manifest.packages[name] !== undefined) return [name];
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
      `"${plainLine(key)}" is a direct dependency in ${MANIFEST_NAME}`,
      `  purl: ${plainLine(requirement.purl)}`,
    );
    if (requirement.installName !== undefined)
      lines.push(`  installed as: ${plainLine(requirement.installName)}`);
    if (requirement.version)
      lines.push(`  version constraint: ${plainLine(requirement.version)}`);
    if (requirement.source)
      lines.push(`  source: ${shownSource(requirement.source)}`);
    lines.push(
      locked
        ? `  locked: ${plainLine(locked.purl)} (${plainLine(locked.digest)})`
        : '  locked: (none)',
    );
  } else if (locked !== undefined) {
    lines.push(
      `"${plainLine(key)}" is in ${LOCK_NAME} as ${plainLine(locked.reason)} dependency`,
      `  ${plainLine(locked.purl)}`,
    );
  }
  if (lock !== undefined && locked !== undefined) {
    for (const requirer of requirersOf(lock, key)) {
      const by = lock.packages[requirer.key];
      lines.push(
        `  required by ${plainLine(requirer.key)}${by === undefined ? '' : ` (${plainLine(by.purl)})`}` +
          (requirer.installName === undefined
            ? ''
            : ` as ${plainLine(requirer.installName)}`),
      );
    }
  }
  return lines.join('\n');
}

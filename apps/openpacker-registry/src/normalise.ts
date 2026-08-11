/**
 * Serving a document in the version the client asked for.
 *
 * Validating on publish stops a registry storing something no client can read.
 * It does nothing for the client that meets a document published under last
 * year's schema — which is the failure the MCP registry shipped: entries carry
 * whatever version they were published under, and consumers that cannot
 * deserialise them simply fail. The cost lands at install time, on the party
 * with the least ability to do anything about it.
 *
 * So a client states what it can read and the registry either meets it or says
 * plainly that it cannot. `406` is a better answer than a document the client
 * will mis-parse, because a mis-parse is silent.
 *
 * There is exactly one manifest version today. The machinery exists now because
 * the moment it is needed is the moment it is too late to add — every document
 * already stored was written before anyone thought about migrating it.
 */

import type { PackageManifest } from '@openpacker/contracts';

/** `application/vnd.prex.manifest.v1+json` and nothing else. */
const MEDIA_TYPE = /^application\/vnd\.prex\.manifest\.v([1-9][0-9]*)\+json$/u;

export interface ManifestMigration {
  /** Version this reads. */
  from: number;
  /** Version it produces. Either direction: forward or back. */
  to: number;
  migrate(manifest: PackageManifest): PackageManifest;
}

/**
 * Versions a client will accept, most preferred first.
 *
 * `Accept: * / *`, an absent header, or any type this registry does not speak
 * yields an empty list, which the caller reads as "no preference" rather than
 * "nothing acceptable". A client that sends `*​/*` wants whatever there is.
 */
export function acceptedVersions(accept: string | undefined): number[] {
  if (accept === undefined || accept.trim() === '') return [];
  const entries: { version: number; quality: number }[] = [];
  for (const part of accept.split(',')) {
    const [type, ...parameters] = part.trim().split(';');
    const match = MEDIA_TYPE.exec((type ?? '').trim().toLowerCase());
    if (!match) continue;
    const quality = parameters
      .map((parameter) => /^\s*q=([0-9.]+)\s*$/u.exec(parameter))
      .find((found) => found !== null);
    entries.push({
      version: Number(match[1]),
      // A q-value the client wrote as nonsense is not a reason to drop its
      // preference on the floor; it is a reason to treat it as unweighted.
      quality: quality ? Number(quality[1]) || 0 : 1,
    });
  }
  // Stable within equal quality, so the client's own order is honoured.
  return entries
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .filter((entry) => entry.quality > 0)
    .map((entry) => entry.version);
}

/**
 * Convert a manifest to a version the client asked for.
 *
 * Returns the document unchanged when the client expressed no preference, or
 * already accepts what is stored. Returns `undefined` when no chain of
 * migrations reaches anything acceptable — which the caller answers with 406.
 */
export function normalise(
  manifest: PackageManifest,
  accepted: readonly number[],
  migrations: readonly ManifestMigration[],
): PackageManifest | undefined {
  const stored = Number(manifest.packageManifestVersion);
  if (accepted.length === 0) return manifest;
  if (accepted.includes(stored)) return manifest;

  for (const target of accepted) {
    const path = route(stored, target, migrations);
    if (!path) continue;
    let current = manifest;
    for (const step of path) current = step.migrate(current);
    return current;
  }
  return undefined;
}

/**
 * Shortest chain of migrations from one version to another.
 *
 * Breadth-first, so a registry that later gains both a direct 1→3 migration and
 * a 1→2→3 pair uses the direct one. Each hop is a chance to lose something.
 */
function route(
  from: number,
  to: number,
  migrations: readonly ManifestMigration[],
): ManifestMigration[] | undefined {
  if (from === to) return [];
  const queue: { version: number; path: ManifestMigration[] }[] = [
    { version: from, path: [] },
  ];
  const seen = new Set<number>([from]);
  while (queue.length > 0) {
    const step = queue.shift()!;
    for (const migration of migrations) {
      if (migration.from !== step.version || seen.has(migration.to)) continue;
      const path = [...step.path, migration];
      if (migration.to === to) return path;
      seen.add(migration.to);
      queue.push({ version: migration.to, path });
    }
  }
  return undefined;
}

/** What this registry can serve, for the 406 body. */
export function representableVersions(
  stored: number,
  migrations: readonly ManifestMigration[],
): number[] {
  const reachable = new Set<number>([stored]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const migration of migrations)
      if (reachable.has(migration.from) && !reachable.has(migration.to)) {
        reachable.add(migration.to);
        grew = true;
      }
  }
  return [...reachable].sort((a, b) => a - b);
}

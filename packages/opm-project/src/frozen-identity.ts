/**
 * Whether each archive of a pnpm lock is the package the lock names.
 *
 * A pnpm lock pins a package's bytes by their integrity and says nothing of
 * what they hold, so a lock that gives `b@1.0.0` the bytes (and the integrity)
 * of `a` would install `a` where Node looks for `b`. After extraction, and
 * before `node_modules` is touched, the host reads each archive's own
 * `package.json` and refuses one whose name or version is not the lock's
 * (ADR 0055 §7). The version is compared as npm reads one: a leading `v` or `=`
 * and build metadata do not make another version. Neither pnpm nor npm checks
 * this; an npm lock is not checked here either, its archives being the ones npm
 * resolved by name.
 */

import type { FrozenLockPackage } from '@openpacker/adapter-core';
import { readArchiveManifest } from './frozen-scripts.js';
import { OpmError } from './types.js';

const comparable = (version: string): string =>
  version
    .trim()
    .replace(/^[=v]+/u, '')
    .split('+', 1)[0]!;

/** A value from an archive, quoted, and cut to a length a line can hold. */
const show = (text: string): string =>
  JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}...` : text);

/** Throw when an archive the host read for a pnpm lock is not the package the lock names. */
export async function checkArchiveIdentities(
  packages: readonly FrozenLockPackage[],
  archives: ReadonlyMap<string, { readonly path: string }>,
): Promise<void> {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const pkg of packages) {
    if (pkg.scriptsFromArchive !== true) continue;
    const extracted = archives.get(pkg.path)!.path;
    const wanted = `${pkg.packageName}@${pkg.version}`;
    if (seen.has(`${extracted}\0${wanted}`)) continue;
    seen.add(`${extracted}\0${wanted}`);
    const manifest = await readArchiveManifest(extracted).catch(
      () => undefined,
    );
    const { name, version } = manifest ?? {};
    if (typeof name !== 'string' || typeof version !== 'string')
      problems.push(
        `${show(wanted)} (${pkg.path}): the archive's package.json has no ${typeof name !== 'string' ? 'name' : 'version'}`,
      );
    else if (
      name !== pkg.packageName ||
      comparable(version) !== comparable(pkg.version)
    )
      problems.push(
        `${show(wanted)} (${pkg.path}): the archive's package.json is ${show(`${name}@${version}`)}`,
      );
  }
  if (problems.length > 0)
    throw new OpmError(
      'DIGEST_MISMATCH',
      `${problems.length} archive${problems.length === 1 ? ' is' : 's are'} not the package pnpm-lock.yaml names, although each matches the integrity the lock pins; nothing was installed: ${problems.slice(0, 10).join('; ')}${problems.length > 10 ? `; and ${problems.length - 10} more` : ''}`,
    );
}

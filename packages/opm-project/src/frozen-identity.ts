/**
 * Whether each archive of a pnpm lock is the package the lock names.
 *
 * A pnpm lock pins a package's bytes by their integrity and says nothing of
 * what they hold, so a lock that gives `b@1.0.0` the bytes (and the integrity)
 * of `a` would install `a` where Node looks for `b`. After extraction, and
 * before `node_modules` is touched, the host reads each archive's own
 * `package.json` and refuses one whose name or version is not the lock's
 * (ADR 0055 §7). The version is the one the lock records for the archive: a
 * registry package's, or a tarball entry's own `version`, which may be absent,
 * and then only the name is compared. It is compared as npm reads one: a
 * leading `v` or `=` and build metadata do not make another version, and a
 * name as pnpm compares one, without regard to case. pnpm makes the same check
 * when it reads a package back from its store (`checkPackageMismatch`,
 * `ERR_PNPM_UNEXPECTED_PKG_CONTENT_IN_STORE`, on by default through
 * `strict-store-pkg-content-check`). An npm lock is not checked here, its
 * archives being the ones npm resolved by name.
 */

import { type FrozenLockPackage, quote } from '@openpacker/adapter-core';
import { readArchiveManifest } from './frozen-scripts.js';
import { OpmError } from './types.js';

const comparable = (version: string): string =>
  version
    .trim()
    .replace(/^[=v]+/u, '')
    .split('+', 1)[0]!;

/**
 * The names the archive must carry and the version, if any: the lock's own
 * record when it gives one (a tarball's may give no version), else the package's.
 */
function expectedOf(pkg: FrozenLockPackage): {
  readonly names: readonly string[];
  readonly version: string | undefined;
} {
  if (pkg.archiveIdentity === undefined)
    return { names: [pkg.packageName], version: pkg.version };
  const { name, version } = pkg.archiveIdentity;
  return {
    names:
      name === undefined || name === pkg.packageName
        ? [pkg.packageName]
        : [pkg.packageName, name],
    version,
  };
}

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
    const expected = expectedOf(pkg);
    const compareVersion = expected.version !== undefined;
    if (
      typeof name !== 'string' ||
      (compareVersion && typeof version !== 'string')
    )
      problems.push(
        `${quote(wanted)} (${pkg.path}): the archive's package.json has no ${typeof name !== 'string' ? 'name' : 'version'}`,
      );
    else if (
      expected.names.some(
        (each) => each.toLowerCase() !== name.toLowerCase(),
      ) ||
      (compareVersion &&
        comparable(version as string) !== comparable(expected.version!))
    )
      problems.push(
        `${quote(wanted)} (${pkg.path}): the archive's package.json is ${quote(typeof version === 'string' ? `${name}@${version}` : name)}`,
      );
  }
  if (problems.length > 0)
    throw new OpmError(
      'DIGEST_MISMATCH',
      `${problems.length} archive${problems.length === 1 ? ' is' : 's are'} not the package pnpm-lock.yaml names, although each matches the integrity the lock pins; nothing was installed: ${problems.slice(0, 10).join('; ')}${problems.length > 10 ? `; and ${problems.length - 10} more` : ''}`,
    );
}

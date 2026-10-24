import { codecFor } from './codecs.js';
import type { LockPackage, OpmManifest } from './types.js';

/**
 * The manifest constraint for a package, when its ecosystem can read it.
 *
 * `version` in opm.toml is whatever the user wrote, and an exact pin is not
 * always a valid range: PyPI wants `==1.0.0`, so a bare `1.0.0` fails to parse
 * and the whole closure comes back empty. Probe the codec and drop a range it
 * cannot read — candidate enumeration is bounded either way, and the solver is
 * pinned to the locked version regardless.
 */
function nativeRangeFor(
  pkg: LockPackage,
  manifest: OpmManifest,
): string | undefined {
  const declared = manifest.packages[pkg.alias]?.version;
  if (declared === undefined) return undefined;
  try {
    codecFor(pkg.ecosystem).parseNativeRange(declared);
    return declared;
  } catch {
    return undefined;
  }
}

/**
 * What a root is walked under. With no constraint in opm.toml the walk would
 * take the newest few releases, and the version the direct pass locked (the
 * `latest` dist-tag, which can sit behind any number of prereleases) would not
 * be among them; the solve is pinned to it below, so it is the one candidate.
 */
export function rootRangeFor(
  pkg: LockPackage,
  manifest: OpmManifest,
): string | undefined {
  const declared = nativeRangeFor(pkg, manifest);
  if (declared !== undefined) return declared;
  try {
    codecFor(pkg.ecosystem).parseNativeRange(pkg.version);
    return pkg.version;
  } catch {
    return undefined;
  }
}

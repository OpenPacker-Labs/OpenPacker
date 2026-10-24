import type { CatalogProvider, EcosystemCodec } from '@openpacker/adapter-core';
import type { PolicyDocument } from '@openpacker/policy';
import { codecFor } from './codecs.js';
import { canResolveTags } from './registry-target.js';
import { insideReleaseAge } from './supply-chain.js';

/**
 * Which release a requirement that names no version means: `opm add foo`,
 * `opm update --latest` and `opmx foo` all ask this, and all get one answer.
 *
 * The `latest` dist-tag when the registry has one, as npm and pnpm read a bare
 * name: npm-pick-manifest@12.0.0 `lib/index.js` lines 115-131 prefer
 * `dist-tags.latest` for `*` and the implicit default, and pnpm's
 * @pnpm/npm-resolver@1005.2.3 `lib/pickPackageFromMeta.js` lines 132-135 return
 * `latest` for `*`. Without one, the newest release that is not a prerelease
 * (npm-pick-manifest line 153 filters with `semver.satisfies(ver, '*')`, which
 * excludes prereleases). npm stops there; when a package has published nothing
 * but prereleases, opm takes the newest of those rather than nothing.
 *
 * When `latest` is too new for the policy's minimum release age, the releases
 * after it in this order are the older non-prereleases, newest first: npm does
 * the same with `--before`, picking `<=${latest}` (lines 97-104). A version
 * newer than `latest` (a `next` published as 2.0.0) is never the default.
 */

/**
 * The versions in the order the default takes them, first choice first.
 *
 * An ecosystem whose adapter has no codec (a plugin may ship only a catalog)
 * cannot say what a prerelease is or how two versions compare, so there the
 * registry's own order is the only one: `latest` if it names a listed version,
 * then what is listed before it, else the newest listed, as before.
 */
export function defaultReleaseOrder(input: {
  ecosystem: string;
  /** Versions, oldest first, as the registry lists them. */
  versions: readonly string[];
  /** What the `latest` dist-tag names, when the registry has one. */
  latest?: string | undefined;
}): string[] {
  const codec = codecIfAny(input.ecosystem);
  const same = (left: string, right: string): boolean =>
    codec === undefined
      ? left === right
      : codec.compareNativeVersions(left, right) === 0;
  const stable = (version: string): boolean => {
    if (codec === undefined) return true;
    try {
      return codec.parseNativeVersion(version).prerelease.length === 0;
    } catch {
      return false;
    }
  };
  const at = input.versions.findIndex(
    (version) => input.latest !== undefined && same(version, input.latest),
  );
  if (at >= 0) {
    const latest = input.versions[at]!;
    const older = input.versions.filter(
      (version, index) =>
        stable(version) &&
        (codec === undefined
          ? index < at
          : codec.compareNativeVersions(version, latest) < 0),
    );
    return [latest, ...older.reverse()];
  }
  const newestFirst = [...input.versions].reverse();
  const stables = newestFirst.filter(stable);
  return stables.length > 0 ? stables : newestFirst;
}

function codecIfAny(ecosystem: string): EcosystemCodec | undefined {
  try {
    return codecFor(ecosystem);
  } catch {
    return undefined;
  }
}

/** The version the `latest` dist-tag names, or undefined. */
export function latestTagOf(
  provider: CatalogProvider,
  basePurl: string,
): Promise<string | undefined> {
  return distTagOf(provider, basePurl, 'latest');
}

/** The version a dist-tag names, or undefined when there is no such tag. */
export async function distTagOf(
  provider: CatalogProvider,
  basePurl: string,
  tag: string,
): Promise<string | undefined> {
  if (!canResolveTags(provider)) return undefined;
  try {
    const exact = await provider.resolveTag(basePurl, tag);
    return exact === undefined ? undefined : versionOfPurl(exact);
  } catch {
    return undefined;
  }
}

export function versionOfPurl(exactPurl: string): string {
  return decodeURIComponent(exactPurl.slice(exactPurl.lastIndexOf('@') + 1));
}

/**
 * The exact PURL a requirement with no version resolves to: the first in the
 * default order that the minimum release age allows, else the first, so the
 * policy refuses it by name instead of the add failing on nothing.
 */
export async function defaultRelease(input: {
  ecosystem: string;
  basePurl: string;
  /** Exact PURLs, oldest first. */
  published: readonly string[];
  provider: CatalogProvider;
  policy?: PolicyDocument;
  evaluationTime?: string;
}): Promise<string | undefined> {
  const byVersion = new Map(
    input.published.map((exact) => [versionOfPurl(exact), exact]),
  );
  const order = defaultReleaseOrder({
    ecosystem: input.ecosystem,
    versions: [...byVersion.keys()],
    latest: await latestTagOf(input.provider, input.basePurl),
  }).map((version) => byVersion.get(version)!);
  if (input.policy !== undefined && input.evaluationTime !== undefined)
    for (const exact of order)
      if (
        !(await insideReleaseAge(
          input.policy,
          input.provider,
          exact,
          input.evaluationTime,
        ))
      )
        return exact;
  return order[0];
}

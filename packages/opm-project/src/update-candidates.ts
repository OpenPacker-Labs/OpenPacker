import { parsePurl } from '@openpacker/adapter-core';
import type { OpmLockfile, OpmManifest, PackageRequirement } from './types.js';
import { OpmError } from './types.js';
import { canonicalCatalogPurl } from './catalog.js';
import { codecFor } from './codecs.js';
import { defaultReleaseOrder, latestTagOf } from './default-release.js';
import {
  listRegistryVersions,
  providerFor,
  registryOptionsForEcosystem,
  type RegistryOptions,
} from './registry.js';
import { ecosystemFromPurl, stripPurlVersion } from './spec.js';

/**
 * Which version `opm update` moves a requirement to: the newest the catalog or
 * the registry has inside its range, or, with no range (and with `--latest`),
 * the one `opm add` would take (`default-release.ts`). A yanked or ineligible
 * release is passed over.
 */
export async function newestEligibleVersion(input: {
  req: PackageRequirement;
  catalog: Map<string, { purl: string; version: string }>;
  manifest: OpmManifest;
  offline: boolean;
  latest: boolean;
  registryOptions?: RegistryOptions;
  previousLock?: OpmLockfile | undefined;
}): Promise<string | undefined> {
  const ecosystem = ecosystemFromPurl(input.req.purl);
  const codec = codecFor(ecosystem);
  const candidates = new Map<string, string>();
  let latest: string | undefined;
  const base = canonicalCatalogPurl(stripPurlVersion(input.req.purl));
  for (const entry of input.catalog.values()) {
    if (canonicalCatalogPurl(stripPurlVersion(entry.purl)) !== base) continue;
    candidates.set(entry.version, entry.purl);
  }

  if (!input.offline) {
    try {
      const options = registryOptionsForEcosystem(
        ecosystem,
        input.manifest,
        input.registryOptions ?? {},
        input.previousLock,
      );
      const listed = await listRegistryVersions(
        ecosystem,
        stripPurlVersion(input.req.purl),
        options,
      );
      for (const exact of listed) {
        const version = parsePurl(exact).version;
        if (version !== undefined) candidates.set(version, exact);
      }
      latest = await latestTagOf(
        await providerFor(ecosystem, options),
        stripPurlVersion(input.req.purl),
      );
    } catch (error) {
      if (
        !(error instanceof OpmError && error.code === 'OFFLINE') &&
        candidates.size === 0
      )
        throw error;
    }
  }

  if (candidates.size === 0) {
    if (input.offline)
      throw new OpmError(
        'UNRESOLVABLE',
        `Cannot update "${input.req.alias}" offline without catalog versions`,
      );
    return undefined;
  }

  const range = input.latest ? undefined : input.req.version;
  const ranked = [...candidates.keys()].sort((left, right) =>
    codec.compareNativeVersions(left, right),
  );
  // No range is the same question `opm add foo` asks (`default-release.ts`).
  const order =
    range === undefined
      ? defaultReleaseOrder({ ecosystem, versions: ranked, latest })
      : ranked.reverse();
  for (const version of order) {
    if (range !== undefined && !versionSatisfies(codec, version, range))
      continue;
    const exact = candidates.get(version) ?? `${base}@${version}`;
    if (await isYankedOrIneligible(ecosystem, exact, input)) continue;
    return version;
  }
  return undefined;
}

function versionSatisfies(
  codec: ReturnType<typeof codecFor>,
  version: string,
  range: string,
): boolean {
  try {
    codec.parseNativeRange(range);
    return codec.satisfies(version, range);
  } catch {
    return false;
  }
}

async function isYankedOrIneligible(
  ecosystem: string,
  exactPurl: string,
  input: {
    manifest: OpmManifest;
    offline: boolean;
    registryOptions?: RegistryOptions;
  },
): Promise<boolean> {
  if (input.offline) return false;
  try {
    const options = registryOptionsForEcosystem(
      ecosystem,
      input.manifest,
      input.registryOptions ?? {},
    );
    const provider = await providerFor(ecosystem, options, [
      'prex.registry.package-metadata/1',
    ]);
    const inspection = await provider.inspect(exactPurl);
    const lifecycle = inspection.package.lifecycle;
    return lifecycle.status === 'yanked' || lifecycle.eligible === false;
  } catch {
    return false;
  }
}

import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OpmError, type BinDeclaration, type LockPackage } from './types.js';
import { ecosystemFromPurl, stripPurlVersion } from './spec.js';
import { storeKeyFromDigest } from './paths.js';
import { inferFormat, materializeLockPackage } from './install.js';
import {
  REGISTRY_ECOSYSTEMS,
  listRegistryVersions,
  resolveRegistryArtifact,
} from './registry.js';

/**
 * Run a tool without adding it to a project — what `npx`, `pipx run`, `uvx`
 * and `dnx` are for.
 *
 * The cache is an ordinary content-addressed store that happens to live
 * outside any project, so an ephemeral run gets the same digest verification
 * and the same immutable layout as an install. "Ephemeral" describes the
 * dependency, not the rigour: nothing is executed that was not verified
 * against the digest the registry published.
 *
 * Being content-addressed also makes the second run free, which is the
 * behaviour people actually want from `npx` and rarely get.
 */

/** Where cached tools live. Honours XDG, falls back to a home directory. */
export function toolCacheRoot(): string {
  const explicit = process.env.OPM_TOOL_CACHE?.trim();
  if (explicit) return explicit;
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  return xdg
    ? join(xdg, 'openpacker', 'x')
    : join(homedir(), '.cache', 'openpacker', 'x');
}

export interface EphemeralTool {
  exactPurl: string;
  digest: string;
  storePath: string;
  bins: BinDeclaration[];
  /** True when the bytes were already cached and nothing was downloaded. */
  cached: boolean;
}

/**
 * Resolve a PURL, verify it, and place it in the tool cache.
 *
 * Resolution mirrors `opm add`: an exact version is used as given, and a bare
 * package takes the newest the registry publishes. There is no lockfile here,
 * so the version that ran is reported back rather than assumed — an unpinned
 * ephemeral run is a different thing tomorrow and should say so.
 */
export async function fetchTool(input: {
  purl: string;
  offline?: boolean;
  cacheRoot?: string;
}): Promise<EphemeralTool> {
  const ecosystem = ecosystemFromPurl(input.purl);
  if (!REGISTRY_ECOSYSTEMS.includes(ecosystem))
    throw new OpmError(
      'UNSUPPORTED_ECOSYSTEM',
      `Cannot run a ${ecosystem} package: no registry is configured for it.`,
    );
  if (input.offline)
    throw new OpmError(
      'OFFLINE',
      'An ephemeral run resolves from a registry and cannot be done offline. ' +
        'Install the tool into a project instead.',
    );

  const exact = input.purl.includes('@', 'pkg:'.length)
    ? input.purl
    : await (async () => {
        const versions = await listRegistryVersions(
          ecosystem,
          stripPurlVersion(input.purl),
        );
        const newest = versions[versions.length - 1];
        if (!newest)
          throw new OpmError(
            'UNRESOLVABLE',
            `The ${ecosystem} registry published no versions of ${input.purl}.`,
          );
        return newest;
      })();

  const artifact = await resolveRegistryArtifact(ecosystem, exact);
  const cacheRoot = input.cacheRoot ?? toolCacheRoot();
  await mkdir(cacheRoot, { recursive: true });

  const pkg: LockPackage = {
    alias: 'tool',
    purl: artifact.exactPurl,
    version: artifact.version,
    digest: artifact.digest,
    size: artifact.bytes.byteLength,
    format: inferFormat(artifact.uri, artifact.mediaType),
    mediaType: artifact.mediaType,
    source: artifact.uri,
    storeKey: storeKeyFromDigest(artifact.digest),
    bins: [],
    reason: 'direct',
    ecosystem,
  };

  const { storePath, bins, cached } = await materializeLockPackage({
    root: cacheRoot,
    pkg,
    offline: false,
    // The provider already fetched and checked these; handing them over keeps
    // the run to a single download.
    bytes: artifact.bytes,
  });

  return {
    exactPurl: artifact.exactPurl,
    digest: artifact.digest,
    storePath,
    bins,
    cached: cached ?? false,
  };
}

/**
 * Choose which executable to run.
 *
 * A package with exactly one binary is unambiguous. With several, the one
 * matching the package name wins — `npx eslint` should run eslint, not the
 * first entry that happens to sort first — and anything else must be named,
 * because silently running a different tool than the one asked for is worse
 * than an error.
 */
export function selectToolBin(
  tool: EphemeralTool,
  requested?: string,
): BinDeclaration {
  if (tool.bins.length === 0)
    throw new OpmError(
      'NOT_FOUND',
      `${tool.exactPurl} declares no executable to run.`,
    );
  if (requested !== undefined) {
    const found = tool.bins.find((bin) => bin.name === requested);
    if (!found)
      throw new OpmError(
        'NOT_FOUND',
        `${tool.exactPurl} has no executable named "${requested}". ` +
          `It provides: ${tool.bins.map((bin) => bin.name).join(', ')}.`,
      );
    return found;
  }
  if (tool.bins.length === 1) return tool.bins[0]!;

  const packageName = tool.exactPurl
    .slice('pkg:'.length)
    .split('@')[0]!
    .split('/')
    .at(-1);
  const byName = tool.bins.find((bin) => bin.name === packageName);
  if (byName) return byName;
  throw new OpmError(
    'AMBIGUOUS_SPEC',
    `${tool.exactPurl} provides several executables and none matches the ` +
      `package name. Name one with --bin: ${tool.bins.map((bin) => bin.name).join(', ')}.`,
  );
}

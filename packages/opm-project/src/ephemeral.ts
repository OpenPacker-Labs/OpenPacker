import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OpmError, type BinDeclaration, type LockPackage } from './types.js';
import { binDeclarationsFromExecutables } from './bins.js';
import { ecosystemFromPurl, stripPurlVersion } from './spec.js';
import { storeKeyFromDigest } from './paths.js';
import {
  bindVerifiedArtifactBytes,
  bindVerifiedArtifactCacheEntry,
  sealVerifiedArtifactBinding,
  inferFormat,
  materializeLockPackage,
} from './install.js';
import {
  listRegistryVersions,
  providerFor,
  resolveRegistryArtifactDeferred,
  type RegistryOptions,
} from './registry.js';
import { defaultRelease } from './default-release.js';
import { resolveGraph } from './resolve.js';
import { solveGraph } from './solve.js';
import { requireAdapterRegistry } from './adapters.js';
import {
  captureFactsFromCatalog,
  defaultSupplyChainPolicyInput,
  lockPackageSupplyChainFields,
} from './supply-chain.js';

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
 * Being content-addressed also makes the second run cheap, which is the
 * behaviour people actually want from `npx` and rarely get. Resolution is
 * not cached — registry metadata is re-read on every run, because an
 * unpinned purl is a different thing tomorrow — but the artifact bytes are:
 * when the freshly resolved digest already names a store archive, the
 * download is skipped and the tree is rebuilt from that archive, re-hashed
 * against the digest exactly as a lock replay rebuilds it.
 *
 * For ecosystems that declare runtime dependencies (npm, PyPI, …) the full
 * solved closure is materialised into the cache and returned as
 * `runtimePaths`, so a Python console script that imports a locked dependency
 * finds it on sys.path rather than crashing with ImportError.
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
  /** True when the primary package bytes were already cached. */
  cached: boolean;
  /**
   * Store roots that must be on the runtime path (e.g. PYTHONPATH) so
   * transitive dependencies of the tool are importable.
   */
  runtimePaths: string[];
}

/**
 * Resolve a PURL, verify it (and its runtime closure), and place everything
 * in the tool cache.
 *
 * Resolution mirrors `opm add`: an exact version is used as given, and a bare
 * package takes what `opm add` would (`default-release.ts`). There is no lockfile here,
 * so the version that ran is reported back rather than assumed — an unpinned
 * ephemeral run is a different thing tomorrow and should say so.
 */
export async function fetchTool(input: {
  purl: string;
  offline?: boolean;
  cacheRoot?: string;
  /** Transport / endpoint overrides for hosts and tests. */
  registryOptions?: RegistryOptions;
}): Promise<EphemeralTool> {
  const ecosystem = ecosystemFromPurl(input.purl);
  const options = input.registryOptions ?? {};
  if (!requireAdapterRegistry().has(ecosystem))
    throw new OpmError(
      'UNSUPPORTED_ECOSYSTEM',
      `Cannot run a ${ecosystem} package: no adapter is registered for it.`,
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
        const base = stripPurlVersion(input.purl);
        const newest = await defaultRelease({
          ecosystem,
          basePurl: base,
          published: await listRegistryVersions(ecosystem, base, options),
          provider: await providerFor(ecosystem, options),
        });
        if (!newest)
          throw new OpmError(
            'UNRESOLVABLE',
            `The ${ecosystem} registry published no versions of ${input.purl}.`,
          );
        return newest;
      })();

  const cacheRoot = input.cacheRoot ?? toolCacheRoot();
  await mkdir(cacheRoot, { recursive: true });

  const primary = await materialiseExact(ecosystem, exact, cacheRoot, options);

  // Runtime closure: everything the tool needs at run time. Soft-fail if the
  // walk cannot complete — a tool that declares no dependencies must still
  // run, and a registry that omits a dependency must not make a previously
  // runnable tool unusable.
  const runtimePaths = [primary.storePath];
  try {
    const graph = await resolveGraph({
      roots: [{ purl: stripPurlVersion(primary.exactPurl) }],
      options,
    });
    if (graph.packages.length > 0) {
      const solved = await solveGraph({
        graph,
        rootRequirements: [{ purl: stripPurlVersion(primary.exactPurl) }],
      });
      for (const instance of solved.selected) {
        const depExact = instance.identity.exactPurl;
        if (!depExact || depExact === primary.exactPurl) continue;
        const depEco = instance.identity.purlType;
        if (!requireAdapterRegistry().has(depEco)) continue;
        const dep = await materialiseExact(
          depEco,
          depExact,
          cacheRoot,
          options,
        );
        if (!runtimePaths.includes(dep.storePath))
          runtimePaths.push(dep.storePath);
      }
    }
  } catch {
    // Direct tool only; the run path still works for packages without a graph.
  }

  return {
    exactPurl: primary.exactPurl,
    digest: primary.digest,
    storePath: primary.storePath,
    bins: primary.bins,
    cached: primary.cached,
    runtimePaths,
  };
}

async function materialiseExact(
  ecosystem: string,
  exact: string,
  cacheRoot: string,
  options: RegistryOptions,
): Promise<{
  exactPurl: string;
  digest: string;
  storePath: string;
  bins: BinDeclaration[];
  cached: boolean;
}> {
  // Resolve the artifact identity with the byte download deferred: what an
  // unpinned purl means today is registry metadata and is re-read on every
  // run, but the bytes are content-addressed, so a digest the tool cache
  // already holds does not need to move again.
  const resolved = await resolveRegistryArtifactDeferred(
    ecosystem,
    exact,
    options,
  );
  const policyInput = defaultSupplyChainPolicyInput();
  const { facts } = await captureFactsFromCatalog(
    await providerFor(ecosystem, options),
    resolved.exactPurl,
    {
      evaluationTime: new Date().toISOString(),
      registryId: resolved.registryId,
    },
  );
  const pkg: LockPackage = {
    alias: 'tool',
    purl: resolved.exactPurl,
    version: resolved.version,
    digest: resolved.digest,
    size: resolved.bytes?.byteLength ?? resolved.size,
    format: inferFormat(resolved.uri, resolved.mediaType),
    mediaType: resolved.mediaType,
    source: resolved.uri,
    storeKey: storeKeyFromDigest(resolved.digest),
    bins: binDeclarationsFromExecutables(resolved.bins),
    reason: 'direct',
    ecosystem,
    ...lockPackageSupplyChainFields(facts),
  };

  // Consult the cache before moving any bytes. A present entry is trusted
  // only because it is content-addressed: materializeLockPackage re-reads
  // the store archive named by this digest and re-hashes it before rebuilding
  // the tree, exactly as a lock replay does. The freshly resolved facts are
  // bound for the policy gate just as a download run binds them. Any
  // surprise — a missing, partial, or corrupt entry, metadata that disagrees
  // with what is stored — falls through to the full download and verify
  // below; a cache shape must never make a runnable tool fail.
  if (resolved.bytes === undefined) {
    bindVerifiedArtifactCacheEntry(pkg, facts);
    sealVerifiedArtifactBinding(pkg);
    try {
      const hit = await materializeLockPackage({
        root: cacheRoot,
        pkg,
        offline: false,
        policy: policyInput,
      });
      if (hit.cached) {
        return {
          exactPurl: resolved.exactPurl,
          digest: resolved.digest,
          storePath: hit.storePath,
          bins: hit.bins,
          cached: true,
        };
      }
    } catch {
      // Cache miss or a broken entry: acquire and verify as if uncached.
    }
  }

  const bytes = resolved.bytes ?? (await resolved.fetchBytes());
  bindVerifiedArtifactBytes(pkg, bytes, 'registry', facts);
  sealVerifiedArtifactBinding(pkg);
  const { storePath, bins, cached } = await materializeLockPackage({
    root: cacheRoot,
    pkg,
    offline: false,
    bytes,
    policy: policyInput,
  });
  return {
    exactPurl: resolved.exactPurl,
    digest: resolved.digest,
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
  if (tool.bins.length === 0) {
    // Name the reason. "Declares no executable" is true but useless when the
    // real answer is that this ecosystem's entry-point convention is not
    // implemented — those are different problems with different fixes.
    const ecosystem = tool.exactPurl.slice('pkg:'.length).split('/')[0];
    const understood =
      ecosystem === 'npm' || ecosystem === 'pypi' || ecosystem === 'nuget';
    throw new OpmError(
      understood ? 'NOT_FOUND' : 'UNSUPPORTED_ECOSYSTEM',
      understood
        ? `${tool.exactPurl} declares no executable to run.`
        : `${tool.exactPurl} was fetched and verified, but opm does not yet ` +
          `know how ${ecosystem} declares executables, so it cannot be run.`,
    );
  }
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

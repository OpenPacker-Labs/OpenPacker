/**
 * Which locked package would provide an executable.
 *
 * `opm exec` runs only what `node_modules/.bin` holds. When the executable is
 * not there, the useful answer is the lock's: the same data `opm why` reads
 * (`opm.toml` and `opm.lock.json`), asked the other way round — not "why is
 * this package here" but "which package brings this name".
 *
 * Nothing here reads the network or the store, and nothing is installed.
 */
import { parsePurl } from '@openpacker/adapter-core';
import { readLockfile } from './lock.js';
import { projectionLevel } from './native.js';
import { projectPaths } from './paths.js';
import { readManifestFile } from './project.js';
import type { NativeProjectionLevel } from './types.js';

export interface BinProvider {
  /** The lock alias. */
  alias: string;
  purl: string;
  direct: boolean;
  /**
   * `declared`: the lock records this executable for the package.
   * `named`: the lock records none, but the package's own name is the
   * executable's name, which is what npm calls a package's default bin. A
   * transitive package's bins are not recorded in the lock, so this is the
   * best the lock alone can say.
   */
  evidence: 'declared' | 'named';
}

export interface BinProviderReport {
  /** Whether the directory is an opm project with a lock to read. */
  locked: boolean;
  /** What the manifest says about writing `node_modules` (`off` when none). */
  projection: NativeProjectionLevel | undefined;
  providers: BinProvider[];
}

/** The last path segment of an npm package name: `@scope/tool` → `tool`. */
function defaultBinName(purl: string): string | undefined {
  try {
    const parsed = parsePurl(purl);
    return parsed.type === 'npm' ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

export async function findBinProviders(
  root: string,
  bin: string,
): Promise<BinProviderReport> {
  const paths = projectPaths(root);
  let projection: NativeProjectionLevel | undefined;
  try {
    projection = projectionLevel(await readManifestFile(paths.manifest));
  } catch {
    // Not an opm project, or a manifest that does not parse: there is nothing
    // to say about it, and `exec` has already failed for its own reason.
    return { locked: false, projection: undefined, providers: [] };
  }
  let lock;
  try {
    lock = await readLockfile(paths.lock);
  } catch {
    lock = undefined;
  }
  if (lock === undefined) return { locked: false, projection, providers: [] };

  const providers: BinProvider[] = [];
  for (const [alias, entry] of Object.entries(lock.packages)) {
    const direct = entry.reason === 'direct';
    if (entry.bins.some((declared) => declared.name === bin)) {
      providers.push({ alias, purl: entry.purl, direct, evidence: 'declared' });
    } else if (entry.bins.length === 0 && defaultBinName(entry.purl) === bin) {
      providers.push({ alias, purl: entry.purl, direct, evidence: 'named' });
    }
  }
  // Declared evidence first, then direct requirements, then by alias, so the
  // first line of the message is the strongest claim the lock can make.
  providers.sort(
    (left, right) =>
      Number(right.evidence === 'declared') -
        Number(left.evidence === 'declared') ||
      Number(right.direct) - Number(left.direct) ||
      (left.alias < right.alias ? -1 : left.alias > right.alias ? 1 : 0),
  );
  return { locked: true, projection, providers };
}

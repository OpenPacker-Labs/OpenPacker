import {
  ephemeralNodeRun,
  type NodeRun,
  type ToolPackage,
} from './ephemeral-layout.js';
import { readLockfile } from './lock.js';
import { projectPaths } from './paths.js';
import {
  ecosystemFromPurl,
  purlPackageName,
  stripPurlVersion,
} from './spec.js';
import type { BinDeclaration, OpmLockfile, ProjectState } from './types.js';
import { OpmError } from './types.js';

/**
 * What an npm package a project installed runs with: the closure of its lock
 * entry, laid out for the run as a tool's closure is (`ephemeral-layout.ts`).
 *
 * The store holds each package as its own tree with no `node_modules` around
 * it, so a bin that requires anything found nothing ("Cannot find module
 * 'chalk'" for http-server). The edges are the lock's: each entry names the
 * entries it requires (`dependencies`, and `aliases` for those it finds under
 * another name) as the solve chose them, so the closure is the package and
 * what it requires, transitively, each under the name it is required by. The
 * trees are those of the active generation, which `activateGeneration` checked.
 *
 * The lock describes the generation only when every entry of the closure
 * records its edges and is installed with the lock's digest. When it does not
 * (an offline lock records no edges; after `opm rollback` the lock is the newer
 * install's), every npm package installed is laid out by name alone, as a tool
 * whose closure was not solved is.
 */
export function installedClosure(
  lock: OpmLockfile | undefined,
  state: ProjectState,
  alias: string,
): { tool: string; closure: ToolPackage[] } {
  const owner = state.packages[alias];
  if (owner === undefined)
    throw new OpmError('NOT_FOUND', `${alias} is not installed`);
  const solved = lock === undefined ? undefined : fromLock(lock, state, alias);
  if (solved !== undefined)
    return { tool: solved[0]!.exactPurl, closure: solved };
  const closure = Object.values(state.packages)
    .filter((record) => ecosystemFromPurl(record.purl) === 'npm')
    .map((record): ToolPackage => {
      // A layout reads neither; the lock's where it has this very package.
      const entry = lock?.packages[record.alias];
      const same = entry?.digest === record.digest;
      return {
        exactPurl: record.purl,
        digest: record.digest,
        size: same ? entry.size : 0,
        source: same ? entry.source : record.purl,
        storePath: record.storePath,
      };
    });
  return { tool: owner.purl, closure };
}

/** The closure the lock records from `alias`, or undefined where it cannot tell. */
function fromLock(
  lock: OpmLockfile,
  state: ProjectState,
  alias: string,
): ToolPackage[] | undefined {
  const closure: ToolPackage[] = [];
  const keys = [alias];
  const seen = new Set(keys);
  for (const key of keys) {
    const entry = lock.packages[key];
    const record = state.packages[key];
    if (entry?.dependencies === undefined || record?.digest !== entry.digest)
      return undefined;
    const requires: Record<string, string> = {};
    const edges: [string | undefined, string][] = [
      ...entry.dependencies.map((target): [undefined, string] => [
        undefined,
        target,
      ]),
      ...Object.entries(entry.aliases ?? {}),
    ];
    for (const [name, target] of edges) {
      const required = lock.packages[target];
      if (required === undefined) return undefined;
      requires[name ?? purlPackageName(stripPurlVersion(required.purl))] =
        required.purl;
      if (!seen.has(target)) {
        seen.add(target);
        keys.push(target);
      }
    }
    closure.push({
      exactPurl: entry.purl,
      digest: entry.digest,
      size: entry.size,
      source: entry.source,
      storePath: record.storePath,
      requires,
    });
  }
  return closure;
}

/**
 * How a bin of the installed package `alias` runs: an npm script from a layout
 * of the package's closure, made in the project beside its store
 * (`.opm/runs`), or under the temporary directory in a project this user may
 * not write, and removed when the run ends; anything else as before.
 */
export async function installedNodeRun(input: {
  root: string;
  state: ProjectState;
  /** The package the bin belongs to: its key in the state and the lock. */
  alias: string;
  bin: BinDeclaration;
}): Promise<NodeRun | undefined> {
  const owner = input.state.packages[input.alias];
  if (owner === undefined || ecosystemFromPurl(owner.purl) !== 'npm')
    return undefined;
  // The lock gives the edges and nothing else: one that cannot be read gives
  // none, and the closure is laid out by name rather than an installed tool
  // refused.
  const lock = await readLockfile(projectPaths(input.root).lock).catch(
    () => undefined,
  );
  const { tool, closure } = installedClosure(lock, input.state, input.alias);
  return ephemeralNodeRun(
    { exactPurl: tool, cacheRoot: input.root, closure },
    input.bin,
  );
}

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeLockEntry } from '@openpacker/adapter-core';
import { tarballWrapper } from '@openpacker/project-io';
import { requireAdapterRegistry } from './adapters.js';
import { scratchName, sweepAbandoned } from './run-scratch.js';
import {
  ecosystemFromPurl,
  purlPackageName,
  stripPurlVersion,
} from './spec.js';
import type { BinDeclaration } from './types.js';
import { OpmError } from './types.js';

const RUN_PREFIX = 'run-';

/** One package of a tool's closure, as the tool cache holds it. */
export interface ToolPackage {
  exactPurl: string;
  digest: string;
  size: number;
  source: string;
  /** The extracted tree in the tool cache's store. */
  storePath: string;
  /**
   * What it requires, as the solve chose: the name it finds each under → that
   * package's `exactPurl`. Absent when the closure was not solved, and the
   * layout then places by name alone.
   */
  requires?: Record<string, string>;
}

export interface ToolLayout {
  /** The directory that holds `node_modules`; the one thing the sandbox binds. */
  root: string;
  /** A `/`-separated path inside the tool's own store tree, relative to `root` in the layout. */
  relative(storePath: string): string;
  /** The same, absolute. */
  entry(storePath: string): string;
  /** Remove the layout. */
  dispose(): Promise<void>;
}

/**
 * A `node_modules` for one run of an npm tool from the tool cache.
 *
 * The cache holds each package of a tool's closure as its own store tree, and
 * Node finds a dependency by walking up `node_modules` directories from the file
 * that requires it, so a tool whose script requires anything failed
 * ("Cannot find module 'yargs'" for cowsay). This writes the closure out as a
 * layout, with the same writer `opm` uses for a project (hard links to the
 * store's files, ADR 0048), in a fresh directory of the cache for this run
 * only: a layout kept between runs would be one more thing a run trusts without
 * re-checking it.
 */
export async function layOutTool(input: {
  cacheRoot: string;
  /** The tool's exact PURL; the others in `closure` are its dependencies. */
  tool: string;
  closure: readonly ToolPackage[];
}): Promise<ToolLayout> {
  const format = await requireAdapterRegistry().projectFormatFor('npm');
  if (format?.writeLayout === undefined)
    throw new OpmError(
      'UNSUPPORTED_OPERATION',
      'The npm adapter does not write a node_modules layout',
    );
  const runs = join(input.cacheRoot, '.opm', 'runs');
  await sweepAbandoned(runs, RUN_PREFIX);
  const root = join(runs, scratchName(RUN_PREFIX));
  await mkdir(root, { recursive: true });
  const dispose = () => rm(root, { recursive: true, force: true });
  try {
    await format.writeLayout(
      {
        root,
        manifestPath: join(root, 'package.json'),
        metadata: { layoutOnly: true },
      },
      input.closure.map((pkg): NativeLockEntry => {
        const purl = stripPurlVersion(pkg.exactPurl);
        // Which version each requires, so two of one name stay apart (ADR 0054).
        const requires = Object.entries(pkg.requires ?? {});
        const ownName = ([as, target]: [string, string]) =>
          as === purlPackageName(stripPurlVersion(target));
        return {
          purl,
          name: purlPackageName(purl),
          scope: 'runtime',
          exactPurl: pkg.exactPurl,
          version: decodeURIComponent(
            pkg.exactPurl.slice(pkg.exactPurl.lastIndexOf('@') + 1),
          ),
          source: pkg.source,
          digest: pkg.digest,
          size: pkg.size,
          storePath: pkg.storePath,
          transitive: pkg.exactPurl !== input.tool,
          alias: pkg.exactPurl,
          ...(!(pkg.requires === undefined) && {
            dependencies: requires.filter(ownName).map(([, target]) => target),
            aliases: Object.fromEntries(
              requires.filter((edge) => !ownName(edge)),
            ),
          }),
        };
      }),
    );
  } catch (error) {
    await dispose();
    throw error;
  }
  const own = input.closure.find((pkg) => pkg.exactPurl === input.tool);
  // The layout drops the one directory an npm tarball wraps its files in, as
  // npm does; a path inside the store tree drops it too, by the same rule.
  const wrapper =
    own === undefined ? undefined : await tarballWrapper(own.storePath);
  const place = [
    'node_modules',
    ...purlPackageName(stripPurlVersion(input.tool)).split('/'),
  ];
  const relative = (storePath: string) => {
    const parts = storePath.split('/').filter(Boolean);
    return [...place, ...(parts[0] === wrapper ? parts.slice(1) : parts)].join(
      '/',
    );
  };
  return {
    root,
    relative,
    entry: (storePath) => join(root, ...relative(storePath).split('/')),
    dispose,
  };
}

/**
 * How an ephemeral npm script runs: from a layout of its closure, with that
 * layout as the one tree the sandbox binds. Anything else (a Python console
 * script, a native or .NET tool) runs as before.
 */
export async function ephemeralNodeRun(
  tool: {
    exactPurl: string;
    cacheRoot: string;
    closure: readonly ToolPackage[];
  },
  bin: BinDeclaration,
): Promise<
  { bin: BinDeclaration; root: string; dispose(): Promise<void> } | undefined
> {
  if (
    ecosystemFromPurl(tool.exactPurl) !== 'npm' ||
    (bin.interpreter !== undefined && bin.interpreter !== 'node')
  )
    return undefined;
  const layout = await layOutTool({
    cacheRoot: tool.cacheRoot,
    tool: tool.exactPurl,
    closure: tool.closure,
  });
  return {
    bin: { ...bin, path: layout.relative(bin.path) },
    root: layout.root,
    dispose: layout.dispose,
  };
}

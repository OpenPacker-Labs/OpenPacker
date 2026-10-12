import { writeBinShims } from './bins.js';
import type { InstalledPackageRecord } from './types.js';

/**
 * Give a bin name back to an installed package that still declares it.
 *
 * Executables are `.opm/bin/<name>`, one file per name, and two installed
 * packages can declare one name (two versions of `rimraf`). Removing one
 * package removes its names; any of them another package still provides is
 * written again from that package, so uninstalling the loser of a name never
 * takes the winner's executable with it. Of several survivors the first by key
 * takes it.
 */
export async function restoreSharedBins(input: {
  binDir: string;
  removed: ReadonlySet<string>;
  remaining: Readonly<Record<string, InstalledPackageRecord>>;
}): Promise<string[]> {
  const restored = new Set<string>();
  const pythonPath = Object.values(input.remaining)
    .filter((record) => record.purl.startsWith('pkg:pypi/'))
    .map((record) => record.storePath);
  for (const key of Object.keys(input.remaining).sort()) {
    const record = input.remaining[key]!;
    const wanted = record.bins.filter(
      (bin) => input.removed.has(bin.name) && !restored.has(bin.name),
    );
    if (wanted.length === 0) continue;
    await writeBinShims({
      binDir: input.binDir,
      storeRoot: record.storePath,
      bins: wanted.map((bin) => ({
        name: bin.name,
        path: bin.path,
        ...(!(bin.interpreter === undefined) && {
          interpreter: bin.interpreter,
        }),
        ...(!(bin.entry === undefined) && { entry: bin.entry }),
      })),
      ...(record.purl.startsWith('pkg:pypi/') && { pythonPath }),
    });
    for (const bin of wanted) restored.add(bin.name);
  }
  return [...restored].sort();
}

import { recordGeneration } from './generations.js';
import { digestOf, readProjectState, writeProjectState } from './install.js';
import {
  assertSafeSegment,
  projectPaths,
  removeStableFile,
  resolveContained,
  writeStableFile,
} from './paths.js';
import type { InstalledPackageRecord, ProjectState } from './types.js';

/**
 * Give installed packages the key the lock now has for them.
 *
 * What is installed is addressed by the store tree it points into, not by its
 * key, so a package whose key changed (`tinybench.2.9.0` to `tinybench`, once
 * it is the only one left) keeps its tree and its executables, and only the
 * record of it and its link file move. Nothing is fetched, extracted or
 * evaluated again: it is the package that was installed and checked.
 */
export async function renameInstalled(input: {
  root: string;
  /** Old key → new key. */
  renamed: ReadonlyMap<string, string>;
}): Promise<ProjectState> {
  const paths = projectPaths(input.root);
  const state = (await readProjectState(paths.projectState)) ?? {
    schemaVersion: 1 as const,
    packages: {},
  };
  const moving: InstalledPackageRecord[] = [];
  for (const [from, to] of input.renamed) {
    const safeFrom = assertSafeSegment(from, 'package alias');
    const safeTo = assertSafeSegment(to, 'package alias');
    const record = state.packages[from];
    if (record === undefined) continue;
    delete state.packages[from];
    await removeStableFile(resolveContained(paths.links, safeFrom));
    moving.push({ ...record, alias: safeTo });
  }
  if (moving.length === 0) return state;
  // After every old key is gone, so a key one package gives up and another
  // takes is not written twice.
  for (const record of moving) {
    state.packages[record.alias] = record;
    await writeStableFile(
      resolveContained(paths.links, record.alias),
      `${JSON.stringify({ alias: record.alias, purl: record.purl, storePath: record.storePath, digest: record.digest }, null, 2)}\n`,
    );
  }
  await writeProjectState(paths.projectState, state);
  await recordGeneration({
    root: input.root,
    packages: state.packages,
    lockDigest: digestOf(
      new TextEncoder().encode(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(state.packages)
              .map(([alias, record]): [string, string] => [
                alias,
                record.digest,
              ])
              .sort(([left], [right]) => (left < right ? -1 : 1)),
          ),
        ),
      ),
    ),
  });
  return state;
}

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { quote } from 'shell-quote';
import {
  OpmError,
  type BinDeclaration,
  type InstalledPackageRecord,
  type ProjectState,
} from './types.js';
import {
  assertSafeSegment,
  O_DIRECTORY,
  ensureStableDirectory,
  openChild,
  openStableDirectory,
  projectPaths,
  readDirChild,
  readDirChildWithTypes,
  readStableFile,
  readStableFileAt,
  revalidateStableDirectory,
  removeStableFile,
  removeStableTree,
  resolveContained,
  storePathForDigest,
  writeStableFile,
} from './paths.js';
import { discoverBins, removeBinShims, writeBinShims } from './bins.js';
import { readProjectState, writeProjectState } from './install.js';
import { isStoreView } from './store-view.js';
import { collectFilesFromHandle } from '@openpacker/project-io';

/**
 * The environment ledger.
 *
 * Generations are immutable and hash-linked; the only mutable thing is a
 * pointer record naming the current one. Switching and rolling back replace
 * that pointer atomically, so an interrupted switch is observed as the old
 * state or the new one and never a blend — and no symlink is involved, which
 * matters because this repository refuses symlinks for platform parity.
 */

export const GENERATIONS_DIR = 'generations';
export const ENVIRONMENT_STATE = 'environment.json';
export const STORE_REFERENCES = 'references.json';

export interface GenerationMember {
  alias: string;
  purl: string;
  digest: string;
  storePath: string;
  /** Required by generation v2; absent only on legacy v1 records. */
  treeDigest?: string;
  /**
   * The bins pinned when this member was installed — the lock's declared
   * bins when it has them, else what install-time discovery found.
   *
   * Recorded because a generation must be self-sufficient: ecosystems with
   * no on-disk convention (delegated plugin adapters) declare their bins
   * through the provider, and re-deriving them from the store tree at
   * activation would find nothing. Absent only on records that predate
   * pinned bins; activation falls back to on-disk discovery for those,
   * which is what those records always did.
   */
  bins?: BinDeclaration[];
}

export interface Generation {
  generationVersion: '1' | '2';
  environmentName: string;
  sequence: number;
  createdAt: string;
  parentGenerationDigest?: string;
  lockDigest: string;
  members: GenerationMember[];
  generationDigest: string;
  /**
   * Sandbox posture observed when this generation was installed (ADR 0036).
   * Optional for pre-sandbox ledgers.
   */
  sandbox?: {
    /** Policy digest when available. */
    policyDigest?: string;
    /** True when any member ran lifecycle scripts under a jail. */
    lifecycleScriptsExecuted?: boolean;
    /** Backend ids seen during install-time execution (unique, sorted). */
    backends?: string[];
    /** False when any install-time execution was ambient / degraded. */
    enforced?: boolean;
  };
}

/**
 * The store's reference graph, keyed by referring store path.
 *
 * Deliberately not part of a generation record, for two reasons. It is keyed
 * by store path rather than by member alias because the paths that matter most
 * are the ones that are *not* members: a transitive runtime dependency is by
 * definition not something the project installed directly, and an edge map
 * that only the installed set can index cannot express a chain deeper than one
 * hop. And it lives beside the store rather than inside a generation because
 * gc forgets non-retained generation records — edges stored there would be
 * deleted while the paths they describe are still on disk, so a later gc would
 * collect live content.
 *
 * A store path referring to another is a fact about bytes on disk, not about
 * which generation is current. So the ledger only ever accumulates, and is
 * pruned exactly when a path is collected.
 *
 * opm resolves direct requirements only and its packages carry no embedded
 * store references, so nothing populates this today and the closure equals the
 * member set.
 */
export interface StoreReferences {
  referencesVersion: '1';
  edges: Record<string, string[]>;
}

export interface EnvironmentState {
  stateVersion: '1';
  environmentName: string;
  currentGenerationDigest: string;
  retainedGenerationDigests: string[];
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          Object.entries(item as Record<string, unknown>).sort(
            ([left], [right]) => (left < right ? -1 : 1),
          ),
        )
      : item,
  );

const sha256 = (text: string): string =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;

async function storeTreeDigestFromHandle(handle: FileHandle): Promise<string> {
  // Store files are hard-linked into projects, and another project doing so
  // while this one hashes must not read as the tree changing under it.
  return treeDigest(
    await collectFilesFromHandle(handle, '', '<directory handle>', {
      linkTolerant: true,
    }),
  );
}

function treeDigest(
  files: readonly {
    path: string;
    contents: Uint8Array;
    executable: boolean;
  }[],
): string {
  return sha256(
    canonical(
      files
        .map((file) => ({
          path: file.path,
          executable: file.executable,
          digest: `sha256:${createHash('sha256')
            .update(file.contents)
            .digest('hex')}`,
        }))
        .sort((left, right) => (left.path < right.path ? -1 : 1)),
    ),
  );
}

export async function stableStoreTreeDigest(path: string): Promise<string> {
  const handle = await openStableDirectory(path);
  try {
    const digest = await storeTreeDigestFromHandle(handle);
    await revalidateStableDirectory(path, handle);
    return digest;
  } finally {
    await handle.close();
  }
}

/**
 * The digest of a generation excludes the field that carries it, so it stays
 * recomputable from the record alone.
 */
export function generationDigest(
  generation: Omit<Generation, 'generationDigest'>,
): string {
  return sha256(canonical(generation));
}

/** What a generation means, ignoring when it was recorded. */
function contentKey(generation: Generation): string {
  return canonical({
    environmentName: generation.environmentName,
    lockDigest: generation.lockDigest,
    members: generation.members,
  });
}

/**
 * A store path, checked to be a direct child of this project's store.
 *
 * Reference edges name paths that gc will keep alive, so they are validated on
 * the way in rather than trusted from the ledger. Comparing against the
 * contained resolution is the check; passing a basename would make it
 * unconditionally true.
 */
function assertStorePath(store: string, value: string, what: string): string {
  if (value !== resolveContained(store, basename(value)))
    throw new OpmError(
      'UNSAFE_PATH',
      `${what} escapes the project store: ${value}`,
    );
  return value;
}

export function environmentPaths(root: string) {
  const paths = projectPaths(root);
  return {
    ...paths,
    generations: join(paths.opmDir, GENERATIONS_DIR),
    environmentState: join(paths.opmDir, ENVIRONMENT_STATE),
    storeReferences: join(paths.opmDir, STORE_REFERENCES),
  };
}

/** The recorded store reference graph, or an empty one. */
export async function readStoreReferences(
  root: string,
): Promise<StoreReferences> {
  const paths = environmentPaths(root);
  try {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const parsed = JSON.parse(
      await readStableFile(paths.storeReferences),
    ) as StoreReferences;
    if (parsed.referencesVersion !== '1')
      throw new OpmError(
        'INVALID_INPUT',
        `Unsupported store reference version: ${String(parsed.referencesVersion)}`,
      );
    return { referencesVersion: '1', edges: parsed.edges ?? {} };
  } catch (error) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { referencesVersion: '1', edges: {} };
    throw error;
  }
}

async function writeStoreReferences(
  root: string,
  references: StoreReferences,
): Promise<void> {
  const paths = environmentPaths(root);
  // Sorted so the file is stable under review and diffing, and written
  // through a temp file so an interrupted write leaves the old graph intact
  // rather than a truncated one gc would read as "nothing is referenced".
  const edges = Object.fromEntries(
    Object.entries(references.edges)
      .filter(([, targets]) => targets.length > 0)
      .map(
        ([from, targets]) =>
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          [from, [...new Set(targets)].sort()] as [string, string[]],
      )
      .sort((left, right) => (left[0] < right[0] ? -1 : 1)),
  );
  await writeStableFile(
    paths.storeReferences,
    `${JSON.stringify({ referencesVersion: '1', edges }, null, 2)}\n`,
  );
}

/**
 * Add observed edges to the store reference graph.
 *
 * Merging rather than replacing is the point: an edge is a fact about bytes
 * that are still on disk, so a later observation that does not mention it has
 * not retracted it.
 */
export async function mergeStoreReferences(input: {
  root: string;
  references: Readonly<Record<string, readonly string[]>>;
}): Promise<StoreReferences> {
  const paths = environmentPaths(input.root);
  const current = await readStoreReferences(input.root);
  const edges = { ...current.edges };
  for (const [from, to] of Object.entries(input.references)) {
    if (to.length === 0) continue;
    const source = assertStorePath(paths.store, from, 'Store reference source');
    const targets = to.map((path) =>
      assertStorePath(paths.store, path, 'Store reference target'),
    );
    edges[source] = [...new Set([...(edges[source] ?? []), ...targets])].sort();
  }
  const merged: StoreReferences = { referencesVersion: '1', edges };
  await writeStoreReferences(input.root, merged);
  return merged;
}

function generationFile(generations: string, digest: string): string {
  // The digest is the file name, so a traversal attempt cannot escape.
  const name = digest.replace(/^sha256:/u, '');
  if (!/^[0-9a-f]{64}$/u.test(name))
    throw new OpmError(
      'INVALID_DIGEST',
      `Invalid generation digest: ${digest}`,
    );
  return resolveContained(generations, `${name}.json`);
}

export async function readEnvironmentState(
  root: string,
): Promise<EnvironmentState | undefined> {
  try {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return JSON.parse(
      await readStableFile(environmentPaths(root).environmentState),
    ) as EnvironmentState;
  } catch (error) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Replace the pointer atomically: write a temporary file, then rename. */
async function writeEnvironmentState(
  root: string,
  state: EnvironmentState,
): Promise<void> {
  const paths = environmentPaths(root);
  await writeStableFile(
    paths.environmentState,
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

export async function readGeneration(
  root: string,
  digest: string,
): Promise<Generation> {
  const paths = environmentPaths(root);
  const handle = await openStableDirectory(paths.generations).catch((error) => {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new OpmError('NOT_FOUND', `Unknown generation: ${digest}`);
    throw error;
  });
  try {
    const name = basename(generationFile(paths.generations, digest));
    return parseGeneration(await readStableFileAt(handle, name), digest);
  } catch (error) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new OpmError('NOT_FOUND', `Unknown generation: ${digest}`);
    throw error;
  } finally {
    await handle.close();
  }
}

function parseGeneration(text: string, digest: string): Generation {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const generation = JSON.parse(text) as Generation;
  const { generationDigest: stored, ...body } = generation;
  if (stored !== digest || stored !== generationDigest(body))
    throw new OpmError(
      'DIGEST_MISMATCH',
      `Generation ${digest} does not match its recorded digest`,
    );
  if (
    generation.generationVersion !== '1' &&
    generation.generationVersion !== '2'
  )
    throw new OpmError('INVALID_STATE', 'Unsupported generation version');
  if (
    generation.generationVersion === '2' &&
    generation.members.some((member) => member.treeDigest === undefined)
  )
    throw new OpmError(
      'INVALID_STATE',
      'Generation v2 is missing a tree digest',
    );
  for (const member of generation.members)
    validateMemberBins(member.bins, generation.sequence);
  return generation;
}

/**
 * Fail closed on a stored member whose bins are malformed, the same way the
 * sibling structural checks above do: an interpreter this does not know must
 * not silently become Node at activation, and a path that escapes the store
 * must never reach a shim.
 */
function validateMemberBins(
  bins: GenerationMember['bins'],
  sequence: number,
): void {
  if (bins === undefined) return;
  if (!Array.isArray(bins))
    throw new OpmError(
      'INVALID_STATE',
      `Generation ${sequence} member bins must be an array`,
    );
  for (const [index, bin] of bins.entries()) {
    const what = `Generation ${sequence} member bins[${index}]`;
    if (typeof bin !== 'object' || bin === null || Array.isArray(bin))
      throw new OpmError('INVALID_STATE', `${what} must be an object`);
    if (typeof bin.name !== 'string' || bin.name === '')
      throw new OpmError('INVALID_STATE', `${what} name must be a string`);
    assertSafeSegment(bin.name, `${what} name`);
    if (typeof bin.path !== 'string' || bin.path === '')
      throw new OpmError('INVALID_STATE', `${what} path must be a string`);
    const segments = bin.path.split(/[/\\]/u).filter((part) => part !== '');
    if (
      segments.length === 0 ||
      segments.includes('..') ||
      bin.path.startsWith('/') ||
      /^[A-Za-z]:/u.test(bin.path)
    )
      throw new OpmError('INVALID_STATE', `${what} path escapes its store`);
    if (
      bin.interpreter !== undefined &&
      bin.interpreter !== 'node' &&
      bin.interpreter !== 'python' &&
      bin.interpreter !== 'dotnet' &&
      bin.interpreter !== 'native'
    )
      throw new OpmError('INVALID_STATE', `${what} has invalid interpreter`);
    if (bin.entry !== undefined && typeof bin.entry !== 'string')
      throw new OpmError('INVALID_STATE', `${what} has invalid entry`);
  }
}

export async function listGenerations(root: string): Promise<Generation[]> {
  const paths = environmentPaths(root);
  let handle: FileHandle;
  try {
    handle = await openStableDirectory(paths.generations);
  } catch (error) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const names = await readDirChild(handle);
    const generations = await Promise.all(
      names
        .filter((name) => /^[0-9a-f]{64}\.json$/u.test(name))
        .map(async (name) => {
          const digest = `sha256:${name.slice(0, -5)}`;
          return parseGeneration(await readStableFileAt(handle, name), digest);
        }),
    );
    return generations.sort((left, right) => left.sequence - right.sequence);
  } finally {
    await handle.close();
  }
}

/**
 * Append a generation for the installed set and make it current. The previous
 * generation is retained, so the switch is reversible.
 */
export async function recordGeneration(input: {
  root: string;
  environmentName?: string;
  packages: Readonly<Record<string, InstalledPackageRecord>>;
  lockDigest: string;
  createdAt?: string;
  /**
   * Runtime store references keyed by referring store path, when a caller has
   * discovered them. Entries for paths that are not members are the point:
   * that is how a chain deeper than one hop is expressed.
   */
  references?: Readonly<Record<string, readonly string[]>>;
  /** Optional sandbox summary for this install generation. */
  sandbox?: Generation['sandbox'];
}): Promise<Generation> {
  const paths = environmentPaths(input.root);
  const state = await readEnvironmentState(input.root);
  const environmentName =
    input.environmentName ?? state?.environmentName ?? 'default';
  const previous = state
    ? await readGeneration(input.root, state.currentGenerationDigest)
    : undefined;
  // Sequence is monotonic across the whole ledger, not derived from the
  // current pointer: after a rollback the current generation is an old one,
  // and reusing its successor number would produce two records with the same
  // sequence.
  const existing = await listGenerations(input.root);
  const highest = existing.reduce(
    (maximum, generation) => Math.max(maximum, generation.sequence),
    0,
  );

  const members: GenerationMember[] = (
    await Promise.all(
      Object.values(input.packages).map(async (record) => ({
        alias: record.alias,
        purl: record.purl,
        digest: record.digest,
        storePath: record.storePath,
        treeDigest: await stableStoreTreeDigest(record.storePath),
        // The declared bins the install wrote shims for, minus the derived
        // shim/target paths (activation re-derives those). Recorded so a
        // provider-declared bin survives activation even though its
        // ecosystem has no on-disk convention discovery could find.
        bins: record.bins.map((bin) => ({
          name: bin.name,
          path: bin.path,
          ...(!(bin.interpreter === undefined) && {
            interpreter: bin.interpreter,
          }),
          ...(!(bin.entry === undefined) && { entry: bin.entry }),
        })),
      })),
    )
  ).sort((left, right) => (left.alias < right.alias ? -1 : 1));

  // Edges go to the store ledger, not into the generation record: gc forgets
  // non-retained generations, and edges kept there would be forgotten with
  // them while the paths they describe are still on disk.
  if (input.references && Object.keys(input.references).length > 0)
    await mergeStoreReferences({
      root: input.root,
      references: input.references,
    });

  const body: Omit<Generation, 'generationDigest'> = {
    generationVersion: '2',
    environmentName,
    sequence: highest + 1,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(previous && { parentGenerationDigest: previous.generationDigest }),
    lockDigest: input.lockDigest,
    members,
    ...(!(input.sandbox === undefined) && { sandbox: input.sandbox }),
  };
  const generation: Generation = {
    ...body,
    generationDigest: generationDigest(body),
  };

  // Dedup on content, not on the record: two installs a second apart have
  // different timestamps but the same meaning, and a ledger that grows on
  // every no-op install is noise rather than history.
  if (previous && contentKey(previous) === contentKey(generation))
    return previous;

  await ensureStableDirectory(paths.generations);
  await writeStableFile(
    generationFile(paths.generations, generation.generationDigest),
    `${JSON.stringify(generation, null, 2)}\n`,
  );
  await writeEnvironmentState(input.root, {
    stateVersion: '1',
    environmentName,
    currentGenerationDigest: generation.generationDigest,
    retainedGenerationDigests: [
      ...new Set([
        ...(state?.retainedGenerationDigests ?? []),
        generation.generationDigest,
      ]),
    ].sort(),
  });
  return generation;
}

/** Activate an earlier generation, then atomically point the environment at it. */
export async function switchGeneration(input: {
  root: string;
  target: string | number;
}): Promise<Generation> {
  const state = await readEnvironmentState(input.root);
  if (!state)
    throw new OpmError('NO_PROJECT', 'This project has no environment history');
  const generations = await listGenerations(input.root);
  const target =
    typeof input.target === 'number'
      ? generations.find((item) => item.sequence === input.target)
      : generations.find((item) => item.generationDigest === input.target);
  if (!target)
    throw new OpmError('NOT_FOUND', `Unknown generation: ${input.target}`);
  if (!state.retainedGenerationDigests.includes(target.generationDigest))
    throw new OpmError(
      'NOT_FOUND',
      `Generation ${target.sequence} is no longer retained`,
    );
  await activateGeneration({ root: input.root, generation: target });
  await writeEnvironmentState(input.root, {
    ...state,
    currentGenerationDigest: target.generationDigest,
  });
  return target;
}

/** The generation before the current one, which is what a rollback selects. */
export async function rollbackTarget(
  root: string,
): Promise<Generation | undefined> {
  const state = await readEnvironmentState(root);
  if (!state) return undefined;
  const current = await readGeneration(root, state.currentGenerationDigest);
  if (current.parentGenerationDigest === undefined) return undefined;
  if (!state.retainedGenerationDigests.includes(current.parentGenerationDigest))
    throw new OpmError(
      'NOT_FOUND',
      'The previous generation was collected and can no longer be restored',
    );
  return readGeneration(root, current.parentGenerationDigest);
}

/**
 * Store paths outside the reference closure of every retained generation.
 *
 * Retained generations are the roots, exactly as the specification defines
 * collectibility, so rolling back never lands on content that was collected.
 */
export async function collectableStorePaths(input: {
  root: string;
  keep?: number;
}): Promise<{ collectable: string[]; retained: Generation[] }> {
  const paths = environmentPaths(input.root);
  const state = await readEnvironmentState(input.root);
  const generations = await listGenerations(input.root);
  if (!state || generations.length === 0)
    return { collectable: [], retained: [] };

  const keep = input.keep ?? generations.length;
  if (keep < 1)
    throw new OpmError(
      'INVALID_INPUT',
      'gc must retain at least one generation',
    );
  const current = generations.find(
    (item) => item.generationDigest === state.currentGenerationDigest,
  );
  // The current generation is always retained: collecting it would break the
  // installed environment.
  const newest = generations.slice(-keep);
  const retained =
    current && !newest.includes(current) ? [...newest, current] : newest;

  // Reachability, not direct membership: collection is defined over the
  // reference closure of the retained generations. Computed here over store
  // paths rather than through @openpacker/closure because that operates on
  // PREX node identities, which opm store paths are not.
  //
  // Edges come from the store ledger rather than from generation records,
  // which gc deletes. They accumulate and are never replaced: a store path
  // physically referring to another is a fact about bytes on disk, not about
  // which generation is current.
  const edges = new Map<string, readonly string[]>(
    Object.entries((await readStoreReferences(input.root)).edges),
  );
  const reachable = new Set<string>();
  const pending = retained.flatMap((generation) =>
    generation.members.map((member) => member.storePath),
  );
  while (pending.length > 0) {
    const current = pending.pop()!;
    // A visited set is what makes this terminate: store references are
    // routinely cyclic.
    if (reachable.has(current)) continue;
    reachable.add(current);
    pending.push(...(edges.get(current) ?? []));
  }
  let present: string[];
  let storeHandle: FileHandle | undefined;
  try {
    storeHandle = await openStableDirectory(paths.store);
    present = (await readDirChildWithTypes(storeHandle))
      .filter((entry) => entry.isDirectory() && !isStoreView(entry.name))
      .map((entry) => join(paths.store, entry.name));
  } catch (error) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { collectable: [], retained };
    throw error;
  } finally {
    await storeHandle?.close();
  }
  return {
    collectable: present.filter((path) => !reachable.has(path)).sort(),
    retained: retained.sort((left, right) => left.sequence - right.sequence),
  };
}

/** Delete unreachable store paths and forget the generations that named them. */
export async function collectGarbage(input: {
  root: string;
  keep?: number;
  dryRun?: boolean;
}): Promise<{ removed: string[]; retained: Generation[] }> {
  const { collectable, retained } = await collectableStorePaths(input);
  if (input.dryRun) return { removed: collectable, retained };

  for (const path of collectable) {
    await removeStableTree(path);
    await removeStableFile(`${path}.artifact`);
  }

  // Forget edges whose source was just collected. The ledger accumulates
  // otherwise, and an edge out of a path that no longer exists cannot describe
  // anything on disk. Edges *into* a collected path are dropped with it, so a
  // target that is gone is removed from every remaining source too.
  const collected = new Set(collectable);
  if (collectable.length > 0) {
    const references = await readStoreReferences(input.root);
    const edges = Object.fromEntries(
      Object.entries(references.edges)
        .filter(([from]) => !collected.has(from))
        .map(
          ([from, targets]) =>
            // SAFETY: The surrounding boundary establishes the asserted domain contract.
            [from, targets.filter((target) => !collected.has(target))] as [
              string,
              string[],
            ],
        )
        .filter(([, targets]) => targets.length > 0),
    );
    await writeStoreReferences(input.root, { referencesVersion: '1', edges });
  }

  const state = await readEnvironmentState(input.root);
  if (state) {
    const keepDigests = new Set(
      retained.map((generation) => generation.generationDigest),
    );
    const paths = environmentPaths(input.root);
    for (const generation of await listGenerations(input.root)) {
      if (keepDigests.has(generation.generationDigest)) continue;
      await removeStableFile(
        generationFile(paths.generations, generation.generationDigest),
      );
    }
    await writeEnvironmentState(input.root, {
      ...state,
      retainedGenerationDigests: [...keepDigests].sort(),
    });
  }
  return { removed: collectable, retained };
}

/**
 * The environment a shell should see for a generation: the bin directories
 * that generation's members provide, newest first.
 *
 * This is derived from the record rather than stored, so it is regenerable and
 * an interrupted switch cannot leave it half-written.
 */
export async function environmentVariables(input: {
  root: string;
  generation?: Generation;
}): Promise<Record<string, string>> {
  const paths = environmentPaths(input.root);
  const state = await readEnvironmentState(input.root);
  const generation =
    input.generation ??
    (state
      ? await readGeneration(input.root, state.currentGenerationDigest)
      : undefined);
  // A directory containing ':' cannot be expressed in PATH at all. Checked
  // here, where PATH is built, rather than in the script writer: every
  // consumer — `opm shell`, `--json`, anything embedding these variables —
  // gets a truncated search path otherwise, and only one of them was quoting.
  if (paths.bin.includes(':'))
    throw new OpmError(
      'UNSAFE_PATH',
      `The project bin directory contains ':', which PATH cannot represent: ${paths.bin}`,
    );
  return {
    OPM_PROJECT_ROOT: paths.root,
    OPM_BIN: paths.bin,
    ...(generation && {
      OPM_GENERATION: String(generation.sequence),
      OPM_ENVIRONMENT: generation.environmentName,
    }),
    PATH: [paths.bin, process.env.PATH ?? ''].filter(Boolean).join(':'),
  };
}

/**
 * Quote a value for POSIX `sh`.
 *
 * Delegated to `shell-quote` rather than written here. The bug this replaced
 * used `JSON.stringify`, where `$`, a backtick and `\` stay live, so a project
 * directory named `demo$(...)` executed under the documented
 * `eval "$(opm shell)"`. Shell quoting has more edge cases than it appears to
 * — `!` under history expansion, `#`, globs, embedded quotes — and getting
 * them right is not this project's problem to solve.
 */
export function shellQuote(value: string): string {
  return quote([value]);
}

/**
 * The environment as `export` statements for `eval "$(opm shell)"`.
 *
 * Variable names are fixed constants rather than data, so only values need
 * quoting; a caller adding a dynamic name would have to validate it here.
 */
export async function environmentScript(input: {
  root: string;
  generation?: Generation;
}): Promise<string> {
  const environment = await environmentVariables(input);
  return Object.entries(environment)
    .map(([name, value]) => `export ${name}=${shellQuote(value)}\n`)
    .join('');
}

/**
 * Rebuild the derived view for a generation from its own record plus store
 * content.
 *
 * This is why rollback works after the lock has moved on: a generation is
 * self-sufficient, so restoring it never depends on the current manifest or
 * lock still describing what it contained.
 */
export async function activateGeneration(input: {
  root: string;
  generation: Generation;
}): Promise<ProjectState> {
  const paths = environmentPaths(input.root);
  const store = await openStableDirectory(paths.store);
  const prepared: {
    member: GenerationMember;
    alias: string;
    bins: Awaited<ReturnType<typeof discoverBins>>;
    handle: FileHandle;
    treeDigest: string;
  }[] = [];
  const aliases = new Set<string>();
  const binNames = new Set<string>();
  try {
    // Validate the complete target before changing the currently active view.
    // A missing final member must not leave the first members half-activated.
    for (const member of input.generation.members) {
      const alias = assertSafeSegment(member.alias, 'package alias');
      if (aliases.has(alias))
        throw new OpmError(
          'INVALID_STATE',
          `Generation ${input.generation.sequence} declares duplicate alias ${alias}`,
        );
      aliases.add(alias);
      const expected = storePathForDigest(input.root, member.digest);
      if (member.storePath !== expected)
        throw new OpmError(
          'UNSAFE_PATH',
          `Generation store path is not derived from its digest: ${member.storePath}`,
        );
      const handle = await openChild(
        store,
        basename(expected),
        constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ELOOP')
          throw new OpmError(
            'UNSAFE_PATH',
            `Generation store path is linked: ${expected}`,
          );
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR')
          throw new OpmError(
            'NOT_FOUND',
            `Generation ${input.generation.sequence} needs ${expected}, which is no longer in the store`,
          );
        throw error;
      });
      const ecosystem = /^pkg:([^/]+)\//u.exec(member.purl)?.[1];
      if (!ecosystem) {
        await handle.close();
        throw new OpmError(
          'INVALID_STATE',
          `Generation ${input.generation.sequence} has invalid purl ${member.purl}`,
        );
      }
      try {
        await revalidateStableDirectory(paths.store, store);
        const [handleBefore, namedBefore] = await Promise.all([
          handle.stat({ bigint: true }),
          lstat(expected, { bigint: true }),
        ]);
        if (
          handleBefore.dev !== namedBefore.dev ||
          handleBefore.ino !== namedBefore.ino
        )
          throw new OpmError(
            'UNSAFE_PATH',
            `Generation store path changed while validating ${expected}`,
          );
        const actualTreeDigest = await storeTreeDigestFromHandle(handle);
        const [handleAfter, namedAfter] = await Promise.all([
          handle.stat({ bigint: true }),
          lstat(expected, { bigint: true }),
        ]);
        await revalidateStableDirectory(paths.store, store);
        if (
          handleBefore.dev !== handleAfter.dev ||
          handleBefore.ino !== handleAfter.ino ||
          handleAfter.dev !== namedAfter.dev ||
          handleAfter.ino !== namedAfter.ino
        )
          throw new OpmError(
            'UNSAFE_PATH',
            `Generation store path changed while validating ${expected}`,
          );
        const expectedTreeDigest = member.treeDigest ?? actualTreeDigest;
        if (actualTreeDigest !== expectedTreeDigest)
          throw new OpmError(
            'DIGEST_MISMATCH',
            `Generation ${input.generation.sequence} store tree does not match ${expectedTreeDigest}`,
          );
        // Recorded bins win: a member installed after bins were pinned
        // carries the declarations its install wrote shims for, and
        // provider-declared bins have no on-disk convention to re-derive
        // them from. Discovery is the fallback for records that predate
        // pinned bins — absent `bins` means exactly that, so legacy
        // generations activate exactly as they always did.
        const bins =
          member.bins === undefined
            ? await discoverBins(expected, ecosystem)
            : member.bins;
        for (const bin of bins) {
          const name = assertSafeSegment(bin.name, 'bin name');
          if (binNames.has(name))
            throw new OpmError(
              'INVALID_STATE',
              `Generation ${input.generation.sequence} declares duplicate bin ${name}`,
            );
          binNames.add(name);
        }
        prepared.push({
          member,
          alias,
          bins,
          handle,
          treeDigest: expectedTreeDigest,
        });
      } catch (error) {
        await handle.close();
        throw error;
      }
    }

    await revalidatePreparedTrees(prepared);
    await ensureStableDirectory(paths.bin);
    await ensureStableDirectory(paths.links);
    const previous = await readProjectState(paths.projectState);
    for (const record of Object.values(previous?.packages ?? {}))
      await removeBinShims(
        paths.bin,
        record.bins.map((bin) => bin.name),
      );

    const state: ProjectState = { schemaVersion: 1, packages: {} };
    for (const { member, alias, bins } of prepared) {
      const shims = await writeBinShims({
        binDir: paths.bin,
        storeRoot: member.storePath,
        bins,
      });
      await writeStableFile(
        resolveContained(paths.links, alias),
        `${JSON.stringify(
          {
            alias,
            purl: member.purl,
            storePath: member.storePath,
            digest: member.digest,
          },
          null,
          2,
        )}\n`,
      );
      state.packages[alias] = {
        alias,
        purl: member.purl,
        digest: member.digest,
        storePath: member.storePath,
        bins: shims,
        installedAt: input.generation.createdAt,
      };
    }
    await revalidatePreparedTrees(prepared);
    await writeProjectState(paths.projectState, state);
    return state;
  } finally {
    await Promise.all(prepared.map(({ handle }) => handle.close()));
    await store.close();
  }
}

async function revalidatePreparedTrees(
  prepared: readonly { handle: FileHandle; treeDigest: string }[],
): Promise<void> {
  for (const item of prepared)
    if ((await storeTreeDigestFromHandle(item.handle)) !== item.treeDigest)
      throw new OpmError(
        'DIGEST_MISMATCH',
        'Generation store tree changed during activation',
      );
}

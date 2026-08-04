import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  OpmError,
  type InstalledPackageRecord,
  type ProjectState,
} from './types.js';
import { assertSafeSegment, projectPaths, resolveContained } from './paths.js';
import { discoverNpmBins, removeBinShims, writeBinShims } from './bins.js';
import { readProjectState, writeProjectState } from './install.js';

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

export interface GenerationMember {
  alias: string;
  purl: string;
  digest: string;
  storePath: string;
}

export interface Generation {
  generationVersion: '1';
  environmentName: string;
  sequence: number;
  createdAt: string;
  parentGenerationDigest?: string;
  lockDigest: string;
  members: GenerationMember[];
  generationDigest: string;
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
          Object.entries(item as Record<string, unknown>).sort(
            ([left], [right]) => (left < right ? -1 : 1),
          ),
        )
      : item,
  );

const sha256 = (text: string): string =>
  `sha256:${createHash('sha256').update(text).digest('hex')}`;

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

export function environmentPaths(root: string) {
  const paths = projectPaths(root);
  return {
    ...paths,
    generations: join(paths.opmDir, GENERATIONS_DIR),
    environmentState: join(paths.opmDir, ENVIRONMENT_STATE),
  };
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
    return JSON.parse(
      await readFile(environmentPaths(root).environmentState, 'utf8'),
    ) as EnvironmentState;
  } catch (error) {
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
  await mkdir(paths.opmDir, { recursive: true });
  const temporary = `${paths.environmentState}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, paths.environmentState);
}

export async function readGeneration(
  root: string,
  digest: string,
): Promise<Generation> {
  const paths = environmentPaths(root);
  try {
    const generation = JSON.parse(
      await readFile(generationFile(paths.generations, digest), 'utf8'),
    ) as Generation;
    // A record whose digest does not match its content has been edited.
    const { generationDigest: stored, ...body } = generation;
    if (stored !== generationDigest(body))
      throw new OpmError(
        'DIGEST_MISMATCH',
        `Generation ${digest} does not match its recorded digest`,
      );
    return generation;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new OpmError('NOT_FOUND', `Unknown generation: ${digest}`);
    throw error;
  }
}

export async function listGenerations(root: string): Promise<Generation[]> {
  const paths = environmentPaths(root);
  let names: string[];
  try {
    names = await readdir(paths.generations);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const generations = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map((name) => readGeneration(root, `sha256:${name.slice(0, -5)}`)),
  );
  return generations.sort((left, right) => left.sequence - right.sequence);
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

  const members: GenerationMember[] = Object.values(input.packages)
    .map((record) => ({
      alias: record.alias,
      purl: record.purl,
      digest: record.digest,
      storePath: record.storePath,
    }))
    .sort((left, right) => (left.alias < right.alias ? -1 : 1));

  const body: Omit<Generation, 'generationDigest'> = {
    generationVersion: '1',
    environmentName,
    sequence: highest + 1,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(previous ? { parentGenerationDigest: previous.generationDigest } : {}),
    lockDigest: input.lockDigest,
    members,
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

  await mkdir(paths.generations, { recursive: true });
  await writeFile(
    generationFile(paths.generations, generation.generationDigest),
    `${JSON.stringify(generation, null, 2)}\n`,
    'utf8',
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

/**
 * Point the environment at an earlier generation. The record is never
 * rewritten, so rolling back is itself reversible.
 */
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

  const reachable = new Set(
    retained.flatMap((generation) =>
      generation.members.map((member) => member.storePath),
    ),
  );
  let present: string[];
  try {
    present = (await readdir(paths.store, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(paths.store, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { collectable: [], retained };
    throw error;
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

  for (const path of collectable)
    await rm(path, { recursive: true, force: true });

  const state = await readEnvironmentState(input.root);
  if (state) {
    const keepDigests = new Set(
      retained.map((generation) => generation.generationDigest),
    );
    const paths = environmentPaths(input.root);
    for (const generation of await listGenerations(input.root)) {
      if (keepDigests.has(generation.generationDigest)) continue;
      await rm(generationFile(paths.generations, generation.generationDigest), {
        force: true,
      });
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
  return {
    OPM_PROJECT_ROOT: paths.root,
    OPM_BIN: paths.bin,
    ...(generation
      ? {
          OPM_GENERATION: String(generation.sequence),
          OPM_ENVIRONMENT: generation.environmentName,
        }
      : {}),
    PATH: [paths.bin, process.env.PATH ?? ''].filter(Boolean).join(':'),
  };
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
  await mkdir(paths.bin, { recursive: true });
  await mkdir(paths.links, { recursive: true });

  const previous = await readProjectState(paths.projectState);
  for (const record of Object.values(previous?.packages ?? {}))
    await removeBinShims(
      paths.bin,
      record.bins.map((bin) => bin.name),
    );

  const state: ProjectState = { schemaVersion: 1, packages: {} };
  for (const member of input.generation.members) {
    const alias = assertSafeSegment(member.alias, 'package alias');
    // The store path is content-addressed and immutable, so if it is gone the
    // generation is genuinely unrestorable — say so rather than half-restore.
    // Every other generation field is validated; the store path must be too,
    // even though the record is digest-verified.
    resolveContained(paths.store, basename(member.storePath));
    const bins = await discoverNpmBins(member.storePath).catch(() => {
      throw new OpmError(
        'NOT_FOUND',
        `Generation ${input.generation.sequence} needs ${member.storePath}, which is no longer in the store`,
      );
    });
    const shims = await writeBinShims({
      binDir: paths.bin,
      storeRoot: member.storePath,
      bins,
    });
    await writeFile(
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
      'utf8',
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
  await writeProjectState(paths.projectState, state);
  return state;
}

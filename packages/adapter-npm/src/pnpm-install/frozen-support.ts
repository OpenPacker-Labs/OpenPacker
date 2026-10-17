/**
 * A project a lock is fresh for, written from the lock itself, for the suites
 * that read a lock through `readFrozenPnpmLock` (`frozen*.test.ts`,
 * `stale.test.ts`): each importer's `package.json` says what the lock records
 * for it, the root one carries the lock's overrides, and `pnpm-workspace.yaml`
 * its catalogs. A test then changes one thing.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DetectedProject,
  FrozenLock,
  FrozenLockOptions,
  WorkspaceMember,
} from '@openpacker/adapter-core';
import { afterEach } from 'vitest';
import { readPnpmLock } from '../pnpm-lock/index.js';
import { buildPnpmModel } from './model.js';
import { readFrozenPnpmLock } from './frozen.js';

export const LINUX = {
  os: 'linux',
  architecture: 'x64',
  libc: 'glibc',
} as const;

export type Manifest = Record<string, unknown>;

export interface Tweaks {
  /** Change an importer's manifest (id `.` is the project). */
  manifest?: (id: string, manifest: Manifest) => Manifest;
  /** Replaces the generated `pnpm-workspace.yaml`. */
  workspaceYaml?: string;
  /** Extra keys for the root `package.json`. */
  root?: Manifest;
  /** Change the members found on disk (a member removed, or one added). */
  disk?: (members: WorkspaceMember[]) => WorkspaceMember[];
}

export interface World {
  project: DetectedProject;
  lockPath: string;
  members: WorkspaceMember[];
  read(options?: Partial<FrozenLockOptions>): Promise<FrozenLock>;
}

const temps: string[] = [];
let installed = false;
function cleanupAfterEach(): void {
  if (installed) return;
  installed = true;
  afterEach(async () => {
    await Promise.all(
      temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });
}

const record = (
  list: readonly { name: string; specifier: string }[],
): Record<string, string> | undefined =>
  list.length === 0
    ? undefined
    : Object.fromEntries(list.map((d) => [d.name, d.specifier]));

/** The name each member is linked by, for those that are linked. */
function linkNames(
  lock: ReturnType<typeof buildPnpmModel>,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const top of lock.tops.values())
    for (const edge of top.edges)
      if (edge.kind === 'link' && edge.memberId !== undefined)
        names.set(edge.memberId, edge.as);
  return names;
}

/** A member as discovery gives one, with the dependency lists of `manifest`. */
export function member(
  dir: string,
  manifest: Manifest,
  name: string,
): WorkspaceMember {
  const map = (value: unknown) =>
    new Map(Object.entries((value as Record<string, string>) ?? {}));
  return {
    dir,
    root: dir === '',
    name,
    nameFromDirectory: false,
    manifest: {
      name,
      version: undefined,
      private: true,
      dependencies: map(manifest['dependencies']),
      devDependencies: map(manifest['devDependencies']),
      optionalDependencies: map(manifest['optionalDependencies']),
      peerDependencies: map(manifest['peerDependencies']),
      optionalPeers: new Set(),
      workspaces: undefined,
      bin: {},
    },
  };
}

export async function worldOf(
  lock: Uint8Array | string,
  tweaks: Tweaks = {},
): Promise<World> {
  cleanupAfterEach();
  const bytes =
    typeof lock === 'string' ? new TextEncoder().encode(lock) : lock;
  const parsed = readPnpmLock(bytes).lock;
  const model = buildPnpmModel(parsed);
  const names = linkNames(model);
  const dir = await mkdtemp(join(tmpdir(), 'pnpm-world-'));
  temps.push(dir);
  const lockPath = join(dir, 'pnpm-lock.yaml');
  await writeFile(lockPath, bytes);
  const members: WorkspaceMember[] = [];
  let rootManifest: Manifest = {};
  for (const importer of parsed.importers) {
    const id = importer.id;
    const name = id === '.' ? 'app' : (names.get(id) ?? id.split('/').at(-1)!);
    let manifest: Manifest = {
      name,
      dependencies: record(importer.dependencies),
      devDependencies: record(importer.devDependencies),
      optionalDependencies: record(importer.optionalDependencies),
    };
    for (const key of Object.keys(manifest))
      if (manifest[key] === undefined) delete manifest[key];
    manifest = tweaks.manifest?.(id, manifest) ?? manifest;
    if (id === '.') rootManifest = manifest;
    members.push(
      member(
        id === '.' ? '' : id,
        manifest,
        typeof manifest['name'] === 'string' ? manifest['name'] : name,
      ),
    );
  }
  if (!parsed.importers.some((importer) => importer.id === '.'))
    rootManifest = { name: 'app' };
  const overrides = Object.fromEntries(parsed.overrides);
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      ...rootManifest,
      ...(parsed.overrides.size > 0 && { pnpm: { overrides } }),
      ...tweaks.root,
    }),
  );
  const catalogs = [...parsed.catalogs]
    .map(
      ([name, entries]) =>
        `  ${JSON.stringify(name)}:\n${[...entries]
          .map(
            ([dependency, entry]) =>
              `    ${JSON.stringify(dependency)}: ${JSON.stringify(entry.specifier)}`,
          )
          .join('\n')}`,
    )
    .join('\n');
  await writeFile(
    join(dir, 'pnpm-workspace.yaml'),
    tweaks.workspaceYaml ?? (catalogs === '' ? '' : `catalogs:\n${catalogs}\n`),
  );
  const project: DetectedProject = {
    root: dir,
    manifestPath: join(dir, 'package.json'),
  };
  const found = parsed.importers.length > 1 ? members : [];
  const disk = tweaks.disk?.(found) ?? found;
  return {
    project,
    lockPath,
    members,
    read: (options = {}) =>
      readFrozenPnpmLock(
        project,
        {
          target: LINUX,
          omit: new Set(),
          workspace: { disk: async () => disk, scope: { kind: 'all' } },
          ...options,
        },
        lockPath,
      ),
  };
}

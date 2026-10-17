/**
 * `pnpm-lock.yaml` as a frozen install reads it (ADR 0055).
 *
 * The same answer `readFrozenPackageLock` gives for an npm lock, in the same
 * order: what the lock says by itself is refused first, then what needs the
 * project's own files, then what needs the machine, then the places, and
 * nothing is fetched or removed before the last. A pnpm lock records edges and
 * not places, so the places are chosen here (`place.ts`) and proved
 * (`place-check.ts`); from there the host takes them as it takes an npm lock's.
 */

import { createHash } from 'node:crypto';
import type {
  DetectedProject,
  FrozenLock,
  FrozenLockOptions,
  FrozenLockPackage,
  FrozenLockRefusal,
  FrozenLockWorkspace,
  WorkspaceMember,
} from '@openpacker/adapter-core';
import { ProviderError } from '@openpacker/adapter-core';
import { MAXIMUM_LOCK_BYTES, readBoundedBytes } from '../frozen-read.js';
import {
  freshnessProblems,
  memberProblems,
  presentImporters,
  readRootProject,
  refuseStale,
} from './check.js';
import { linkTargetBetween, placePath } from '../layout-links.js';
import { npmPurl } from '../purl.js';
import { readPnpmLock } from '../pnpm-lock/index.js';
import { isSemver } from '../pnpm-lock/source.js';
import { buildPnpmModel, type PnpmInstance, type PnpmModel } from './model.js';
import { planPlacement } from './place.js';
import { placeInputOf } from './place-input.js';
import { resolutionProblems } from './place-check.js';
import {
  importerRefusals,
  lockRefusals,
  sourceOfInstance,
  type InstanceSource,
} from './refuse.js';
import { lockPatches } from './patches.js';
import { readProjectPatches } from './patch-files.js';
import { selectTops } from './scope.js';
import { platformsOf } from './targets.js';
import { selectInstances, type Selection } from './select.js';

const PUBLIC_REGISTRY = 'https://registry.npmjs.org';

/** The refusals of the instances being installed: where they come from, what pins them. */
function instanceSources(
  model: PnpmModel,
  selection: Selection,
  registry: string,
): { sources: Map<string, InstanceSource>; refused: FrozenLockRefusal[] } {
  const sources = new Map<string, InstanceSource>();
  const refused: FrozenLockRefusal[] = [];
  for (const key of selection.included.keys()) {
    const source = sourceOfInstance(model.instances.get(key)!, registry);
    if ('problem' in source)
      refused.push({ path: key, reason: source.problem });
    else sources.set(key, source);
  }
  return { sources, refused };
}

/** Read `pnpm-lock.yaml` in `project` for a frozen install. */
export async function readFrozenPnpmLock(
  project: DetectedProject,
  options: FrozenLockOptions,
  lockPath: string,
): Promise<FrozenLock> {
  const bytes = await readBoundedBytes(lockPath, MAXIMUM_LOCK_BYTES);
  const { lock } = readPnpmLock(bytes);
  const model = buildPnpmModel(lock);
  const common = {
    lockPath,
    lockDigest: createHash('sha256').update(bytes).digest('hex'),
    lockfileVersion: 9,
    // pnpm extracts with the same tolerance npm does.
    extraction: { acceptRedundantEntries: true },
  };
  const refuse = (refused: FrozenLockRefusal[]): FrozenLock => ({
    ...common,
    packages: [],
    skipped: [],
    refused,
  });

  // 1. What the lock says by itself.
  const patching = lockPatches(model);
  const wholeLock = [...lockRefusals(model), ...patching.refused];
  if (wholeLock.length > 0) return refuse(wholeLock);
  if (options.omit.has('peer'))
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'opm ci --omit peer does not apply to a pnpm lock: it writes resolved peers as ordinary dependencies, so there is nothing to omit them by',
    );
  // The project's own files: its settings, and the members its workspace has.
  // pnpm installs the importers the project has and leaves alone any the lock
  // still lists after their member went (ADR 0055 §15).
  const root = await readRootProject(project);
  const disk = (await options.workspace?.disk()) ?? [];
  const present =
    options.workspace === undefined
      ? new Set(model.tops.keys())
      : presentImporters(model, disk);
  const tops = selectTops(model, options.workspace?.scope, present);
  const targets = platformsOf(options, root.config);
  const selection = selectInstances({
    model,
    tops,
    omit: options.omit,
    targets,
  });
  const { sources, refused: sourceRefusals } = instanceSources(
    model,
    selection,
    options.registry ?? PUBLIC_REGISTRY,
  );
  const lockOnly = [
    ...importerRefusals(model, tops, present),
    ...sourceRefusals,
  ];
  if (lockOnly.length > 0) return refuse(lockOnly);

  // 2. What needs the project's own files.
  const members =
    options.workspace === undefined ? [] : memberProblems(model, disk);
  if (members.length > 0)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      `pnpm-lock.yaml does not list every member of the project's workspace (opm ci installs what the lock lists, and a member with dependencies has to be in it; pnpm install writes it there): ${members.join('; ')}`,
    );
  // The patch files first, as pnpm hashes them before it compares anything.
  const declared = await readProjectPatches(
    project.root,
    root.config,
    model.lock,
  );
  const { stale } = freshnessProblems({ root, model, present, disk });
  if (stale.length + declared.stale.length > 0)
    refuseStale([...stale, ...declared.stale]);

  // 3. What needs the machine.
  if (selection.refused.length > 0) return refuse([...selection.refused]);

  // 4. The places.
  const input = placeInputOf(model, selection, tops);
  const placement = planPlacement(input);
  if (placement.problems.length > 0)
    return refuse(
      placement.problems.map((reason) => ({ path: 'node_modules', reason })),
    );
  const unresolved = resolutionProblems(input, placement);
  if (unresolved.length > 0)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      `the layout opm planned for ${project.root} does not resolve every dependency, which is a defect in the planner and not in the lock; nothing was installed: ${unresolved.slice(0, 5).join('; ')}${unresolved.length > 5 ? `; and ${unresolved.length - 5} more` : ''}`,
    );

  const packages = placement.placed.map((place): FrozenLockPackage => {
    const instance = model.instances.get(place.key)!;
    const source = sources.get(place.key)!;
    const patch = patching.byInstance.get(place.key);
    return {
      path: placePath(place.chain, place.base),
      name: place.chain.at(-1)!,
      packageName: instance.name,
      version: instance.version,
      purl: npmPurl(instance.name),
      exactPurl: `${npmPurl(instance.name)}@${instance.version}`,
      source: source.url,
      sourceKind: source.kind,
      integrity: source.integrity,
      direct: place.direct,
      scope: selection.included.get(place.key)!,
      hasInstallScript: false,
      scriptsFromArchive: true,
      archiveIdentity: archiveIdentityOf(instance),
      instance: place.key,
      ...(instance.pkg.deprecated !== undefined && {
        deprecated: instance.pkg.deprecated,
      }),
      // Every key of the lock is the project's once the lock is fresh.
      ...(patch !== undefined && { patch: declared.patches.get(patch)! }),
    };
  });
  const workspace = workspaceOf(model, tops, present, placement.links, disk);
  return {
    ...common,
    ...(targets.length > 1 && { targets }),
    packages,
    skipped: [...selection.skipped],
    refused: [],
    ...(workspace !== undefined && { workspace }),
  };
}

/**
 * What the lock says an instance's archive holds, as pnpm reads it to check the
 * archive (`nameVerFromPkgSnapshot`): the entry's `version`, else the key's when
 * it is a version (a tarball's key has its URL there, and then no version is
 * compared); and the entry's `name`, which pnpm no longer writes, when there is
 * one.
 */
function archiveIdentityOf(instance: PnpmInstance): {
  name?: string;
  version?: string;
} {
  const version =
    instance.pkg.manifestVersion ??
    (isSemver(instance.version) ? instance.version : undefined);
  return {
    ...(instance.pkg.manifestName !== undefined && {
      name: instance.pkg.manifestName,
    }),
    ...(version !== undefined && { version }),
  };
}

/** What the layout links and shims: the installed members, and the project's link to each. */
function workspaceOf(
  model: PnpmModel,
  tops: ReadonlySet<string>,
  present: ReadonlySet<string>,
  links: readonly { name: string; memberDir: string }[],
  disk: readonly WorkspaceMember[],
): FrozenLockWorkspace | undefined {
  // Only the members the project has: a directory the lock remembers and the
  // workspace no longer declares is not the install's to clear.
  const dirs = [...model.tops.values()]
    .filter((top) => present.has(top.id))
    .map((top) => top.dir)
    .filter((dir) => dir !== '');
  if (dirs.length === 0) return undefined;
  const byDir = new Map(disk.map((member) => [member.dir, member]));
  return {
    memberDirs: dirs,
    layout: {
      members: [...tops]
        .map((id) => model.tops.get(id)!.dir)
        .filter((dir) => dir !== '')
        .sort()
        .map((dir) => {
          const member = byDir.get(dir);
          return {
            dir,
            name: member?.name ?? dir,
            bin: member?.manifest.bin ?? {},
          };
        }),
      links: links.map((link) => {
        const path = `node_modules/${link.name}`;
        return { path, target: linkTargetBetween(path, link.memberDir) };
      }),
    },
  };
}

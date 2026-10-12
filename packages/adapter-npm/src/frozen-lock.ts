/**
 * `package-lock.json` and `package.json` as a frozen install reads them.
 *
 * This reads the two files (no-follow, bounded), checks that the lock still
 * matches its manifest and, in a workspace, the members on disk, lists what a
 * workspace lock holds that cannot be installed, and hands the rest to the
 * selection in `frozen-select.ts`.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  echoed,
  ProviderError,
  type DetectedProject,
  type FrozenLock,
  type FrozenLockOptions,
  type WorkspaceMember,
} from '@openpacker/adapter-core';
import { assertPlaceable } from './frozen-placement.js';
import {
  MAXIMUM_LOCK_BYTES,
  MAXIMUM_MANIFEST_BYTES,
  readBounded,
} from './frozen-read.js';
import { planFrozenPackageLock } from './frozen-select.js';
import {
  DEPENDENCY_FIELDS,
  lockDisagreements,
  manifestOfMember,
  memberDisagreements,
  memberListDisagreements,
  type FrozenManifest,
} from './frozen-sync.js';
import { parsePackageLockText } from './lock-tree.js';

export { lockDisagreements, type FrozenManifest };

type StringMap = Readonly<Record<string, string>>;

export function readManifest(text: string, path: string): FrozenManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ProviderError(
      'INVALID_MANIFEST',
      `${path} is not valid JSON: ${echoed(error instanceof Error ? error.message : String(error))}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new ProviderError(
      'INVALID_MANIFEST',
      `${path} must be a JSON object`,
    );
  // SAFETY: checked above to be a plain object; fields are validated below.
  const record = parsed as Record<string, unknown>;
  const field = (name: (typeof DEPENDENCY_FIELDS)[number]): StringMap => {
    const value = record[name];
    if (value === undefined) return {};
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new ProviderError(
        'INVALID_MANIFEST',
        `${path}: ${name} must be an object`,
      );
    const out: Record<string, string> = {};
    for (const [key, spec] of Object.entries(value)) {
      if (typeof spec !== 'string')
        throw new ProviderError(
          'INVALID_MANIFEST',
          `${path}: ${name}.${echoed(key)} must be a string`,
        );
      out[key] = spec;
    }
    return out;
  };
  return {
    dependencies: field('dependencies'),
    devDependencies: field('devDependencies'),
    optionalDependencies: field('optionalDependencies'),
    peerDependencies: field('peerDependencies'),
    ...(record.workspaces !== undefined && { workspaces: record.workspaces }),
  };
}

/** Read `package.json` and `package-lock.json` in `project` for a frozen install. */
export async function readFrozenPackageLock(
  project: DetectedProject,
  options: FrozenLockOptions,
): Promise<FrozenLock> {
  if (options.architectures === 'project')
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'opm ci --supported-architectures project: a package.json has no supportedArchitectures setting (pnpm has); name the platforms with --os, --cpu and --libc',
    );
  const lockPath =
    project.relatedPaths?.lock ?? join(project.root, 'package-lock.json');
  const lockText = await readBounded(lockPath, MAXIMUM_LOCK_BYTES).catch(
    (error: unknown) => {
      if (error instanceof ProviderError && error.code === 'NOT_FOUND')
        throw new ProviderError(
          'NOT_FOUND',
          `No package-lock.json in ${project.root}. A frozen install installs exactly what a lock says; create one with npm install --package-lock-only`,
        );
      throw error;
    },
  );
  const manifestText = await readBounded(
    project.manifestPath,
    MAXIMUM_MANIFEST_BYTES,
  ).catch((error: unknown) => {
    if (error instanceof ProviderError && error.code === 'NOT_FOUND')
      throw new ProviderError(
        'NOT_FOUND',
        `No package.json in ${project.root}`,
      );
    throw error;
  });
  const tree = parsePackageLockText(lockText);
  const manifest = readManifest(manifestText, project.manifestPath);
  const common = {
    lockPath,
    lockDigest: createHash('sha256').update(lockText).digest('hex'),
    lockfileVersion: tree.lockfileVersion,
    // npm's own extractor takes `./` segments and a repeated identical file
    // as they come, and agent-base@7.1.4 is published with both.
    extraction: { acceptRedundantEntries: true },
  };
  const refused = tree.workspace?.refused ?? [];
  if (refused.length > 0)
    return { ...common, packages: [], skipped: [], refused: [...refused] };
  // The workspace on disk is looked at only where there is one to hold the lock
  // to; a project with none is read as it always was.
  const disk =
    tree.workspace !== undefined || manifest.workspaces !== undefined
      ? ((await options.workspace?.disk()) ?? [])
      : [];
  const disagreements = [
    ...workspaceDisagreements(tree, disk),
    ...lockDisagreements(tree, manifest),
    ...memberManifestDisagreements(tree, disk),
  ];
  if (disagreements.length > 0)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      `package.json and package-lock.json are not in sync (npm ci would refuse too): ${disagreements.slice(0, 20).join('; ')}${disagreements.length > 20 ? `; and ${disagreements.length - 20} more` : ''}`,
    );
  const plan = planFrozenPackageLock({ tree, options });
  // The places are the lock's keys: a lock whose places cannot be written is
  // refused now, before anything is fetched or the project's node_modules goes.
  assertPlaceable(plan);
  return { ...common, ...plan };
}

/** How the members the lock lists differ from the ones the project declares. */
function workspaceDisagreements(
  tree: ReturnType<typeof parsePackageLockText>,
  disk: readonly WorkspaceMember[],
): string[] {
  const lines = memberListDisagreements(tree.workspace?.members ?? [], disk);
  return lines.length === 0
    ? []
    : [`the workspace members differ (${lines.join('; ')})`];
}

/** Each member the lock and the disk both have, against its own `package.json`. */
function memberManifestDisagreements(
  tree: ReturnType<typeof parsePackageLockText>,
  disk: readonly WorkspaceMember[],
): string[] {
  const onDisk = new Map(disk.map((member) => [member.dir, member]));
  return (tree.workspace?.members ?? []).flatMap((member) => {
    const there = onDisk.get(member.dir);
    return there === undefined
      ? []
      : memberDisagreements(tree, member, manifestOfMember(there));
  });
}

/** How the members the lock lists differ from the ones the project declares. */
function workspaceDisagreements(
  tree: ReturnType<typeof parsePackageLockText>,
  disk: readonly WorkspaceMember[],
): string[] {
  const lines = memberListDisagreements(tree.workspace?.members ?? [], disk);
  return lines.length === 0
    ? []
    : [`the workspace members differ (${lines.join('; ')})`];
}

/** Each member the lock and the disk both have, against its own `package.json`. */
function memberManifestDisagreements(
  tree: ReturnType<typeof parsePackageLockText>,
  disk: readonly WorkspaceMember[],
): string[] {
  const onDisk = new Map(disk.map((member) => [member.dir, member]));
  return (tree.workspace?.members ?? []).flatMap((member) => {
    const there = onDisk.get(member.dir);
    return there === undefined
      ? []
      : memberDisagreements(tree, member, manifestOfMember(there));
  });
}

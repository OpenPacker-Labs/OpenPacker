/**
 * `package-lock.json` and `package.json` as a frozen install reads them.
 *
 * This reads the two files (no-follow, bounded), checks that the lock still
 * matches its manifest, turns workspaces into a refusal list, and hands the
 * rest to the selection in `frozen-select.ts`.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ProviderError,
  type DetectedProject,
  type FrozenLock,
  type FrozenLockOptions,
  type FrozenLockRefusal,
} from '@openpacker/adapter-core';
import { planFrozenPackageLock } from './frozen-select.js';
import {
  parsePackageLockText,
  type LockEntry,
  type PackageLockTree,
} from './lock-tree.js';
import { npmSatisfies } from './npm-range.js';

const MAXIMUM_LOCK_BYTES = 64 * 1024 * 1024;
const MAXIMUM_MANIFEST_BYTES = 4 * 1024 * 1024;

type StringMap = Readonly<Record<string, string>>;

/** The parts of `package.json` a frozen install checks the lock against. */
export interface FrozenManifest {
  dependencies: StringMap;
  devDependencies: StringMap;
  optionalDependencies: StringMap;
  peerDependencies: StringMap;
  workspaces?: unknown;
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/**
 * Why the lock does not match `package.json`, one line per difference.
 *
 * `npm ci` refuses to install when they disagree, and so does this: a lock
 * that is behind its manifest installs something other than what the project
 * asks for.
 */
export function lockDisagreements(
  tree: PackageLockTree,
  manifest: FrozenManifest,
): string[] {
  const problems: string[] = [];
  const root = tree.root;
  const byPath = new Map(tree.entries.map((entry) => [entry.path, entry]));
  for (const field of DEPENDENCY_FIELDS) {
    const declared = manifest[field];
    const locked = root?.[field] ?? {};
    for (const name of Object.keys(declared))
      if (!(name in locked))
        problems.push(
          `${field}.${name} is in package.json and not in the lock`,
        );
    for (const name of Object.keys(locked))
      if (!(name in declared))
        problems.push(
          `${field}.${name} is in the lock and no longer in package.json`,
        );
    for (const [name, spec] of Object.entries(declared)) {
      const entry = byPath.get(`node_modules/${name}`);
      if (entry === undefined) {
        if (field === 'dependencies' || field === 'devDependencies')
          problems.push(`${name} (${field}) has no entry in the lock`);
        continue;
      }
      const problem = specProblem(entry, spec);
      if (problem !== undefined) problems.push(`${field}.${name}: ${problem}`);
    }
  }
  return problems;
}

/** Why a locked entry does not satisfy a manifest spec, or undefined. */
function specProblem(entry: LockEntry, spec: string): string | undefined {
  let range = spec.trim();
  if (range.startsWith('npm:')) {
    const alias = /^npm:((?:@[^/@]+\/)?[^@/]+)(?:@(.+))?$/u.exec(range);
    if (alias === null) return undefined;
    if (alias[1] !== entry.packageName)
      return `package.json asks for ${spec}, the lock has ${entry.packageName}@${entry.version}`;
    range = alias[2] ?? '*';
  }
  // Only a plain semver range can be checked against a version. A tag, a URL,
  // a path and a git ref name something else, which the lock pins in its own way.
  if (/[:/]/u.test(range)) return undefined;
  try {
    return npmSatisfies(entry.version, range)
      ? undefined
      : `package.json asks for ${spec}, the lock has ${entry.version}`;
  } catch {
    return undefined;
  }
}

/** The members a workspace lock holds, as refusals. */
function workspaceRefusals(
  tree: PackageLockTree,
  manifest: FrozenManifest,
): FrozenLockRefusal[] {
  const refused: FrozenLockRefusal[] = [];
  for (const link of tree.links)
    refused.push({
      path: link.path,
      reason: `a link to ${link.target || '(no target)'}; workspace members and links are not installed yet`,
    });
  const members = tree.foreign.filter(
    (entry) => !entry.path.includes('/node_modules/'),
  );
  for (const member of members)
    refused.push({
      path: member.path,
      reason: `a workspace member${member.name === undefined ? '' : ` (${member.name})`}; workspaces are not installed yet`,
    });
  const inside = tree.foreign.length - members.length;
  if (inside > 0)
    refused.push({
      path: '(inside the members)',
      reason: `${inside} package${inside === 1 ? '' : 's'} installed inside workspace members`,
    });
  if (
    refused.length === 0 &&
    (manifest.workspaces !== undefined || tree.root?.workspaces !== undefined)
  )
    refused.push({
      path: 'package.json',
      reason: 'declares workspaces, which are not installed yet',
    });
  return refused;
}

async function readBounded(path: string, maximum: number): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    // SAFETY: Node file errors carry a string `code`.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT')
      throw new ProviderError('NOT_FOUND', `${path} does not exist`);
    if (code === 'ELOOP')
      throw new ProviderError(
        'UNSAFE_PATH',
        `${path} is a symbolic link; a frozen install reads the file itself`,
      );
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `${path} is not a regular file`,
      );
    if (info.size > maximum)
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `${path} is ${info.size} bytes, more than the ${maximum} this reads`,
      );
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function readManifest(text: string, path: string): FrozenManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ProviderError(
      'INVALID_MANIFEST',
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
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
          `${path}: ${name}.${key} must be a string`,
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
  const workspaces = workspaceRefusals(tree, manifest);
  if (workspaces.length > 0)
    return { ...common, packages: [], skipped: [], refused: workspaces };
  const disagreements = lockDisagreements(tree, manifest);
  if (disagreements.length > 0)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      `package.json and package-lock.json are not in sync (npm ci would refuse too): ${disagreements.slice(0, 20).join('; ')}${disagreements.length > 20 ? `; and ${disagreements.length - 20} more` : ''}`,
    );
  return { ...common, ...planFrozenPackageLock({ tree, options }) };
}

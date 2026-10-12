/**
 * Shared set-up for the workspace suites (`lock-workspace*.test.ts`,
 * `frozen-workspace*.test.ts`): the records a workspace lock is made of, and
 * the members a host's discovery would find for it.
 */

import {
  assembleMembers,
  resolveWorkspaceLimits,
  type NativeTarget,
  type WorkspaceMember,
} from '@openpacker/adapter-core';
import { readPackageLock } from './lock-tree.js';

export const LINUX_X64: NativeTarget = {
  os: 'linux',
  architecture: 'x64',
  libc: 'glibc',
};

/** A registry package's lock record. */
export const registry = (
  name: string,
  version: string,
  extra: Record<string, unknown> = {},
) => ({
  version,
  resolved: `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,
  integrity: `sha512-${name.replace(/\W/gu, '')}${version.replace(/\W/gu, '')}`,
  ...extra,
});

/** The lock's entry for a link to a member's directory. */
export const link = (dir: string) => ({ resolved: dir, link: true });

/** A member's lock record. */
export const member = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  version: '1.0.0',
  ...extra,
});

/**
 * A lock for a project whose root declares `workspaces` and holds `packages`,
 * with the usual link for each member named in `linked` (member directory to
 * the name it is linked under, which is the member's own by default).
 */
export function workspaceLock(input: {
  root?: Record<string, unknown>;
  workspaces?: readonly string[];
  members: Record<string, Record<string, unknown>>;
  linked?: Record<string, string | null>;
  packages?: Record<string, unknown>;
}): Record<string, unknown> {
  const packages: Record<string, unknown> = {
    '': {
      name: 'app',
      version: '1.0.0',
      workspaces: input.workspaces ?? ['packages/*'],
      ...input.root,
    },
  };
  for (const [dir, record] of Object.entries(input.members)) {
    packages[dir] = record;
    const name =
      input.linked?.[dir] === undefined
        ? (record.name as string)
        : input.linked[dir];
    if (name !== null) packages[`node_modules/${name}`] = link(dir);
  }
  Object.assign(packages, input.packages);
  return { name: 'app', version: '1.0.0', lockfileVersion: 3, packages };
}

export const treeOf = (lock: Record<string, unknown>) => readPackageLock(lock);

/** The members a host's discovery would find, from `(dir, manifest)` pairs. */
export function diskMembers(
  members: Record<string, Record<string, unknown>>,
): readonly WorkspaceMember[] {
  const list = (value: unknown): ReadonlyMap<string, string> =>
    new Map(Object.entries((value as Record<string, string>) ?? {}));
  return assembleMembers(
    Object.entries(members).map(([dir, record]) => ({
      dir,
      manifest: {
        name: record.name as string | undefined,
        version: record.version as string | undefined,
        private: false,
        dependencies: list(record.dependencies),
        devDependencies: list(record.devDependencies),
        optionalDependencies: list(record.optionalDependencies),
        peerDependencies: list(record.peerDependencies),
        optionalPeers: new Set(),
        workspaces: undefined,
        bin: {},
      },
    })),
    'npm',
    resolveWorkspaceLimits(),
  );
}

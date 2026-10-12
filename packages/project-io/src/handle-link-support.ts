/**
 * Shared set-up for the workspace-member link suites (`handle-link*.test.ts`):
 * a project with a member directory, an open `node_modules` and an open scope
 * directory, and the cleanup that closes and removes them.
 */

import { constants } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LinkSite } from './handle-link.js';
import { O_DIRECTORY } from './handle-path.js';

export const DIRECTORY =
  constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW;
export const MEMBER = '../packages/pkg';

const temps: string[] = [];
export const handles: FileHandle[] = [];
export async function cleanup(): Promise<void> {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

/** Have `cleanup` remove a path the test made outside its project. */
export function remember(path: string): void {
  temps.push(path);
}

export async function project() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'member-link-'));
  temps.push(root);
  await mkdir(join(root, 'node_modules', '@scope'), { recursive: true });
  await mkdir(join(root, 'packages', 'pkg'), { recursive: true });
  await writeFile(join(root, 'packages', 'pkg', 'index.js'), 'member');
  const modules = await open(join(root, 'node_modules'), DIRECTORY);
  const scope = await open(join(root, 'node_modules', '@scope'), DIRECTORY);
  handles.push(modules, scope);
  const site: LinkSite = { directory: 'node_modules', projectRoot: root };
  const scopeSite: LinkSite = {
    directory: 'node_modules/@scope',
    projectRoot: root,
  };
  return {
    root,
    modules,
    scope,
    site,
    scopeSite,
    link: (name: string) => join(root, 'node_modules', name),
    member: join(root, 'packages', 'pkg'),
  };
}

/** The error an operation fails with, or undefined. */
export async function failure<T>(
  work: () => Promise<T>,
): Promise<(Error & { code?: string; path?: string }) | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    // SAFETY: the operations under test throw Error values with an optional code.
    return error as Error & { code?: string; path?: string };
  }
}

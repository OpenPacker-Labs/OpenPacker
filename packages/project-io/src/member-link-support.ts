/**
 * Shared set-up for the member-link suites (`member-link*.test.ts`): a project
 * with a workspace member, a registry package in `node_modules`, and the record
 * a layout would have written for whatever links the test makes.
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordedLinks } from './layout-links.js';

export const MEMBER = '../packages/pkg';

const temps: string[] = [];

/** Remove every project the test made; run from `afterEach`. */
export async function cleanup(): Promise<void> {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

/** Have `cleanup` remove a path the test made outside its project. */
export function remember(path: string): void {
  temps.push(path);
}

/** A project with a member, a registry package, and nothing linked yet. */
export async function project() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'member-walk-')));
  temps.push(root);
  const member = join(root, 'packages', 'pkg');
  await mkdir(member, { recursive: true });
  await writeFile(join(member, 'index.js'), 'member');
  await writeFile(join(member, 'sentinel'), 'keep');
  const modules = join(root, 'node_modules');
  await mkdir(join(modules, 'registry'), { recursive: true });
  await writeFile(join(modules, 'registry', 'package.json'), '{}');
  const record = (links: Record<string, string>): RecordedLinks => ({
    projectRoot: root,
    base: 'node_modules',
    links: new Map(Object.entries(links)),
  });
  return { root, member, modules, record };
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

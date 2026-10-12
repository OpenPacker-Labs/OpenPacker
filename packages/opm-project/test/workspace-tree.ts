import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WorkspaceError } from '@openpacker/adapter-core';
import type { JsonValue } from '@openpacker/contracts';
import { discoverWorkspace, type DiscoverOptions } from '../src/index.js';

/** `string` is written verbatim; an object is written as JSON; `null` makes an empty directory. */
export type Entry = string | JsonValue | null;
export type Files = Record<string, Entry>;

export async function materialize(root: string, files: Files): Promise<void> {
  for (const [path, entry] of Object.entries(files)) {
    const place = join(root, path);
    if (entry === null) {
      await mkdir(place, { recursive: true });
      continue;
    }
    await mkdir(dirname(place), { recursive: true });
    await writeFile(
      place,
      typeof entry === 'string' ? entry : JSON.stringify(entry),
    );
  }
}

const made: string[] = [];

export async function scratch(files: Files = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-ws-'));
  made.push(root);
  await materialize(root, files);
  return root;
}

export async function cleanup(): Promise<void> {
  for (const root of made.splice(0))
    await rm(root, { recursive: true, force: true });
}

export async function link(
  root: string,
  from: string,
  to: string,
): Promise<void> {
  await mkdir(dirname(join(root, from)), { recursive: true });
  await symlink(to, join(root, from));
}

/** The member directories found in a scratch tree, or `undefined` for no workspace. */
export async function dirsOf(files: Files, options?: DiscoverOptions) {
  const root = await scratch(files);
  const found = await discoverWorkspace(root, options);
  return found?.members.map((member) => member.dir);
}

/** The workspace error discovery throws over a scratch tree; fails if it throws none. */
export async function refusal(files: Files, options?: DiscoverOptions) {
  const root = await scratch(files);
  try {
    await discoverWorkspace(root, options);
  } catch (error) {
    if (error instanceof WorkspaceError) return error;
    throw error;
  }
  throw new Error('discovery did not refuse');
}

/** A tree whose package.json declares npm workspaces. */
export const npm = (workspaces: string[], extra: Files = {}): Files => ({
  'package.json': { name: 'root', workspaces },
  ...extra,
});

/** A tree whose pnpm-workspace.yaml lists `packages` (the YAML list lines). */
export const pnpm = (packages: string, extra: Files = {}): Files => ({
  'package.json': { name: 'root' },
  'pnpm-workspace.yaml': `packages:\n${packages}`,
  ...extra,
});

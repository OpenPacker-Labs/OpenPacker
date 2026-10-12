import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  WorkspaceError,
  compareText,
  type WorkspaceLimits,
  type WorkspacePatterns,
  type WorkspaceTool,
} from '@openpacker/adapter-core';
import {
  O_DIRECTORY,
  openChild,
  readDirChildWithTypes,
} from '@openpacker/project-io';
import { entryExists, errnoOf, readBoundedText } from './read.js';

/** A directory a pattern selected, with the text of its `package.json`. */
export interface FoundManifest {
  readonly dir: string;
  readonly text: string;
}

export interface WalkResult {
  readonly found: readonly FoundManifest[];
  /** Links met while searching a `**`, not followed. */
  readonly skippedLinks: readonly string[];
  readonly directoriesRead: number;
  readonly entriesRead: number;
}

const MAXIMUM_SKIPPED = 1000;

function linkRefusal(dir: string): WorkspaceError {
  return new WorkspaceError(
    'WORKSPACE_SYMLINK',
    `${dir} is a symbolic link on the path of a workspace pattern; workspaces never follow links. Make it a real directory, or change the pattern so it does not name it`,
    [dir],
  );
}

/**
 * Find the member directories under `root`.
 *
 * The walk is depth-first in code-unit order, goes only where a pattern could
 * still select something, and is bounded by `limits`: entries read, depth and
 * members. Every directory is opened relative to its parent's handle without
 * following a link, so a directory swapped for a link between listing and
 * opening is refused, and nothing outside `root` can be reached. A link is
 * never followed: one a pattern names itself is refused, one met while a `**`
 * searches is passed over and reported.
 */
export async function walkMembers(
  root: FileHandle,
  patterns: WorkspacePatterns,
  tool: WorkspaceTool,
  limits: WorkspaceLimits,
): Promise<WalkResult> {
  const found: FoundManifest[] = [];
  const skippedLinks: string[] = [];
  let directoriesRead = 0;
  let entriesRead = 0;
  let manifestBytes = 0;

  const readManifest = async (
    handle: FileHandle,
    dir: string,
  ): Promise<string | undefined> => {
    const text = await readBoundedText(
      handle,
      'package.json',
      limits.maxManifestBytes,
      `${dir}/package.json`,
    );
    if (text !== undefined || tool !== 'pnpm') return text;
    // pnpm also reads package.yaml and package.json5; this model reads neither,
    // and a member it cannot read must not be dropped without a word.
    for (const other of ['package.yaml', 'package.json5'])
      if (await entryExists(handle, other))
        throw new WorkspaceError(
          'WORKSPACE_MANIFEST_INVALID',
          `${dir} has a ${other} and no package.json; only package.json is supported`,
          [dir],
        );
    return undefined;
  };

  const visit = async (handle: FileHandle, segments: string[]) => {
    directoriesRead += 1;
    const entries = await readDirChildWithTypes(handle);
    entriesRead += entries.length;
    if (entriesRead > limits.maxDirectoryEntries)
      throw new WorkspaceError(
        'WORKSPACE_LIMIT_EXCEEDED',
        `The workspace walk has read more than ${limits.maxDirectoryEntries} directory entries; narrow the patterns or raise the limit`,
      );
    entries.sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      const link = entry.isSymbolicLink();
      if (!entry.isDirectory() && !link) continue;
      if (entry.name === 'node_modules') continue;
      const below = [...segments, entry.name];
      const selected = patterns.isMember(below);
      const descend = patterns.mayHoldMembers(below);
      if (!selected && !descend) continue;
      const dir = below.join('/');
      if (link) {
        if (patterns.isExplicit(below) || patterns.isExplicitPrefix(below))
          throw linkRefusal(dir);
        if (skippedLinks.length < MAXIMUM_SKIPPED) skippedLinks.push(dir);
        continue;
      }
      if (below.length > limits.maxDepth)
        throw new WorkspaceError(
          'WORKSPACE_LIMIT_EXCEEDED',
          `${dir} is ${below.length} directories below the workspace root, more than the limit of ${limits.maxDepth}`,
          [dir],
        );
      let child: FileHandle;
      try {
        child = await openChild(
          handle,
          entry.name,
          constants.O_RDONLY | O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        const code = error instanceof Error ? errnoOf(error) : undefined;
        if (code === 'ELOOP') throw linkRefusal(dir);
        if (code === 'ENOTDIR')
          throw new WorkspaceError(
            'WORKSPACE_SYMLINK',
            `${dir} stopped being a directory while the workspace was read`,
            [dir],
          );
        if (code === 'ENOENT') continue;
        throw error;
      }
      try {
        if (selected) {
          const text = await readManifest(child, dir);
          if (text !== undefined) {
            manifestBytes += Buffer.byteLength(text);
            if (found.length >= limits.maxMembers)
              throw new WorkspaceError(
                'WORKSPACE_LIMIT_EXCEEDED',
                `The workspace has more than ${limits.maxMembers} members, the limit; narrow the patterns or raise the limit`,
              );
            if (manifestBytes > limits.maxTotalManifestBytes)
              throw new WorkspaceError(
                'WORKSPACE_LIMIT_EXCEEDED',
                `The members' package.json files add up to more than ${limits.maxTotalManifestBytes} bytes, the limit`,
              );
            found.push({ dir, text });
          }
        }
        if (descend) await visit(child, below);
      } finally {
        await child.close();
      }
    }
  };

  if (patterns.mayHoldMembers([])) await visit(root, []);
  return { found, skippedLinks, directoriesRead, entriesRead };
}

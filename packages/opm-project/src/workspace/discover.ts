import type { FileHandle } from 'node:fs/promises';
import {
  WorkspaceError,
  assembleMembers,
  compileWorkspacePatterns,
  isStrictVersion,
  parseStrictJson,
  readWorkspaceManifest,
  resolveWorkspaceLimits,
  workspacePatternsOf,
  type MemberSource,
  type WorkspaceLimits,
  type WorkspaceMember,
  type WorkspaceTool,
} from '@openpacker/adapter-core';
import { openStableDirectory } from '../paths.js';
import { parsePnpmWorkspaceYaml } from './declaration.js';
import { readBoundedText } from './read.js';
import { walkMembers } from './walk.js';

export interface DiscoverOptions {
  /**
   * Whose rules read the declaration. By default pnpm's when the root has a
   * `pnpm-workspace.yaml` (pnpm ignores `workspaces` in `package.json`), npm's
   * otherwise.
   */
  readonly tool?: WorkspaceTool;
  readonly limits?: Partial<WorkspaceLimits>;
}

export interface WorkspaceDiscovery {
  readonly tool: WorkspaceTool;
  /** The file the member patterns were read from. */
  readonly declaredIn: 'pnpm-workspace.yaml' | 'package.json';
  /** The patterns as declared (`['.']` for a pnpm file with no `packages`). */
  readonly patterns: readonly string[];
  /**
   * `linkWorkspacePackages` as `pnpm-workspace.yaml` sets it. `.npmrc` is not
   * read, so `undefined` is "not set here", not "off".
   */
  readonly linkWorkspacePackages: boolean | 'deep' | undefined;
  /** The root first (when it has a `package.json`), then by directory. */
  readonly members: readonly WorkspaceMember[];
  /** Links met while a `**` searched, not followed. */
  readonly skippedLinks: readonly string[];
  /** Things a caller may want to tell the person, never a failure. */
  readonly notes: readonly string[];
  readonly stats: {
    readonly directoriesRead: number;
    readonly entriesRead: number;
  };
}

function readManifestAt(
  text: string,
  display: string,
  limits: WorkspaceLimits,
) {
  const manifest = readWorkspaceManifest(
    parseStrictJson(text, display),
    display,
    limits,
  );
  if (manifest.version !== undefined && !isStrictVersion(manifest.version))
    throw new WorkspaceError(
      'WORKSPACE_MANIFEST_INVALID',
      `${display}: version ${JSON.stringify(manifest.version)} is not a semantic version`,
      [display],
    );
  return manifest;
}

async function declare(
  root: FileHandle,
  options: DiscoverOptions,
  limits: WorkspaceLimits,
) {
  const yaml =
    options.tool === 'npm'
      ? undefined
      : await readBoundedText(
          root,
          'pnpm-workspace.yaml',
          limits.maxDeclarationBytes,
          'pnpm-workspace.yaml',
        );
  const rootText = await readBoundedText(
    root,
    'package.json',
    limits.maxManifestBytes,
    'package.json',
  );
  const rootManifest =
    rootText === undefined
      ? undefined
      : readManifestAt(rootText, 'package.json', limits);
  const tool = options.tool ?? (yaml !== undefined ? 'pnpm' : 'npm');
  const notes: string[] = [];
  if (tool === 'pnpm') {
    if (yaml === undefined) return undefined;
    const declaration = parsePnpmWorkspaceYaml(yaml, limits);
    if (rootManifest?.workspaces !== undefined)
      notes.push(
        'package.json also declares workspaces; pnpm ignores that field and reads pnpm-workspace.yaml',
      );
    return {
      tool,
      declaredIn: 'pnpm-workspace.yaml' as const,
      patterns: declaration.patterns,
      linkWorkspacePackages: declaration.linkWorkspacePackages,
      rootManifest,
      notes,
    };
  }
  if (rootManifest?.workspaces === undefined) return undefined;
  if (yaml === undefined && options.tool === 'npm')
    notes.push('pnpm-workspace.yaml, if present, is not read under npm rules');
  return {
    tool,
    declaredIn: 'package.json' as const,
    patterns: workspacePatternsOf(rootManifest.workspaces, 'package.json'),
    linkWorkspacePackages: undefined,
    rootManifest,
    notes,
  };
}

/**
 * Find the members of the workspace rooted at `rootPath`, or `undefined` when
 * the directory declares none under the rules asked for. Nothing is searched
 * upward: the caller names the root.
 *
 * Reads only through directory handles and never follows a link. It is bounded
 * (members, entries, depth, file sizes), refuses names that are not package
 * names or that two members share, and returns members in one order whatever
 * the file system listed.
 */
export async function discoverWorkspace(
  rootPath: string,
  options: DiscoverOptions = {},
): Promise<WorkspaceDiscovery | undefined> {
  const limits = resolveWorkspaceLimits(options.limits);
  const root = await openStableDirectory(rootPath);
  try {
    const declared = await declare(root, options, limits);
    if (declared === undefined) return undefined;
    const patterns = compileWorkspacePatterns(
      declared.patterns,
      declared.tool,
      limits,
    );
    const walked = await walkMembers(root, patterns, declared.tool, limits);
    const sources: MemberSource[] = walked.found.map((entry) => ({
      dir: entry.dir,
      manifest: readManifestAt(entry.text, `${entry.dir}/package.json`, limits),
    }));
    if (declared.rootManifest !== undefined)
      sources.push({ dir: '', manifest: declared.rootManifest });
    return {
      tool: declared.tool,
      declaredIn: declared.declaredIn,
      patterns: declared.patterns,
      linkWorkspacePackages: declared.linkWorkspacePackages,
      members: assembleMembers(sources, declared.tool, limits),
      skippedLinks: walked.skippedLinks,
      notes: declared.notes,
      stats: {
        directoriesRead: walked.directoriesRead,
        entriesRead: walked.entriesRead,
      },
    };
  } finally {
    await root.close();
  }
}

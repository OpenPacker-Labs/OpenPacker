import type { JsonValue } from '@openpacker/contracts';
import {
  DEFAULT_WORKSPACE_LIMITS,
  WorkspaceError,
  assembleMembers,
  readWorkspaceManifest,
  type MemberSource,
  type WorkspaceMember,
  type WorkspaceTool,
} from '../src/index.js';

/** A workspace written as `{ directory: manifest }`, the root as `''`. */
export type Tree = Record<string, JsonValue>;

export function sourcesOf(tree: Tree): MemberSource[] {
  return Object.entries(tree).map(([dir, value]) => ({
    dir,
    manifest: readWorkspaceManifest(
      value,
      dir || '(root)',
      DEFAULT_WORKSPACE_LIMITS,
    ),
  }));
}

export function membersOf(
  tree: Tree,
  tool: WorkspaceTool = 'pnpm',
): readonly WorkspaceMember[] {
  return assembleMembers(sourcesOf(tree), tool, DEFAULT_WORKSPACE_LIMITS);
}

/** The code of the workspace error `run` throws, or "no error". */
export function codeOf(run: () => void): string {
  try {
    run();
    return 'no error';
  } catch (error) {
    if (error instanceof WorkspaceError) return error.code;
    throw error;
  }
}

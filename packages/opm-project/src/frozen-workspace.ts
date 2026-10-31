/**
 * The workspace part of a frozen install: finding the members on disk, and
 * reading `--workspace`, `--include-workspace-root` and `--workspaces` the way
 * `npm ci` does.
 *
 * The ecosystem's adapter reads its own lock and says which members it lists;
 * this is the host's half. It discovers the workspace the project's own files
 * declare (bounded, without following a link), so the adapter can hold the
 * lock's member list against it, and it turns what the person asked for into the
 * part of the workspace to install.
 */

import {
  WorkspaceError,
  parseFilter,
  resolveWorkspaceLimits,
  selectMembers,
  selectNpmWorkspaces,
  type FrozenWorkspaceInput,
  type ProjectFormat,
  type WorkspaceTool,
} from '@openpacker/adapter-core';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { OpmError } from './types.js';
import {
  discoverWorkspace,
  graphOfWorkspace,
  type WorkspaceDiscovery,
} from './workspace/index.js';

/** What a person can ask of a workspace install. */
export interface FrozenWorkspaceRequest {
  /**
   * `--workspace <name|dir>`, repeatable: only these members and what they
   * need. A directory selects the members one level below it.
   */
  select?: readonly string[];
  /**
   * `--filter <selector>`, repeatable: pnpm's grammar (a name, a glob, `./dir`,
   * `name...`, `!name`), choosing members as `opm run --filter` does; what the
   * install then reaches is `--workspace`'s (the members they link and what
   * those need). The root only with `includeRoot`.
   */
  filter?: readonly string[];
  /**
   * `--include-workspace-root`: with a selection, the project's own
   * dependencies too. Alone it changes nothing, as in npm.
   */
  includeRoot?: boolean;
  /** `--workspaces`: every member, and not the project's own dependencies. */
  all?: boolean;
  /** `--workspaces=false`: the project's own dependencies, and no member. */
  ignore?: boolean;
}

/** A workspace refusal in opm's vocabulary, so the command line maps it to an exit status. */
export function workspaceFailure(error: WorkspaceError): OpmError {
  const codes: Record<string, string> = {
    WORKSPACE_SYMLINK: 'UNSAFE_PATH',
    WORKSPACE_PATH_UNSAFE: 'UNSAFE_PATH',
    WORKSPACE_LIMIT_EXCEEDED: 'SIZE_LIMIT',
    WORKSPACE_FILTER_NO_MATCH: 'INVALID_SPEC',
    WORKSPACE_FILTER_INVALID: 'INVALID_SPEC',
    WORKSPACE_FILTER_UNSUPPORTED: 'INVALID_SPEC',
  };
  return new OpmError(codes[error.code] ?? 'INVALID_MANIFEST', error.message, {
    cause: error,
  });
}

/**
 * The members a workspace names by a plain path (no glob) that have no
 * `package.json` here: what a member that links one cannot find, and what a
 * git submodule that is not checked out leaves.
 */
async function absentLiteralMembers(
  root: string,
  patterns: readonly string[],
): Promise<string[]> {
  const absent: string[] = [];
  for (const pattern of patterns) {
    if (/[*?[\]{}!]/u.test(pattern)) continue;
    const dir = pattern.replace(/^\.\//u, '').replace(/\/+$/u, '');
    if (dir === '' || dir === '.' || dir.split('/').includes('..')) continue;
    const manifest = await lstat(join(root, dir, 'package.json')).catch(
      () => undefined,
    );
    if (manifest === undefined) absent.push(dir);
  }
  return absent;
}

function asksForWorkspace(request: FrozenWorkspaceRequest): boolean {
  return (
    (request.select?.length ?? 0) > 0 ||
    (request.filter?.length ?? 0) > 0 ||
    request.includeRoot === true ||
    request.all === true ||
    request.ignore === true
  );
}

/**
 * Say which part of the project's workspace to install, for a format that has
 * workspaces; undefined for one without, which refuses a request for one.
 *
 * The workspace on disk is discovered once, and when it is first needed: at once
 * for a selection (the members must be known to name them), and otherwise only
 * when the adapter asks, which it does for a project that has a workspace to
 * hold the lock to. Discovery reads every member's `package.json` strictly, so a
 * project that declares no workspaces is never subjected to it.
 */
export async function prepareFrozenWorkspace(
  root: string,
  format: ProjectFormat,
  request: FrozenWorkspaceRequest = {},
  /** Whose rules read the members, when the project's lock decides it (a pnpm lock's are pnpm's). */
  workspaceTool: WorkspaceTool | undefined = format.workspaceTool,
): Promise<FrozenWorkspaceInput | undefined> {
  if (workspaceTool === undefined) {
    if (asksForWorkspace(request))
      throw new OpmError(
        'INVALID_SPEC',
        `${format.purlType} projects have no workspaces; --filter, --workspace, --include-workspace-root and --workspaces do not apply`,
      );
    return undefined;
  }
  const filtering = (request.filter?.length ?? 0) > 0;
  const selecting = (request.select?.length ?? 0) > 0 || filtering;
  if (request.ignore === true && (selecting || request.all === true))
    throw new OpmError(
      'INVALID_SPEC',
      '--workspaces=false installs no member, so it cannot be combined with --filter, --workspace or --workspaces',
    );
  if (filtering && ((request.select?.length ?? 0) > 0 || request.all === true))
    throw new OpmError(
      'INVALID_SPEC',
      "--filter chooses members by pnpm's grammar and --workspace by npm's; pass one of them",
    );
  const tool = workspaceTool;
  let discovery: Promise<WorkspaceDiscovery | undefined> | undefined;
  const discover = (): Promise<WorkspaceDiscovery | undefined> =>
    (discovery ??= discoverWorkspace(root, { tool }).catch((error: Error) => {
      throw error instanceof WorkspaceError ? workspaceFailure(error) : error;
    }));
  const disk = async () => (await discover())?.members ?? [];
  if (request.ignore === true) return { disk, scope: { kind: 'root' } };
  if (!selecting && request.all !== true)
    return { disk, scope: { kind: 'all' } };
  const found = await discover();
  if (found === undefined)
    throw new OpmError(
      'INVALID_SPEC',
      `No workspaces found: ${root} declares none (${tool === 'pnpm' ? 'no pnpm-workspace.yaml' : 'no package.json "workspaces" field'}), so there is no member to select`,
    );
  let dirs: readonly string[];
  try {
    const graph = graphOfWorkspace(found);
    dirs = filtering
      ? selectMembers(
          graph,
          (request.filter ?? []).map((selector) =>
            parseFilter(selector, {
              cwd: '',
              limits: resolveWorkspaceLimits(),
            }),
          ),
          { excludeRoot: request.includeRoot !== true },
        ).selected
      : selectNpmWorkspaces(graph, request.select ?? [], { cwd: '' });
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    const failure = workspaceFailure(error);
    const absent =
      error.code === 'WORKSPACE_SPEC_UNRESOLVED'
        ? await absentLiteralMembers(root, found.patterns)
        : [];
    if (absent.length === 0) throw failure;
    throw new OpmError(
      failure.code,
      `${failure.message}; ${found.declaredIn} lists ${absent.join(', ')}, which ${absent.length === 1 ? 'is' : 'are'} not on disk (a git submodule that is not checked out?)`,
      { cause: error },
    );
  }
  return {
    disk,
    scope: {
      kind: 'members',
      dirs,
      includeRoot: request.includeRoot === true,
    },
  };
}

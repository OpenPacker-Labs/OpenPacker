import {
  buildWorkspaceGraph,
  npmRangeEngine,
  type LinkPolicy,
  type WorkspaceGraph,
} from '@openpacker/adapter-core';
import type { WorkspaceDiscovery } from './discover.js';

/**
 * The link policy the discovered tool applies by default: npm links a plain
 * range a member satisfies, always; pnpm does only with
 * `link-workspace-packages` (off since v9), which this reads from
 * `pnpm-workspace.yaml` and not from `.npmrc`. A caller who knows better
 * passes the policy to `graphOfWorkspace` instead.
 */
export function linkPolicyOf(discovery: WorkspaceDiscovery): LinkPolicy {
  if (discovery.tool === 'npm') return 'satisfied-range';
  return discovery.linkWorkspacePackages === undefined ||
    discovery.linkWorkspacePackages === false
    ? 'workspace-protocol'
    : 'satisfied-range';
}

export function graphOfWorkspace(
  discovery: WorkspaceDiscovery,
  linkPolicy: LinkPolicy = linkPolicyOf(discovery),
): WorkspaceGraph {
  return buildWorkspaceGraph(discovery.members, {
    linkPolicy,
    ranges: npmRangeEngine,
  });
}

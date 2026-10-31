/**
 * Which importers a frozen install of a pnpm lock installs (ADR 0055 §16).
 *
 * `npm ci -w` installs the named members, what they need and the members they
 * use (ADR 0051 §9); this is the same rule on importers. The project is an
 * importer too (`.`): it is installed when it is selected or when
 * `--include-workspace-root` is given, and `--workspaces=false` installs it
 * alone, with no link to a member.
 */

import {
  ProviderError,
  type FrozenWorkspaceScope,
} from '@openpacker/adapter-core';
import type { PnpmModel } from './model.js';
import { quote } from './quote.js';

const idOfDir = (dir: string): string => (dir === '' ? '.' : dir);

/**
 * The ids of the importers to install, or every importer the project still has
 * (`present`, every importer when absent) when there is no scope. A link to an
 * importer the project no longer has is not followed; `importerRefusals` names
 * it.
 */
export function selectTops(
  model: PnpmModel,
  scope: FrozenWorkspaceScope = { kind: 'all' },
  present: ReadonlySet<string> = new Set(model.tops.keys()),
): ReadonlySet<string> {
  if (scope.kind === 'all')
    return new Set([...model.tops.keys()].filter((id) => present.has(id)));
  if (scope.kind === 'root') return new Set(model.tops.has('.') ? ['.'] : []);
  const seeds = [
    ...scope.dirs.map(idOfDir),
    ...(scope.includeRoot ? ['.'] : []),
  ];
  const unknown = seeds.filter((id) => !model.tops.has(id));
  if (unknown.length > 0)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      `The workspace selection names ${unknown.map(quote).join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not an importer of the lock`,
    );
  const chosen = new Set<string>();
  const pending = [...seeds];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (chosen.has(id)) continue;
    chosen.add(id);
    // The project's own links are workspace edges, which a selection by member
    // or by root never follows (ADR 0051 §9).
    if (id === '.') continue;
    for (const edge of model.tops.get(id)?.edges ?? [])
      if (
        edge.kind === 'link' &&
        edge.memberId !== undefined &&
        present.has(edge.memberId)
      )
        pending.push(edge.memberId);
  }
  return chosen;
}

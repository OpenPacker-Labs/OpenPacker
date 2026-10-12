/** What a projected `node_modules` says it is not: the semantic loss of the layout. */

import type { SemanticLoss } from '@openpacker/contracts';
import type { LayoutOutcome } from './layout-write.js';

export function layoutLoss(
  outcome: LayoutOutcome,
  layoutOnly: boolean,
): SemanticLoss {
  const nested =
    outcome.nested > 0
      ? `, ${outcome.nested} nested to keep conflicting versions apart`
      : '';
  return {
    code: 'NATIVE_LAYOUT_NOT_TOOL_EQUIVALENT',
    severity: 'info',
    sourceEcosystem: 'npm',
    sourcePath: outcome.root,
    originalMeaning:
      'node_modules was materialised from the digest-verified opm store',
    representedMeaning: `${outcome.packages} package(s) in a node_modules Node can resolve${nested}, ${
      outcome.copied ? 'copied' : 'hardlinked'
    } from the store, with ${outcome.bins} executable(s) as script shims in .bin${
      outcome.memberLinks.declared > 0
        ? `; ${outcome.memberLinks.declared} workspace member(s) linked to their own directories${
            outcome.memberModules > 0
              ? `, ${outcome.memberModules} with a node_modules of their own`
              : ''
          }`
        : ''
    }${layoutOnly ? '; there is no package.json here and none was created' : ''}`,
    omittedMeaning:
      'npm was not run: no lifecycle scripts, no symlinked bin links (a workspace member is the one symlink, or on Windows junction, there is), and a placement that is correct for the selected versions but not necessarily the one npm would choose',
    mitigation:
      'Run npm install if a package needs its install scripts, or keep native_projection at "lock".',
    blocksProfile: [],
  };
}

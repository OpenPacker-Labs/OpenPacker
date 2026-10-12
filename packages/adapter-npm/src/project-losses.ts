import type {
  NativeLockEntry,
  NativeRequirement,
} from '@openpacker/adapter-core';
import type { SemanticLoss } from '@openpacker/contracts';
import type { LayoutOutcome } from './layout-write.js';

/** What the npm project format says it did not do, as losses. */

export function scopeLoss(requirement: NativeRequirement): SemanticLoss {
  return {
    code: 'NATIVE_SCOPE_UNSUPPORTED',
    severity: 'warning',
    sourceEcosystem: 'npm',
    sourcePath: `/packages/${requirement.name}/scope`,
    originalMeaning: `${requirement.name} is declared with scope "${requirement.scope}"`,
    representedMeaning: 'The requirement was not written to package.json',
    omittedMeaning: `npm has no dependency field for the "${requirement.scope}" scope`,
    mitigation:
      'Declare the package with a scope npm expresses: runtime, development, optional, or peer.',
    blocksProfile: ['native-validated-v1'],
  };
}

export function integrityLoss(entry: NativeLockEntry): SemanticLoss {
  return {
    code: 'NATIVE_LOCK_INTEGRITY_UNAVAILABLE',
    severity: 'warning',
    sourceEcosystem: 'npm',
    sourcePath: `/packages/${entry.name}`,
    originalMeaning: `${entry.name}@${entry.version} was resolved and pinned by digest`,
    representedMeaning: 'No package-lock.json was written',
    omittedMeaning:
      'npm pins with Subresource Integrity over the tarball, which was not captured for this package',
    mitigation:
      'Re-resolve so the integrity value is captured, or keep native_projection at "manifest".',
    blocksProfile: ['native-validated-v1'],
  };
}

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
      layoutOnly ? '; there is no package.json here and none was created' : ''
    }`,
    omittedMeaning:
      'npm was not run: no lifecycle scripts, no symlinked bin links, and a placement that is correct for the selected versions but not necessarily the one npm would choose',
    mitigation:
      'Run npm install if a package needs its install scripts, or keep native_projection at "lock".',
    blocksProfile: [],
  };
}

export function packLoss(): SemanticLoss {
  return {
    code: 'NATIVE_PACK_NOT_TOOL_EQUIVALENT',
    severity: 'info',
    sourceEcosystem: 'npm',
    sourcePath: '/pack',
    originalMeaning: 'A publishable npm tarball was built from the project',
    representedMeaning:
      'A deterministic gzipped tar with the package/ prefix, honouring files, .npmignore and npm always-include rules',
    omittedMeaning:
      'npm pack was not run: prepack and prepare scripts did not execute, and npm ignore precedence is approximated rather than reimplemented',
    mitigation:
      'Run npm pack when a package depends on its prepack scripts to produce publishable output.',
    blocksProfile: [],
  };
}

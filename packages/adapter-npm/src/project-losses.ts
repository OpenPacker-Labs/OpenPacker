/**
 * What the npm project format says it did not do, as losses. The layout's own
 * is `layout-loss.ts`.
 */

import type {
  NativeLockEntry,
  NativeRequirement,
} from '@openpacker/adapter-core';
import type { SemanticLoss } from '@openpacker/contracts';

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

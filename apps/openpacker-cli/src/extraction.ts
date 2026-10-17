import {
  DEFAULT_MATERIALIZATION_LIMITS,
  type MaterializationLimits,
} from '@openpacker/materializer';
import type { ArtifactDescriptor } from '@openpacker/contracts';

/** The artifact types the npm adapter gives its package archives. */
const NPM_PACKAGE_ARTIFACT = /^application\/vnd\.openpacker\.npm\.package\./u;

/**
 * What `openpacker materialize --install-prefix` extracts an artifact under.
 * An npm package is read the way npm and pnpm read it, and refused where they
 * would install different files (ADR 0057 §8); any other artifact keeps the
 * materializer's general rule. The type is the adapter's own, not a guess from
 * the bytes.
 */
export function extractionLimits(
  descriptor: Pick<ArtifactDescriptor, 'artifactType'>,
): MaterializationLimits {
  return NPM_PACKAGE_ARTIFACT.test(descriptor.artifactType)
    ? { ...DEFAULT_MATERIALIZATION_LIMITS, requireNpmReaderAgreement: true }
    : DEFAULT_MATERIALIZATION_LIMITS;
}

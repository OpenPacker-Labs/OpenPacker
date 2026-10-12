import type { Digest } from '@openpacker/contracts';
import {
  compareCanonicalStrings,
  parseUntrustedUrl,
} from '@openpacker/canonical';

export interface SlsaProvenanceV1 {
  _type: 'https://in-toto.io/Statement/v1';
  subject: Array<{ name: string; digest: Record<string, string> }>;
  predicateType: 'https://slsa.dev/provenance/v1';
  predicate: {
    buildDefinition: {
      buildType: string;
      externalParameters: unknown;
      internalParameters: unknown;
      resolvedDependencies: Array<{
        uri: string;
        digest?: Record<string, string>;
      }>;
    };
    runDetails: { builder: { id: string } };
  };
}

export interface SlsaEvidence {
  builderId: string;
  buildType: string;
  materials: Array<{ uri: string; sha256?: string }>;
}

export function verifySlsaProvenance(
  statement: SlsaProvenanceV1,
  subject: Digest,
): SlsaEvidence {
  if (
    statement._type !== 'https://in-toto.io/Statement/v1' ||
    statement.predicateType !== 'https://slsa.dev/provenance/v1'
  )
    throw new Error('Unsupported SLSA provenance predicate');
  if (!statement.subject.some((item) => item.digest.sha256 === subject.value))
    throw new Error('SLSA subject mismatch');
  const builderId = statement.predicate.runDetails.builder.id;
  const buildType = statement.predicate.buildDefinition.buildType;
  if (!builderId || !buildType)
    throw new Error('SLSA builder ID and build type are required');
  const materials = statement.predicate.buildDefinition.resolvedDependencies
    .map((material) => ({
      uri: parseUntrustedUrl(material.uri).toString(),
      ...(material.digest?.sha256 && { sha256: material.digest.sha256 }),
    }))
    .sort((left, right) => compareCanonicalStrings(left.uri, right.uri));
  return { builderId, buildType, materials };
}

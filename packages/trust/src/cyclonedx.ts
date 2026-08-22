import { compareCanonicalStrings } from '@openpacker/canonical';

export type LicenseEvidence =
  | { status: 'declared' | 'concluded'; expression: string }
  | { status: 'unknown' | 'missing' };

export interface CycloneDxEvidence {
  purls: string[];
  hashes: Array<{ algorithm: string; value: string }>;
  dependencies: Array<{ ref: string; dependsOn: string[] }>;
  licenses: LicenseEvidence[];
  externalReferences: Array<{ type: string; url: string }>;
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (value as JsonObject)
    : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function extractCycloneDxEvidence(document: unknown): CycloneDxEvidence {
  const root = object(document);
  if (
    !root ||
    root.bomFormat !== 'CycloneDX' ||
    typeof root.specVersion !== 'string' ||
    !['1.5', '1.6'].includes(root.specVersion)
  )
    throw new Error('Unsupported CycloneDX JSON document');
  const components = list(root.components)
    .map(object)
    .filter((value): value is JsonObject => value !== undefined);
  const purls = components
    .flatMap((component) =>
      typeof component.purl === 'string' ? [component.purl] : [],
    )
    .sort();
  const hashes = components
    .flatMap((component) =>
      list(component.hashes).flatMap((item) => {
        const hash = object(item);
        return hash &&
          typeof hash.alg === 'string' &&
          typeof hash.content === 'string'
          ? [{ algorithm: hash.alg, value: hash.content }]
          : [];
      }),
    )
    .sort((left, right) =>
      compareCanonicalStrings(
        `${left.algorithm}:${left.value}`,
        `${right.algorithm}:${right.value}`,
      ),
    );
  const licenses = components.flatMap((component) => {
    const declared = object(component.evidence)?.licenses;
    const source = Array.isArray(declared) ? declared : component.licenses;
    if (!Array.isArray(source)) return [{ status: 'missing' as const }];
    if (source.length === 0) return [{ status: 'unknown' as const }];
    return source.map((item): LicenseEvidence => {
      const entry = object(item);
      const expression =
        typeof entry?.expression === 'string'
          ? entry.expression
          : typeof object(entry?.license)?.id === 'string'
            ? // SAFETY: The surrounding boundary establishes the asserted domain contract.
              (object(entry?.license)?.id as string)
            : undefined;
      return expression
        ? { status: declared ? 'concluded' : 'declared', expression }
        : { status: 'unknown' };
    });
  });
  const dependencies = list(root.dependencies)
    .flatMap((item) => {
      const dependency = object(item);
      return dependency && typeof dependency.ref === 'string'
        ? [
            {
              ref: dependency.ref,
              dependsOn: list(dependency.dependsOn)
                .filter((value): value is string => typeof value === 'string')
                .sort(),
            },
          ]
        : [];
    })
    .sort((left, right) => compareCanonicalStrings(left.ref, right.ref));
  const externalReferences = components
    .flatMap((component) =>
      list(component.externalReferences).flatMap((item) => {
        const ref = object(item);
        return ref &&
          typeof ref.type === 'string' &&
          typeof ref.url === 'string'
          ? [{ type: ref.type, url: new URL(ref.url).toString() }]
          : [];
      }),
    )
    .sort((left, right) =>
      compareCanonicalStrings(
        `${left.type}:${left.url}`,
        `${right.type}:${right.url}`,
      ),
    );
  return { purls, hashes, dependencies, licenses, externalReferences };
}

/**
 * Presence of a CycloneDX document is not integrity. A BOM with no PURLs
 * and no hashes cannot be bound to a lock or artifact set.
 */
export function cycloneDxEvidenceStatus(
  document: unknown,
): 'valid' | 'invalid' {
  try {
    const evidence = extractCycloneDxEvidence(document);
    if (evidence.purls.length === 0 && evidence.hashes.length === 0)
      return 'invalid';
    return 'valid';
  } catch {
    return 'invalid';
  }
}

import {
  canonicalBytes,
  canonicalDigest,
  compareCanonicalStrings,
  sha256,
} from '@openpacker/canonical';
import type {
  ArtifactDescriptor,
  Digest,
  JsonValue,
  PackageInstance,
  ResolutionSolution,
  SourceRef,
} from '@openpacker/contracts';

export interface OcmLabel {
  name: string;
  value: JsonValue;
  signing?: boolean;
}

export interface OcmDigest {
  hashAlgorithm: 'SHA-256';
  normalisationAlgorithm: 'genericBlobDigest/v1' | 'jsonNormalisation/v1';
  value: string;
}

export interface OcmResource {
  name: string;
  version: string;
  type: string;
  relation: 'local' | 'external';
  access:
    | {
        type: 'localBlob';
        localReference: string;
        mediaType: string;
        size: number;
      }
    | { type: 'ociArtifact'; imageReference: string };
  digest: OcmDigest;
  labels: OcmLabel[];
}

export interface OcmComponentReference {
  name: string;
  componentName: string;
  version: string;
  digest: OcmDigest;
  labels: OcmLabel[];
}

export interface OcmComponentDescriptor {
  meta: { schemaVersion: 'v2' };
  component: {
    name: string;
    version: string;
    provider: { name: string; labels?: OcmLabel[] };
    repositoryContexts: Array<{ type: string; baseUrl: string }>;
    sources: Array<{
      name: string;
      version: string;
      type: string;
      access: { type: 'external'; ref: string };
      labels: OcmLabel[];
    }>;
    componentReferences: OcmComponentReference[];
    resources: OcmResource[];
    labels: OcmLabel[];
  };
}

export interface OcmIdentity {
  name: string;
  version: string;
}

const OCM_NAME = /^[a-z0-9][a-z0-9.-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const requireText = (value: string, field: string): void => {
  if (!value || value.length > 1024)
    throw new OcmValidationError('INVALID_FIELD', `Invalid ${field}`);
};

function validateLabels(labels: readonly OcmLabel[], owner: string): void {
  const names = new Set<string>();
  for (const label of labels) {
    requireText(label.name, `${owner} label name`);
    if (names.has(label.name))
      throw new OcmValidationError(
        'DUPLICATE_LABEL',
        `Duplicate label ${label.name} on ${owner}`,
      );
    names.add(label.name);
    if (label.signing !== undefined && typeof label.signing !== 'boolean')
      throw new OcmValidationError(
        'INVALID_LABEL',
        `Invalid signing flag on ${owner}`,
      );
  }
}

export async function componentNameForPurl(exactPurl: string): Promise<string> {
  if (!exactPurl.startsWith('pkg:'))
    throw new TypeError('Exact PURL is required for OCM mapping');
  const digest = await sha256(new TextEncoder().encode(exactPurl));
  return `openpacker.dev/purl/sha256-${digest.value}`;
}

export function ocmIdentity(descriptor: OcmComponentDescriptor): OcmIdentity {
  return {
    name: descriptor.component.name,
    version: descriptor.component.version,
  };
}

export async function createOcmDescriptor(input: {
  name: string;
  version: string;
  provider: string;
  exactPurl: string;
  resources: readonly {
    name: string;
    artifact: ArtifactDescriptor;
    ociBlobDigest?: string;
  }[];
  componentReferences?: readonly OcmComponentReference[];
  sources?: readonly SourceRef[];
  solutionDigest?: Digest;
  receiptDigest?: Digest;
}): Promise<OcmComponentDescriptor> {
  const labels: OcmLabel[] = [
    {
      name: 'org.openpacker.prex.exactPurl',
      value: input.exactPurl,
      signing: true,
    },
  ];
  if (input.solutionDigest)
    labels.push({
      name: 'org.openpacker.prex.solutionDigest',
      value: `sha256:${input.solutionDigest.value}`,
      signing: true,
    });
  if (input.receiptDigest)
    labels.push({
      name: 'org.openpacker.prex.receiptDigest',
      value: `sha256:${input.receiptDigest.value}`,
      signing: true,
    });
  const descriptor: OcmComponentDescriptor = {
    meta: { schemaVersion: 'v2' },
    component: {
      name: input.name,
      version: input.version,
      provider: { name: input.provider },
      repositoryContexts: [],
      sources: (input.sources ?? []).map((source, index) => ({
        name: `source-${index + 1}`,
        version: input.version,
        type: source.type,
        access: { type: 'external', ref: source.uri },
        labels: source.digest
          ? [
              {
                name: 'org.openpacker.prex.sourceDigest',
                value: `sha256:${source.digest.value}`,
                signing: true,
              },
            ]
          : [],
      })),
      componentReferences: [...(input.componentReferences ?? [])].sort(
        (left, right) =>
          compareCanonicalStrings(left.componentName, right.componentName) ||
          compareCanonicalStrings(left.version, right.version),
      ),
      resources: input.resources
        .map(({ name, artifact, ociBlobDigest }) => ({
          name,
          version: input.version,
          type: artifact.artifactType,
          relation: 'local' as const,
          access: {
            type: 'localBlob' as const,
            localReference: ociBlobDigest ?? `sha256:${artifact.digest.value}`,
            mediaType: artifact.mediaType,
            size: artifact.size,
          },
          digest: {
            hashAlgorithm: 'SHA-256' as const,
            normalisationAlgorithm: 'genericBlobDigest/v1' as const,
            value: artifact.digest.value,
          },
          labels: [
            {
              name: 'org.openpacker.prex.descriptorId',
              value: artifact.descriptorId,
              signing: true,
            },
          ],
        }))
        .sort((left, right) => compareCanonicalStrings(left.name, right.name)),
      labels,
    },
  };
  validateOcmDescriptor(descriptor);
  return descriptor;
}

export async function mapSolutionToOcm(input: {
  packages: readonly PackageInstance[];
  solution: ResolutionSolution;
  provider: string;
  receiptDigest?: Digest;
}): Promise<OcmComponentDescriptor[]> {
  const selected = new Map(
    input.packages
      .filter(({ nodeId }) => input.solution.selectedNodeIds.includes(nodeId))
      .map((item) => [item.nodeId, item]),
  );
  const ordered = [...selected.values()].sort((left, right) =>
    compareCanonicalStrings(
      left.identity.exactPurl ?? '',
      right.identity.exactPurl ?? '',
    ),
  );
  const descriptors = new Map<string, OcmComponentDescriptor>();
  for (const node of ordered) {
    const exactPurl = node.identity.exactPurl;
    if (!exactPurl) continue;
    descriptors.set(
      node.nodeId,
      await createOcmDescriptor({
        name: await componentNameForPurl(exactPurl),
        version: node.normalizedVersion,
        provider: input.provider,
        exactPurl,
        resources: node.artifacts.map((artifact, index) => ({
          name: artifact.fileName ?? `artifact-${index + 1}`,
          artifact,
        })),
        componentReferences: [],
        sources: node.identity.sourceRefs,
        solutionDigest: input.solution.solutionDigest,
        ...(input.receiptDigest === undefined
          ? {}
          : { receiptDigest: input.receiptDigest }),
      }),
    );
  }
  const output: OcmComponentDescriptor[] = [];
  for (const node of ordered) {
    const descriptor = descriptors.get(node.nodeId);
    if (!descriptor) continue;
    const referenceRequirements = new Map<string, string[]>();
    for (const edge of input.solution.dependencyEdges.filter(
      ({ fromNodeId }) => fromNodeId === node.nodeId,
    )) {
      const dependency = selected.get(edge.toNodeId);
      if (!dependency?.identity.exactPurl) continue;
      const requirements = referenceRequirements.get(dependency.nodeId) ?? [];
      requirements.push(edge.requirementId);
      referenceRequirements.set(dependency.nodeId, requirements);
    }
    const references: OcmComponentReference[] = [];
    for (const [dependencyNodeId, requirementIds] of [
      ...referenceRequirements,
    ].sort(([left], [right]) => compareCanonicalStrings(left, right))) {
      const dependency = selected.get(dependencyNodeId)!;
      const dependencyDescriptor = descriptors.get(dependencyNodeId);
      if (!dependencyDescriptor) continue;
      const sortedIds = [...requirementIds].sort();
      references.push({
        name: sortedIds[0]!,
        componentName: await componentNameForPurl(
          dependency.identity.exactPurl!,
        ),
        version: dependency.normalizedVersion,
        digest: await ocmComponentReferenceDigest(dependencyDescriptor),
        labels: [
          {
            name: 'org.openpacker.prex.requirementIds',
            value: sortedIds,
            signing: true,
          },
        ],
      });
    }
    descriptor.component.componentReferences = references;
    validateOcmDescriptor(descriptor);
    output.push(descriptor);
  }
  return output;
}

export async function ocmComponentReferenceDigest(
  descriptor: OcmComponentDescriptor,
): Promise<OcmDigest> {
  validateOcmDescriptor(descriptor);
  const digest = await canonicalDigest({
    name: descriptor.component.name,
    version: descriptor.component.version,
    provider: descriptor.component.provider,
    sources: descriptor.component.sources.map(
      ({ name, version, type, labels }) => ({
        name,
        version,
        type,
        labels,
      }),
    ),
    resources: descriptor.component.resources.map(
      ({ name, version, type, relation, digest, labels }) => ({
        name,
        version,
        type,
        relation,
        digest,
        labels,
      }),
    ),
    labels: descriptor.component.labels,
  } as unknown as JsonValue);
  return {
    hashAlgorithm: 'SHA-256',
    normalisationAlgorithm: 'jsonNormalisation/v1',
    value: digest.value,
  };
}

export function validateOcmDescriptor(
  descriptor: OcmComponentDescriptor,
): void {
  if (descriptor.meta.schemaVersion !== 'v2')
    throw new OcmValidationError(
      'UNSUPPORTED_SCHEMA',
      'Only OCM descriptor schema v2 is supported',
    );
  if (!OCM_NAME.test(descriptor.component.name))
    throw new OcmValidationError('INVALID_NAME', 'Invalid OCM component name');
  if (
    !descriptor.component.version ||
    descriptor.component.version.length > 1024
  )
    throw new OcmValidationError(
      'INVALID_VERSION',
      'Invalid OCM component version',
    );
  requireText(descriptor.component.provider.name, 'provider name');
  validateLabels(
    descriptor.component.provider.labels ?? [],
    'component provider',
  );
  validateLabels(descriptor.component.labels, 'component');
  for (const context of descriptor.component.repositoryContexts) {
    requireText(context.type, 'repository context type');
    requireText(context.baseUrl, 'repository context baseUrl');
  }
  const sourceNames = new Set<string>();
  for (const source of descriptor.component.sources) {
    requireText(source.name, 'source name');
    if (sourceNames.has(source.name))
      throw new OcmValidationError(
        'DUPLICATE_SOURCE',
        `Duplicate source ${source.name}`,
      );
    sourceNames.add(source.name);
    requireText(source.version, `source ${source.name} version`);
    requireText(source.type, `source ${source.name} type`);
    if (source.access.type !== 'external')
      throw new OcmValidationError(
        'INVALID_ACCESS',
        `Invalid source access for ${source.name}`,
      );
    requireText(source.access.ref, `source ${source.name} reference`);
    validateLabels(source.labels, `source ${source.name}`);
  }
  const resourceNames = new Set<string>();
  for (const resource of descriptor.component.resources) {
    requireText(resource.name, 'resource name');
    if (resourceNames.has(resource.name))
      throw new OcmValidationError(
        'DUPLICATE_RESOURCE',
        `Duplicate resource ${resource.name}`,
      );
    resourceNames.add(resource.name);
    requireText(resource.version, `resource ${resource.name} version`);
    requireText(resource.type, `resource ${resource.name} type`);
    if (resource.relation !== 'local' && resource.relation !== 'external')
      throw new OcmValidationError(
        'INVALID_RELATION',
        `Invalid relation for ${resource.name}`,
      );
    if (
      resource.digest.hashAlgorithm !== 'SHA-256' ||
      resource.digest.normalisationAlgorithm !== 'genericBlobDigest/v1' ||
      !DIGEST.test(resource.digest.value)
    )
      throw new OcmValidationError(
        'INVALID_DIGEST',
        `Invalid resource digest for ${resource.name}`,
      );
    if (resource.access.type === 'localBlob') {
      if (
        !Number.isSafeInteger(resource.access.size) ||
        resource.access.size < 0
      )
        throw new OcmValidationError(
          'INVALID_SIZE',
          `Invalid resource size for ${resource.name}`,
        );
      if (resource.access.localReference !== `sha256:${resource.digest.value}`)
        throw new OcmValidationError(
          'DIGEST_MISMATCH',
          `Resource access digest differs for ${resource.name}`,
        );
    } else requireText(resource.access.imageReference, 'OCI image reference');
    validateLabels(resource.labels, `resource ${resource.name}`);
  }
  const references = new Set<string>();
  const referenceNames = new Set<string>();
  for (const reference of descriptor.component.componentReferences) {
    requireText(reference.name, 'component reference name');
    if (referenceNames.has(reference.name))
      throw new OcmValidationError(
        'DUPLICATE_REFERENCE_NAME',
        `Duplicate component reference name ${reference.name}`,
      );
    referenceNames.add(reference.name);
    requireText(reference.version, `reference ${reference.name} version`);
    const key = `${reference.componentName}\u0000${reference.version}`;
    if (references.has(key))
      throw new OcmValidationError(
        'DUPLICATE_REFERENCE',
        `Duplicate component reference ${reference.componentName}@${reference.version}`,
      );
    references.add(key);
    if (!OCM_NAME.test(reference.componentName))
      throw new OcmValidationError(
        'INVALID_REFERENCE',
        `Invalid component reference ${reference.componentName}`,
      );
    if (
      !reference.digest ||
      reference.digest.hashAlgorithm !== 'SHA-256' ||
      reference.digest.normalisationAlgorithm !== 'jsonNormalisation/v1' ||
      !DIGEST.test(reference.digest.value)
    )
      throw new OcmValidationError(
        'INVALID_REFERENCE_DIGEST',
        `Invalid component reference digest for ${reference.componentName}`,
      );
    validateLabels(reference.labels, `reference ${reference.name}`);
  }
}

export function ocmDescriptorBytes(
  descriptor: OcmComponentDescriptor,
): Uint8Array {
  validateOcmDescriptor(descriptor);
  return canonicalBytes(descriptor as unknown as JsonValue);
}

export async function ocmDescriptorDigest(
  descriptor: OcmComponentDescriptor,
): Promise<Digest> {
  validateOcmDescriptor(descriptor);
  return canonicalDigest(descriptor as unknown as JsonValue);
}

export class OcmValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OcmValidationError';
  }
}

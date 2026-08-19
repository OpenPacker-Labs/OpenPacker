import { describe, expect, it } from 'vitest';
import type {
  ArtifactDescriptor,
  PackageInstance,
} from '@openpacker/contracts';
import {
  componentNameForPurl,
  createOcmDescriptor,
  mapSolutionToOcm,
  ocmComponentReferenceDigest,
  ocmDescriptorDigest,
  ocmIdentity,
  validateOcmDescriptor,
} from './index.js';

const artifact: ArtifactDescriptor = {
  descriptorId: 'native',
  digest: { algorithm: 'sha256', value: 'a'.repeat(64) },
  size: 42,
  mediaType: 'application/vnd.npm.package+gzip',
  artifactType: 'application/vnd.openpacker.package',
  nativeRole: 'native-package',
  locations: [],
  referrers: [],
  externalRefs: [],
};

describe('OCM mapping', () => {
  it('creates a location-independent component descriptor', async () => {
    const descriptor = await createOcmDescriptor({
      name: await componentNameForPurl('pkg:npm/demo@1.0.0'),
      version: '1.0.0',
      provider: 'openpacker.dev',
      exactPurl: 'pkg:npm/demo@1.0.0',
      resources: [{ name: 'demo.tgz', artifact }],
      solutionDigest: { algorithm: 'sha256', value: 'b'.repeat(64) },
    });
    expect(ocmIdentity(descriptor)).toEqual({
      name: descriptor.component.name,
      version: '1.0.0',
    });
    expect(descriptor.component.resources[0]?.access).toMatchObject({
      type: 'localBlob',
      localReference: `sha256:${artifact.digest.value}`,
    });
    expect((await ocmDescriptorDigest(descriptor)).value).toMatch(
      /^[0-9a-f]{64}$/u,
    );
  });

  it('rejects resource digest/access substitution', async () => {
    const descriptor = await createOcmDescriptor({
      name: await componentNameForPurl('pkg:npm/demo@1.0.0'),
      version: '1.0.0',
      provider: 'openpacker.dev',
      exactPurl: 'pkg:npm/demo@1.0.0',
      resources: [{ name: 'demo.tgz', artifact }],
    });
    const resource = descriptor.component.resources[0];
    if (resource?.access.type === 'localBlob')
      resource.access.localReference = `sha256:${'c'.repeat(64)}`;
    expect(() => validateOcmDescriptor(descriptor)).toThrowError(
      expect.objectContaining({ code: 'DIGEST_MISMATCH' }),
    );
  });

  it('coalesces multiple semantic edges to one OCM component reference', async () => {
    const packageFor = (
      nodeId: string,
      exactPurl: string,
    ): PackageInstance => ({
      nodeId,
      identity: {
        canonicalPurl: exactPurl.slice(0, exactPurl.lastIndexOf('@')),
        exactPurl,
        purlType: 'npm',
        name: exactPurl,
        version: '1.0.0',
        qualifiers: {},
        nativeCoordinates: [],
        aliases: [],
        sourceRefs: [],
        publisherRefs: [],
        externalRefs: [],
      },
      nativeVersion: '1.0.0',
      normalizedVersion: '1.0.0',
      versionSortKey: '1.0.0',
      requirements: [],
      capabilities: [],
      conflicts: [],
      cardinalityConstraints: [],
      artifacts: [artifact],
      lifecycle: { status: 'published', eligible: true, warnings: [] },
      sourceSnapshots: [],
      metadataDigest: { algorithm: 'sha256', value: 'd'.repeat(64) },
      nativeSemantics: { version: '1', data: {} },
      semanticLoss: [],
    });
    const packages = [
      packageFor('app', 'pkg:npm/app@1.0.0'),
      packageFor('dep', 'pkg:npm/dep@1.0.0'),
      packageFor('leaf', 'pkg:npm/leaf@1.0.0'),
    ];
    const descriptors = await mapSolutionToOcm({
      packages,
      solution: {
        selectedNodeIds: ['app', 'dep', 'leaf'],
        selectedCapabilityProviders: [],
        dependencyEdges: [
          {
            fromNodeId: 'app',
            toNodeId: 'dep',
            requirementId: 'package-edge',
            witnessType: 'package',
          },
          {
            fromNodeId: 'app',
            toNodeId: 'dep',
            requirementId: 'capability-edge',
            witnessType: 'capability',
          },
          {
            fromNodeId: 'dep',
            toNodeId: 'leaf',
            requirementId: 'transitive-edge',
            witnessType: 'package',
          },
        ],
        satisfiedRequirementIds: [
          'capability-edge',
          'package-edge',
          'transitive-edge',
        ],
        excludedCandidates: [],
        objectiveTuple: [],
        sourceSnapshotDigests: [],
        semanticLoss: [],
        solutionDigest: { algorithm: 'sha256', value: 'e'.repeat(64) },
      },
      provider: 'openpacker.dev',
    });
    expect(
      descriptors.find(({ component }) => component.componentReferences.length)
        ?.component.componentReferences,
    ).toHaveLength(1);
    const descriptorFor = (purl: string) =>
      descriptors.find(({ component }) =>
        component.labels.some(
          ({ name, value }) =>
            name === 'org.openpacker.prex.exactPurl' && value === purl,
        ),
      );
    const app = descriptorFor('pkg:npm/app@1.0.0');
    const dependency = descriptorFor('pkg:npm/dep@1.0.0');
    const leaf = descriptorFor('pkg:npm/leaf@1.0.0');
    expect(app?.component.componentReferences[0]?.digest).toEqual(
      await ocmComponentReferenceDigest(dependency!),
    );
    expect(dependency?.component.componentReferences[0]?.digest).toEqual(
      await ocmComponentReferenceDigest(leaf!),
    );
    const before = await ocmComponentReferenceDigest(dependency!);
    const changedTransitive = structuredClone(dependency!);
    changedTransitive.component.componentReferences[0]!.digest.value =
      'c'.repeat(64);
    expect(await ocmComponentReferenceDigest(changedTransitive)).not.toEqual(
      before,
    );
    dependency!.component.repositoryContexts.push({
      type: 'ociRegistry',
      baseUrl: 'registry.example/first',
    });
    const resource = dependency!.component.resources[0];
    if (resource)
      resource.access = {
        type: 'ociArtifact',
        imageReference:
          'mirror.example/openpacker/demo@sha256:' + 'f'.repeat(64),
      };
    expect(await ocmComponentReferenceDigest(dependency!)).toEqual(before);

    await expect(
      mapSolutionToOcm({
        packages,
        solution: {
          selectedNodeIds: ['app', 'dep'],
          selectedCapabilityProviders: [],
          dependencyEdges: [
            {
              fromNodeId: 'app',
              toNodeId: 'dep',
              requirementId: 'app-dep',
              witnessType: 'package',
            },
            {
              fromNodeId: 'dep',
              toNodeId: 'app',
              requirementId: 'dep-app',
              witnessType: 'package',
            },
          ],
          satisfiedRequirementIds: ['app-dep', 'dep-app'],
          excludedCandidates: [],
          objectiveTuple: [],
          sourceSnapshotDigests: [],
          semanticLoss: [],
          solutionDigest: { algorithm: 'sha256', value: 'e'.repeat(64) },
        },
        provider: 'openpacker.dev',
      }),
    ).rejects.toMatchObject({ code: 'CYCLIC_COMPONENT_REFERENCE' });
  });

  it('rejects malformed provider, resource, and digest fields', async () => {
    const descriptor = await createOcmDescriptor({
      name: 'openpacker.dev/demo',
      version: '1.0.0',
      provider: 'org.openpacker',
      exactPurl: 'pkg:npm/demo@1.0.0',
      resources: [{ name: 'demo', artifact }],
    });
    const invalid = structuredClone(descriptor) as unknown as {
      component: {
        provider: { name: string };
        resources: Array<{
          name: string;
          digest: { hashAlgorithm: string };
        }>;
      };
    };
    invalid.component.provider.name = '';
    invalid.component.resources[0]!.name = '';
    invalid.component.resources[0]!.digest.hashAlgorithm = 'MD5';
    expect(() => validateOcmDescriptor(invalid as never)).toThrowError(
      expect.objectContaining({ code: 'INVALID_FIELD' }),
    );
  });
});

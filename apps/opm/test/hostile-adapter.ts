import {
  packageNodeId,
  type CatalogProvider,
  type InstallerProvider,
  type PackageInstance,
  type ProjectFormat,
} from '@openpacker/adapter-core';
import type { AdapterModule } from '@openpacker/opm-project';

/**
 * An ecosystem, `acme`, that a test speaks for. `runOpm` takes an adapter beside
 * the bundled ones (`RunOpmOptions.adapters`), the way a bound plugin is handed
 * to the registry, so the registry, the installer or the project format under
 * test is driven through the real command. What a plugin-served adapter says is
 * its program's, which is what a project binds; the tests word one value of it
 * at a time with hostile text.
 */
export const ENDPOINT = 'https://acme.registry.test';
export const DIGEST = 'a'.repeat(64);

/** A package instance with the fields the commands and the resolver read. */
export async function instance(
  exactPurl: string,
  version: string,
  canonicalPurl = exactPurl.split('@')[0]!,
): Promise<PackageInstance> {
  // SAFETY: only the fields the commands read are filled.
  return {
    nodeId: await packageNodeId({
      exactPurl,
      nativeSemanticsVersion: 'acme-1',
    }),
    identity: {
      canonicalPurl,
      purlType: 'acme',
      name: 'demo',
      version: exactPurl.slice(exactPurl.indexOf('@') + 1),
      qualifiers: {},
      nativeCoordinates: [],
      aliases: [],
      sourceRefs: [],
      publisherRefs: [],
      externalRefs: [],
      exactPurl,
    },
    nativeVersion: version,
    normalizedVersion: version,
    versionSortKey: version,
    requirements: [],
    capabilities: [],
    conflicts: [],
    cardinalityConstraints: [],
    artifacts: [],
    lifecycle: { status: 'published', eligible: true, warnings: [] },
    sourceSnapshots: [],
    metadataDigest: { algorithm: 'sha256', value: DIGEST },
    nativeSemantics: { version: 'acme-1', data: {} },
    semanticLoss: [],
  } as PackageInstance;
}

/** What the adapter has to offer: the Registry Definition follows from it. */
export interface Parts {
  catalog?: CatalogProvider;
  installer?: InstallerProvider;
  project?: ProjectFormat;
}

const CATALOG = [
  'prex.registry.package-metadata/1',
  'prex.registry.enumerate-versions/1',
  'prex.registry.search/1',
  'prex.registry.artifact/1',
] as const;

/** The `acme` adapter, advertising exactly the resources it implements. */
export function moduleOf(parts: Parts): AdapterModule {
  const resources = [
    ...(parts.catalog === undefined ? [] : CATALOG),
    ...(parts.installer === undefined ? [] : ['prex.registry.install/1']),
    ...(parts.project === undefined
      ? []
      : ['prex.registry.project-manifest/1']),
  ].map((type, index) => ({ '@id': `#r${index}`, '@type': type }));
  const { catalog, installer, project } = parts;
  return {
    id: 'dev.test.hostile',
    purlTypes: ['acme'],
    registryDefinition: () => ({
      registryDefinitionVersion: '1',
      registryId: ENDPOINT,
      purlTypes: ['acme'],
      resources,
      // A host install is chosen by what the definition says it does.
      ...(installer !== undefined && {
        features: { installSideEffects: 'system' as const },
      }),
    }),
    ...(catalog !== undefined && { catalog: () => catalog }),
    ...(installer !== undefined && { installer: () => installer }),
    ...(project !== undefined && { project: () => project }),
  };
}

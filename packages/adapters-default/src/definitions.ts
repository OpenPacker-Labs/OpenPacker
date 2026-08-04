import type { RegistryDefinition } from '@openpacker/adapter-host';

/** Build a Registry Definition for an HTTP package registry. */
export function httpRegistryDefinition(input: {
  registryId: string;
  displayName: string;
  purlTypes: readonly string[];
  native: string;
  baseUrl: string;
  searchUrl?: string;
  includeArtifact?: boolean;
  includeDeps?: boolean;
  includeInstall?: boolean;
  features?: RegistryDefinition['features'];
}): RegistryDefinition {
  type Resource = RegistryDefinition['resources'][number];
  const resources: Resource[] = [
    {
      '@id': input.baseUrl,
      '@type': [
        'prex.registry.package-metadata/1',
        'prex.registry.enumerate-versions/1',
      ],
    },
  ];
  if (input.searchUrl)
    resources.push({
      '@id': input.searchUrl,
      '@type': 'prex.registry.search/1',
    });
  if (input.includeArtifact !== false)
    resources.push({
      '@id': input.baseUrl,
      '@type': 'prex.registry.artifact/1',
    });
  if (input.includeDeps)
    resources.push({
      '@id': input.baseUrl,
      '@type': 'prex.registry.dependency-graph/1',
    });
  if (input.includeInstall)
    resources.push({
      '@id': input.baseUrl,
      '@type': 'prex.registry.install/1',
    });
  return {
    registryDefinitionVersion: '1',
    registryId: input.registryId,
    displayName: input.displayName,
    purlTypes: [...input.purlTypes],
    protocol: { native: input.native, transport: ['https'] },
    resources,
    features: input.features ?? {
      offlineReplay: false,
      installSideEffects: 'project-store',
      reversibility: 'project-generation',
      requiresElevation: 'never',
    },
  };
}

export function hostInstallerDefinition(input: {
  registryId: string;
  displayName: string;
  purlTypes: readonly string[];
  native: string;
  execId: string;
  features: NonNullable<RegistryDefinition['features']>;
}): RegistryDefinition {
  return {
    registryDefinitionVersion: '1',
    registryId: input.registryId,
    displayName: input.displayName,
    purlTypes: [...input.purlTypes],
    protocol: { native: input.native, transport: ['exec'] },
    resources: [
      {
        '@id': input.execId,
        '@type': [
          'prex.registry.search/1',
          'prex.registry.package-metadata/1',
          'prex.registry.install/1',
          'prex.registry.uninstall/1',
        ],
      },
    ],
    features: input.features,
  };
}

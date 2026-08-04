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

/**
 * Registry Definition for a host CLI installer that only exports InstallerProvider.
 *
 * Advertise only operations the module can honor. InstallerProvider is plan +
 * install (+ available); it is not catalog search/metadata and does not export
 * uninstall through the PREX install interface unless wired separately.
 * Features may still describe native reversibility honesty.
 */
export function hostInstallerDefinition(input: {
  registryId: string;
  displayName: string;
  purlTypes: readonly string[];
  native: string;
  execId: string;
  features: NonNullable<RegistryDefinition['features']>;
  /** Extra resource types this installer module actually implements. */
  extraResources?: readonly string[];
}): RegistryDefinition {
  const types = [
    'prex.registry.install/1',
    ...(input.extraResources ?? []),
  ] as const;
  return {
    registryDefinitionVersion: '1',
    registryId: input.registryId,
    displayName: input.displayName,
    purlTypes: [...input.purlTypes],
    protocol: { native: input.native, transport: ['exec'] },
    resources: [
      {
        '@id': input.execId,
        '@type': types.length === 1 ? types[0]! : [...types],
      },
    ],
    features: input.features,
  };
}

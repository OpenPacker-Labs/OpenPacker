import {
  BoundedFetchTransport,
  type HttpTransport,
} from '@openpacker/adapter-core';
import { AptSystemProvider } from '@openpacker/adapter-apt';
import {
  CargoCodec,
  CargoProjectFormat,
  CargoSparseProvider,
} from '@openpacker/adapter-cargo';
import { ChocolateyProvider } from '@openpacker/adapter-chocolatey';
import {
  GolangCodec,
  GolangProjectFormat,
  GolangProxyProvider,
} from '@openpacker/adapter-golang';
import type { AdapterContext, AdapterModule } from '@openpacker/adapter-host';
import {
  MavenCodec,
  MavenProjectFormat,
  MavenRepositoryProvider,
} from '@openpacker/adapter-maven';
import { NixCodec, NixStoreProvider } from '@openpacker/adapter-nix';
import {
  NpmCodec,
  NpmPackagePacker,
  NpmProjectFormat,
  NpmRegistryProvider,
} from '@openpacker/adapter-npm';
import {
  NugetCodec,
  NugetProjectFormat,
  NugetV3Provider,
} from '@openpacker/adapter-nuget';
import {
  PypiCodec,
  PypiJsonProvider,
  PypiProjectFormat,
} from '@openpacker/adapter-pypi';
import { WingetSystemProvider } from '@openpacker/adapter-winget';
import { OciRegistryProvider } from '@openpacker/oci';
import {
  hostInstallerDefinition,
  httpRegistryDefinition,
} from './definitions.js';
import {
  cargoPacker,
  chocolateyPacker,
  debPacker,
  mavenPacker,
  nixPacker,
  nugetPacker,
  ociPacker,
  pypiPacker,
  wingetPacker,
} from './packers.js';

const DEFAULT_ENDPOINTS: Readonly<Record<string, string>> = {
  npm: 'https://registry.npmjs.org',
  cargo: 'https://index.crates.io',
  pypi: 'https://pypi.org/pypi',
  nuget: 'https://api.nuget.org/v3/index.json',
  maven: 'https://repo1.maven.org/maven2',
  golang: 'https://proxy.golang.org',
  oci: 'https://registry-1.docker.io',
};

const ARTIFACT_ORIGINS: Readonly<Record<string, readonly string[]>> = {
  npm: ['https://registry.npmjs.org'],
  cargo: ['https://static.crates.io', 'https://crates.io'],
  pypi: ['https://files.pythonhosted.org', 'https://pypi.org'],
  nuget: ['https://api.nuget.org', 'https://globalcdn.nuget.org'],
  maven: ['https://repo1.maven.org', 'https://repo.maven.apache.org'],
  golang: ['https://proxy.golang.org'],
  oci: ['https://registry-1.docker.io', 'https://ghcr.io'],
};

function endpointFor(ecosystem: string, context: AdapterContext): string {
  const env =
    process.env[`OPM_REGISTRY_${ecosystem.toUpperCase()}`]?.trim() ??
    context.endpoint;
  return env || DEFAULT_ENDPOINTS[ecosystem] || '';
}

function transportFor(
  ecosystem: string,
  context: AdapterContext,
): HttpTransport {
  if (context.transport) return context.transport as HttpTransport;
  const endpoint = endpointFor(ecosystem, context);
  const origins = [
    ...new Set([
      new URL(endpoint).origin,
      ...(ARTIFACT_ORIGINS[ecosystem] ?? []).map((uri) => new URL(uri).origin),
    ]),
  ];
  return new BoundedFetchTransport({ allowedOrigins: origins });
}

function clock(context: AdapterContext) {
  return { now: context.now ?? (() => new Date().toISOString()) };
}

/** Default adapter modules for the reference distribution. */
export function defaultAdapterModules(): AdapterModule[] {
  return [
    {
      id: 'org.openpacker.adapter.npm',
      purlTypes: ['npm'],
      registryDefinition: (context = {}) =>
        httpRegistryDefinition({
          registryId: 'urn:openpacker:registry:npmjs-org',
          displayName: 'npmjs.org',
          purlTypes: ['npm'],
          native: 'npm-registry-v1',
          baseUrl: endpointFor('npm', context) || 'https://registry.npmjs.org',
          searchUrl: `${(endpointFor('npm', context) || 'https://registry.npmjs.org').replace(/\/$/, '')}/-/v1/search`,
          includeDeps: true,
          project: {
            manifest: true,
            lock: true,
            layout: true,
            build: true,
            buildV2: true,
          },
        }),
      codec: () => new NpmCodec(),
      project: () => new NpmProjectFormat(),
      packer: () => new NpmPackagePacker(),
      catalog: (context) =>
        new NpmRegistryProvider(
          transportFor('npm', context),
          clock(context),
          endpointFor('npm', context),
        ),
    },
    {
      id: 'org.openpacker.adapter.cargo',
      purlTypes: ['cargo'],
      registryDefinition: (context = {}) =>
        httpRegistryDefinition({
          registryId: 'urn:openpacker:registry:crates-io',
          displayName: 'crates.io',
          purlTypes: ['cargo'],
          native: 'cargo-sparse-v1',
          baseUrl: endpointFor('cargo', context) || 'https://index.crates.io',
          includeDeps: true,
          project: { manifest: true, lock: true, buildV2: true },
        }),
      codec: () => new CargoCodec(),
      project: () => new CargoProjectFormat(),
      packer: cargoPacker,
      catalog: (context) =>
        new CargoSparseProvider(
          transportFor('cargo', context),
          clock(context),
          endpointFor('cargo', context),
        ),
    },
    {
      id: 'org.openpacker.adapter.pypi',
      purlTypes: ['pypi'],
      registryDefinition: (context = {}) =>
        httpRegistryDefinition({
          registryId: 'urn:openpacker:registry:pypi-org',
          displayName: 'PyPI',
          purlTypes: ['pypi'],
          native: 'pypi-json-v1',
          baseUrl: endpointFor('pypi', context) || 'https://pypi.org/pypi',
          includeDeps: true,
          project: { manifest: true, buildV2: true },
        }),
      codec: () => new PypiCodec(),
      project: () => new PypiProjectFormat(),
      packer: pypiPacker,
      catalog: (context) =>
        new PypiJsonProvider(
          transportFor('pypi', context),
          clock(context),
          endpointFor('pypi', context),
        ),
    },
    {
      id: 'org.openpacker.adapter.nuget',
      purlTypes: ['nuget'],
      registryDefinition: async (context = {}) => {
        // Prefer mapping from the live NuGet service index when transport is
        // available; fall back to a static mapping of known v3 resource types.
        const endpoint =
          endpointFor('nuget', context) ||
          'https://api.nuget.org/v3/index.json';
        try {
          if (context.offline) throw new Error('offline');
          const transport = transportFor('nuget', context);
          const response = await transport.request({
            url: endpoint,
            method: 'GET',
            headers: { accept: 'application/json' },
          });
          const body = JSON.parse(new TextDecoder().decode(response.body)) as {
            resources?: Array<{ '@id': string; '@type': string | string[] }>;
          };
          const resources = (body.resources ?? []).flatMap((resource) => {
            const types = Array.isArray(resource['@type'])
              ? resource['@type']
              : [resource['@type']];
            const mapped: string[] = [];
            for (const type of types) {
              if (type.startsWith('RegistrationsBaseUrl'))
                mapped.push(
                  'prex.registry.package-metadata/1',
                  'prex.registry.enumerate-versions/1',
                );
              else if (type.startsWith('PackageBaseAddress'))
                mapped.push('prex.registry.artifact/1');
              else if (type.startsWith('SearchQueryService'))
                mapped.push('prex.registry.search/1');
            }
            if (mapped.length === 0) return [];
            const unique = [...new Set(mapped)];
            const entry: {
              '@id': string;
              '@type': string | string[];
              clientVersion?: string;
            } = {
              '@id': resource['@id'],
              '@type': unique.length === 1 ? unique[0]! : unique,
            };
            if (types[0] !== undefined) entry.clientVersion = types[0];
            return [entry];
          });
          if (resources.length > 0)
            return {
              registryDefinitionVersion: '1' as const,
              registryId: 'urn:openpacker:registry:nuget-org',
              displayName: 'nuget.org',
              purlTypes: ['nuget'],
              protocol: { native: 'nuget-v3', transport: ['https' as const] },
              resources: [
                {
                  '@id': endpoint,
                  '@type': 'prex.registry.service-index/1' as const,
                },
                ...resources,
                // The service index describes nuget.org; the project format
                // describes the working tree, so it is added either way.
                {
                  '@id': 'project:workspace',
                  '@type': [
                    'prex.registry.project-manifest/1',
                    'prex.registry.project-lock/1',
                    'prex.registry.project-layout/1',
                    'prex.registry.package-build/1',
                    'prex.registry.package-build/2',
                  ] as const,
                },
              ],
              features: {
                offlineReplay: false,
                installSideEffects: 'project-store' as const,
                reversibility: 'project-generation' as const,
                requiresElevation: 'never' as const,
              },
            } as const satisfies import('@openpacker/adapter-host').RegistryDefinition;
        } catch {
          // fall through to static definition
        }
        return httpRegistryDefinition({
          registryId: 'urn:openpacker:registry:nuget-org',
          displayName: 'nuget.org',
          purlTypes: ['nuget'],
          native: 'nuget-v3',
          baseUrl: endpoint,
          includeArtifact: true,
          project: {
            manifest: true,
            lock: true,
            layout: true,
            build: true,
            buildV2: true,
          },
        });
      },
      codec: () => new NugetCodec(),
      project: () => new NugetProjectFormat(),
      packer: nugetPacker,
      catalog: (context) =>
        new NugetV3Provider(
          transportFor('nuget', context),
          clock(context),
          endpointFor('nuget', context),
        ),
    },
    {
      id: 'org.openpacker.adapter.maven',
      purlTypes: ['maven'],
      registryDefinition: (context = {}) =>
        httpRegistryDefinition({
          registryId: 'urn:openpacker:registry:maven-central',
          displayName: 'Maven Central',
          purlTypes: ['maven'],
          native: 'maven-repo-v1',
          baseUrl:
            endpointFor('maven', context) || 'https://repo1.maven.org/maven2',
          project: { manifest: true, buildV2: true },
        }),
      codec: () => new MavenCodec(),
      project: () => new MavenProjectFormat(),
      packer: mavenPacker,
      catalog: (context) =>
        new MavenRepositoryProvider(
          transportFor('maven', context),
          clock(context),
          endpointFor('maven', context),
        ),
    },
    {
      id: 'org.openpacker.adapter.golang',
      purlTypes: ['golang'],
      registryDefinition: (context = {}) =>
        httpRegistryDefinition({
          registryId: 'urn:openpacker:registry:proxy-golang-org',
          displayName: 'proxy.golang.org',
          purlTypes: ['golang'],
          native: 'golang-proxy-v1',
          baseUrl: endpointFor('golang', context) || 'https://proxy.golang.org',
          project: { manifest: true },
        }),
      codec: () => new GolangCodec(),
      project: () => new GolangProjectFormat(),
      catalog: (context) =>
        new GolangProxyProvider(
          transportFor('golang', context),
          clock(context),
          endpointFor('golang', context),
        ),
    },
    {
      id: 'org.openpacker.adapter.oci',
      purlTypes: ['oci'],
      registryDefinition: () =>
        httpRegistryDefinition({
          registryId: 'urn:openpacker:registry:oci-distribution',
          displayName: 'OCI Distribution',
          purlTypes: ['oci'],
          native: 'oci-distribution-v1',
          baseUrl: 'https://registry-1.docker.io',
          includeArtifact: true,
          project: { buildV2: true },
        }),
      packer: ociPacker,
      catalog: (context) =>
        new OciRegistryProvider({
          ...(context.now ? { now: context.now } : {}),
          ...(context.fetch ? { fetch: context.fetch } : {}),
        }) as never,
    },
    {
      id: 'org.openpacker.adapter.nix',
      purlTypes: ['nix'],
      // Only advertise what the module exports: codec + InstallerProvider.
      // NixStoreProvider also has search/closure helpers, but they are not
      // wired as catalog/environment WIT exports yet — do not lie on the index.
      registryDefinition: () => ({
        registryDefinitionVersion: '1' as const,
        registryId: 'urn:openpacker:registry:nixpkgs',
        displayName: 'Nix (nixpkgs / flakes)',
        purlTypes: ['nix'],
        protocol: { native: 'nix-flake-v1', transport: ['nix', 'exec'] },
        resources: [
          {
            '@id': 'exec:nix',
            '@type': [
              'prex.registry.install/1',
              'prex.registry.package-build/2',
            ] as const,
          },
        ],
        features: {
          offlineReplay: false,
          signedMetadata: true,
          installSideEffects: 'user-profile' as const,
          reversibility: 'native-generation' as const,
          requiresElevation: 'never' as const,
        },
      }),
      codec: () => new NixCodec(),
      installer: () => new NixStoreProvider(),
      packer: nixPacker,
    },
    {
      id: 'org.openpacker.adapter.apt',
      purlTypes: ['deb', 'apt'],
      registryDefinition: () =>
        hostInstallerDefinition({
          registryId: 'urn:openpacker:registry:apt',
          displayName: 'apt (dpkg)',
          purlTypes: ['deb', 'apt'],
          native: 'apt-get-v1',
          execId: 'exec:apt-get',
          extraResources: ['prex.registry.package-build/2'],
          features: {
            installSideEffects: 'system',
            reversibility: 'uninstall',
            requiresElevation: 'sometimes',
            offlineReplay: false,
          },
        }),
      installer: () => new AptSystemProvider(),
      packer: debPacker,
    },
    {
      id: 'org.openpacker.adapter.winget',
      purlTypes: ['winget'],
      registryDefinition: () =>
        hostInstallerDefinition({
          registryId: 'urn:openpacker:registry:winget',
          displayName: 'winget',
          purlTypes: ['winget'],
          native: 'winget-v1',
          execId: 'exec:winget',
          extraResources: ['prex.registry.package-build/2'],
          features: {
            installSideEffects: 'system',
            reversibility: 'uninstall',
            requiresElevation: 'sometimes',
            offlineReplay: false,
          },
        }),
      installer: () => new WingetSystemProvider(),
      packer: wingetPacker,
    },
    {
      id: 'org.openpacker.adapter.chocolatey',
      purlTypes: ['chocolatey'],
      registryDefinition: () =>
        hostInstallerDefinition({
          registryId: 'urn:openpacker:registry:chocolatey',
          displayName: 'Chocolatey',
          purlTypes: ['chocolatey'],
          native: 'chocolatey-v1',
          execId: 'exec:choco',
          extraResources: ['prex.registry.package-build/2'],
          features: {
            installSideEffects: 'system',
            reversibility: 'uninstall',
            requiresElevation: 'always',
            offlineReplay: false,
          },
        }),
      installer: () => new ChocolateyProvider(),
      packer: chocolateyPacker,
    },
  ];
}

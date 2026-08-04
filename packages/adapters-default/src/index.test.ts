import { describe, expect, it } from 'vitest';
import { assertWitShapedModule, hasResource } from '@openpacker/adapter-host';
import {
  configureDefaultAdapters,
  createDefaultAdapterRegistry,
  defaultAdapterModules,
} from './index.js';

describe('default adapters', () => {
  it('registers npm through cargo/oci/nix/host managers without core switches', async () => {
    const registry = createDefaultAdapterRegistry();
    const types = registry.purlTypes();
    for (const expected of [
      'npm',
      'cargo',
      'pypi',
      'nuget',
      'maven',
      'golang',
      'oci',
      'nix',
      'deb',
      'winget',
      'chocolatey',
    ])
      expect(types, expected).toContain(expected);

    const npm = await registry.definitionFor('npm');
    expect(hasResource(npm, 'prex.registry.artifact/1')).toBe(true);
    expect(hasResource(npm, 'prex.registry.install/1')).toBe(false);

    const nix = await registry.definitionFor('nix');
    expect(hasResource(nix, 'prex.registry.install/1')).toBe(true);
    expect(await registry.prefersHostInstall('nix')).toBe(true);

    const choco = await registry.definitionFor('chocolatey');
    expect(hasResource(choco, 'prex.registry.install/1')).toBe(true);
  });

  it('every default module satisfies the WIT-shaped bridge contract', async () => {
    for (const module of defaultAdapterModules())
      await assertWitShapedModule(module);
  });

  it('configures the process-wide registry', () => {
    const registry = configureDefaultAdapters();
    expect(registry.moduleFor('npm').id).toContain('npm');
  });

  it('fails closed when requesting install on catalog-only npm', async () => {
    const registry = createDefaultAdapterRegistry();
    await expect(registry.installerFor('npm')).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
  });

  it('fails closed when requesting search when not advertised', async () => {
    const registry = createDefaultAdapterRegistry();
    // cargo sparse does not advertise search in the synthetic definition
    const cargo = await registry.definitionFor('cargo');
    expect(hasResource(cargo, 'prex.registry.search/1')).toBe(false);
    await expect(
      registry.catalogFor('cargo', {}, ['prex.registry.search/1']),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('advertises only resources each module can honor', async () => {
    const registry = createDefaultAdapterRegistry();
    const expected: Record<string, string[]> = {
      npm: [
        'prex.registry.package-metadata/1',
        'prex.registry.enumerate-versions/1',
        'prex.registry.artifact/1',
        'prex.registry.search/1',
      ],
      cargo: [
        'prex.registry.package-metadata/1',
        'prex.registry.enumerate-versions/1',
        'prex.registry.artifact/1',
        'prex.registry.dependency-graph/1',
      ],
      oci: [
        'prex.registry.package-metadata/1',
        'prex.registry.enumerate-versions/1',
        'prex.registry.artifact/1',
      ],
      // Install-only until catalog/environment exports are wired.
      nix: ['prex.registry.install/1'],
      deb: ['prex.registry.install/1'],
      winget: ['prex.registry.install/1'],
      chocolatey: ['prex.registry.install/1'],
    };
    const forbiddenOnHost: Record<string, string[]> = {
      nix: [
        'prex.registry.search/1',
        'prex.registry.package-metadata/1',
        'prex.registry.uninstall/1',
        'prex.registry.environment/1',
      ],
      deb: [
        'prex.registry.search/1',
        'prex.registry.package-metadata/1',
        'prex.registry.uninstall/1',
      ],
      winget: [
        'prex.registry.search/1',
        'prex.registry.package-metadata/1',
        'prex.registry.uninstall/1',
      ],
      chocolatey: [
        'prex.registry.search/1',
        'prex.registry.package-metadata/1',
        'prex.registry.uninstall/1',
      ],
    };
    for (const [purlType, resources] of Object.entries(expected)) {
      const definition = await registry.definitionFor(purlType);
      for (const type of resources)
        expect(hasResource(definition, type), `${purlType} ${type}`).toBe(true);
    }
    for (const [purlType, resources] of Object.entries(forbiddenOnHost)) {
      const definition = await registry.definitionFor(purlType);
      for (const type of resources)
        expect(
          hasResource(definition, type),
          `${purlType} must not lie ${type}`,
        ).toBe(false);
    }
  });

  it('maps a NuGet v3 service index into Registry Definition resources', async () => {
    const serviceIndex = {
      version: '3.0.0',
      resources: [
        {
          '@id': 'https://api.nuget.org/v3/registration5-gz-semver2/',
          '@type': 'RegistrationsBaseUrl/3.6.0',
        },
        {
          '@id': 'https://api.nuget.org/v3-flatcontainer/',
          '@type': 'PackageBaseAddress/3.0.0',
        },
        {
          '@id': 'https://azuresearch-usnc.nuget.org/query',
          '@type': 'SearchQueryService/3.5.0',
        },
      ],
    };
    const body = new TextEncoder().encode(JSON.stringify(serviceIndex));
    const registry = createDefaultAdapterRegistry();
    const definition = await registry.definitionFor('nuget', {
      offline: false,
      transport: {
        request: async () => ({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body,
          url: 'https://api.nuget.org/v3/index.json',
        }),
      },
    });
    expect(hasResource(definition, 'prex.registry.service-index/1')).toBe(true);
    expect(hasResource(definition, 'prex.registry.package-metadata/1')).toBe(
      true,
    );
    expect(hasResource(definition, 'prex.registry.artifact/1')).toBe(true);
    expect(hasResource(definition, 'prex.registry.search/1')).toBe(true);
    // Absent type remains unsupported even after a live index load.
    expect(hasResource(definition, 'prex.registry.install/1')).toBe(false);
  });
});

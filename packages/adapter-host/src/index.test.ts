import { describe, expect, it } from 'vitest';
import {
  AdapterHostError,
  AdapterRegistry,
  assertWitContractModule,
  hasResource,
  requireResource,
  serviceIndexBytes,
  parseServiceIndex,
  type AdapterModule,
  type RegistryDefinition,
} from './index.js';

function definition(
  resources: RegistryDefinition['resources'],
): RegistryDefinition {
  return {
    registryDefinitionVersion: '1',
    registryId: 'urn:openpacker:registry:fixture',
    purlTypes: ['fixture'],
    resources,
  };
}

function fixtureModule(
  partial: Partial<AdapterModule> & Pick<AdapterModule, 'registryDefinition'>,
): AdapterModule {
  return {
    id: 'org.openpacker.adapter.fixture',
    purlTypes: ['fixture'],
    ...partial,
  };
}

describe('AdapterRegistry discovery', () => {
  it('routes by purl type without a hardwired ecosystem switch', async () => {
    const registry = new AdapterRegistry();
    const module = fixtureModule({
      registryDefinition: () =>
        definition([
          {
            '@id': 'https://fixtures.openpacker.invalid/',
            '@type': 'prex.registry.package-metadata/1',
          },
        ]),
      codec: () =>
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        ({
          purlType: 'fixture',
          canonicalizePurl: (p: string) => p,
        }) as never,
    });
    registry.register(module);
    expect(registry.purlTypes()).toEqual(['fixture']);
    expect(registry.codecFor('fixture').purlType).toBe('fixture');
    await expect(
      registry.catalogFor('fixture', {}, ['prex.registry.package-metadata/1']),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('fails closed when a resource type is not advertised', async () => {
    const definitionOnly = definition([
      {
        '@id': 'https://fixtures.openpacker.invalid/',
        '@type': 'prex.registry.package-metadata/1',
      },
    ]);
    expect(hasResource(definitionOnly, 'prex.registry.install/1')).toBe(false);
    expect(() =>
      requireResource(definitionOnly, 'prex.registry.install/1'),
    ).toThrow(AdapterHostError);

    const registry = new AdapterRegistry();
    registry.register(
      fixtureModule({
        registryDefinition: () => definitionOnly,
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        installer: () => ({ install: async () => ({}) }) as never,
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        catalog: () => ({ inspect: async () => ({}) }) as never,
      }),
    );
    await expect(registry.installerFor('fixture')).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
    await expect(
      registry.catalogFor('fixture', {}, [
        'prex.registry.enumerate-versions/1',
      ]),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    await expect(
      registry.catalogFor('fixture', {}, ['prex.registry.artifact/1']),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    await expect(
      registry.catalogFor('fixture', {}, ['prex.registry.search/1']),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
    await expect(registry.packerFor('fixture')).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
    // Present resource is allowed.
    await expect(
      registry.catalogFor('fixture', {}, ['prex.registry.package-metadata/1']),
    ).resolves.toBeDefined();
  });

  it('routes package-build v2 through the packer export', async () => {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const packer = { providerId: 'fixture-pack', purlType: 'fixture' } as never;
    const registry = new AdapterRegistry();
    registry.register(
      fixtureModule({
        registryDefinition: () =>
          definition([
            {
              '@id': 'exec:fixture-pack',
              '@type': 'prex.registry.package-build/2',
            },
          ]),
        packer: () => packer,
      }),
    );
    await expect(registry.packerFor('fixture')).resolves.toBe(packer);
  });

  it('routes configured delegated pack providers independently from adapters', () => {
    const registry = new AdapterRegistry();
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const first = {
      providerId: 'example.first',
      purlType: 'fixture',
    } as never;
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const second = {
      providerId: 'example.second',
      purlType: 'fixture',
    } as never;
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const third = {
      providerId: 'example.third',
      purlType: 'fixture',
    } as never;
    registry.registerPackProvider(first, { makeDefault: true });
    registry.registerPackProvider(second);

    expect(registry.packProviderIds()).toEqual([
      'example.first',
      'example.second',
    ]);
    expect(registry.delegatedPackerFor('fixture')).toBe(first);
    expect(registry.delegatedPackerFor('fixture', 'example.second')).toBe(
      second,
    );
    expect(() => registry.delegatedPackerFor('other', 'example.first')).toThrow(
      /does not support/u,
    );
    expect(() =>
      registry.registerPackProvider(third, { makeDefault: true }),
    ).toThrow(/already defaults/u);
    expect(registry.packProviderIds()).not.toContain('example.third');
  });

  it('fails closed for update/uninstall/environment when not advertised', async () => {
    const registry = new AdapterRegistry();
    registry.register(
      fixtureModule({
        registryDefinition: () =>
          definition([
            {
              '@id': 'exec:tool',
              '@type': 'prex.registry.install/1',
            },
          ]),
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        installer: () => ({ install: async () => ({}) }) as never,
      }),
    );
    const def = await registry.definitionFor('fixture');
    for (const type of [
      'prex.registry.update/1',
      'prex.registry.uninstall/1',
      'prex.registry.environment/1',
      'prex.registry.package-config/1',
    ]) {
      expect(hasResource(def, type)).toBe(false);
      expect(() => requireResource(def, type)).toThrow(/does not advertise/);
    }
  });

  it('prefers host install when installSideEffects is system/profile', async () => {
    const registry = new AdapterRegistry();
    registry.register(
      fixtureModule({
        registryDefinition: () => ({
          ...definition([
            {
              '@id': 'exec:tool',
              '@type': 'prex.registry.install/1',
            },
          ]),
          features: {
            installSideEffects: 'system',
            reversibility: 'uninstall',
          },
        }),
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        installer: () => ({}) as never,
      }),
    );
    expect(await registry.prefersHostInstall('fixture')).toBe(true);
  });
});

describe('WIT-shaped bridge', () => {
  it('round-trips service-index bytes and validates the module surface', async () => {
    const module = fixtureModule({
      registryDefinition: () =>
        definition([
          {
            '@id': 'https://fixtures.openpacker.invalid/',
            '@type': 'prex.registry.enumerate-versions/1',
          },
        ]),
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      codec: () => ({ purlType: 'fixture' }) as never,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      catalog: () => ({}) as never,
    });
    await assertWitContractModule(module);
    const bytes = await serviceIndexBytes(module);
    const parsed = parseServiceIndex(bytes);
    expect(parsed.registryId).toBe('urn:openpacker:registry:fixture');
  });

  it('rejects modules that advertise catalog resources without catalog export', async () => {
    const dishonest = fixtureModule({
      registryDefinition: () =>
        definition([
          {
            '@id': 'exec:tool',
            '@type': [
              'prex.registry.search/1',
              'prex.registry.package-metadata/1',
              'prex.registry.install/1',
            ],
          },
        ]),
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      installer: () => ({ install: async () => ({}) }) as never,
    });
    await expect(assertWitContractModule(dishonest)).rejects.toMatchObject({
      code: 'INVALID_ADAPTER',
    });
  });

  it('rejects package-build v2 without a packer export', async () => {
    const dishonest = fixtureModule({
      registryDefinition: () =>
        definition([
          {
            '@id': 'exec:fixture-pack',
            '@type': 'prex.registry.package-build/2',
          },
        ]),
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      codec: () => ({}) as never,
    });
    await expect(assertWitContractModule(dishonest)).rejects.toMatchObject({
      code: 'INVALID_ADAPTER',
    });
  });

  it('rejects uninstall advertisement without uninstall() on installer', async () => {
    const dishonest = fixtureModule({
      registryDefinition: () =>
        definition([
          {
            '@id': 'exec:tool',
            '@type': ['prex.registry.install/1', 'prex.registry.uninstall/1'],
          },
        ]),
      installer: () =>
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        ({ install: async () => ({}), plan: async () => ({}) }) as never,
    });
    await expect(assertWitContractModule(dishonest)).rejects.toMatchObject({
      code: 'INVALID_ADAPTER',
    });
  });

  it('loads an adapter advertising a resource type this host predates', async () => {
    // registry-resource-types.md: "Unknown types MUST be ignored by v1
    // clients." Refusing them would make every new vocabulary entry a
    // breaking change for hosts built before it.
    const future = fixtureModule({
      registryDefinition: () =>
        definition([
          {
            '@id': 'https://fixtures.openpacker.invalid/',
            '@type': [
              'prex.registry.enumerate-versions/1',
              'prex.registry.attestation/1',
            ],
          },
        ]),
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      catalog: () => ({}) as never,
    });
    await expect(assertWitContractModule(future)).resolves.toBeUndefined();
  });

  it('rejects a malformed type in the reserved prex namespace', async () => {
    // Unrecognised is fine; unversioned is not — `prex.` claims the PREX
    // vocabulary, so a member of it has to be shaped like one.
    for (const bad of [
      'prex.registry.attestation',
      'prex.registry.Attestation/1',
      'prex.attestation/1',
      'prex.registry.attestation/0',
    ]) {
      const malformed = fixtureModule({
        registryDefinition: () =>
          definition([
            {
              '@id': 'https://fixtures.openpacker.invalid/',
              '@type': ['prex.registry.enumerate-versions/1', bad],
            },
          ]),
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        catalog: () => ({}) as never,
      });
      await expect(
        assertWitContractModule(malformed),
        bad,
      ).rejects.toMatchObject({ code: 'INVALID_REGISTRY_DEFINITION' });
    }
  });

  it('carries vendor-namespaced resource types without objecting', async () => {
    const extended = fixtureModule({
      registryDefinition: () =>
        definition([
          {
            '@id': 'https://fixtures.openpacker.invalid/',
            '@type': [
              'prex.registry.enumerate-versions/1',
              'com.example.mirror-status/1',
            ],
          },
        ]),
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      catalog: () => ({}) as never,
    });
    await expect(assertWitContractModule(extended)).resolves.toBeUndefined();
  });
});

describe('config discovery without core import tables', () => {
  it('refuses JavaScript imports before their top-level code can execute', async () => {
    const { createRegistryFromDiscovery } = await import('./discovery.js');
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    delete (globalThis as { opmImported?: boolean }).opmImported;
    await expect(
      createRegistryFromDiscovery({
        imports: [
          'data:text/javascript,globalThis.opmImported=true;export default {}',
        ],
      }),
    ).rejects.toMatchObject({ code: 'ADAPTER_LOAD_DISABLED' });
    expect(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      (globalThis as { opmImported?: boolean }).opmImported,
    ).toBeUndefined();
  });
});

describe('named sources', () => {
  const mirror = (purlTypes: readonly string[]) =>
    fixtureModule({
      id: 'org.openpacker.adapter.mirror',
      purlTypes: [...purlTypes],
      registryDefinition: () => ({
        ...definition([
          {
            '@id': 'https://mirror.invalid/',
            '@type': 'prex.registry.package-metadata/1',
          },
        ]),
        registryId: 'urn:openpacker:registry:mirror',
        purlTypes: [...purlTypes],
      }),
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      catalog: () => ({ inspect: async () => ({}) }) as never,
    });

  it('does not let a source displace an ecosystem default', async () => {
    const registry = new AdapterRegistry();
    registry.register(
      fixtureModule({
        purlTypes: ['npm'],
        registryDefinition: () => ({
          ...definition([
            {
              '@id': 'https://registry.npmjs.org',
              '@type': 'prex.registry.package-metadata/1',
            },
          ]),
          registryId: 'urn:openpacker:registry:npmjs-org',
          purlTypes: ['npm'],
        }),
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        catalog: () => ({ inspect: async () => ({}) }) as never,
      }),
    );
    // A registry serving npm, PyPI and NuGet at once would silently take over
    // all three if it registered the ordinary way.
    registry.registerSource('mirror', mirror(['npm', 'pypi', 'nuget']));

    expect((await registry.definitionFor('npm')).registryId).toBe(
      'urn:openpacker:registry:npmjs-org',
    );
    expect(
      (await registry.definitionFor('npm', { sourceId: 'mirror' })).registryId,
    ).toBe('urn:openpacker:registry:mirror');
    // The source is not reachable as a default for a type nobody registered.
    expect(registry.has('pypi')).toBe(false);
    expect(registry.sourceIds()).toEqual(['mirror']);
  });

  it('refuses a source that does not serve the purl type', async () => {
    const registry = new AdapterRegistry();
    registry.registerSource('mirror', mirror(['npm']));
    // Falling back to the ecosystem default here would fetch from somewhere
    // the caller did not ask for.
    await expect(
      registry.definitionFor('cargo', { sourceId: 'mirror' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_ECOSYSTEM' });
  });

  it('reports an unknown source by name', async () => {
    const registry = new AdapterRegistry();
    registry.registerSource('mirror', mirror(['npm']));
    await expect(
      registry.definitionFor('npm', { sourceId: 'typo' }),
    ).rejects.toMatchObject({ code: 'UNKNOWN_SOURCE' });
  });

  it('routes catalogFor through the named source', async () => {
    const registry = new AdapterRegistry();
    registry.registerSource('mirror', mirror(['npm']));
    await expect(
      registry.catalogFor('npm', { sourceId: 'mirror' }),
    ).resolves.toBeDefined();
  });

  it('lets one named source use the native adapter for each ecosystem', async () => {
    const registry = new AdapterRegistry();
    registry.registerSource('mirror', mirror(['npm']));
    registry.registerSource('mirror', mirror(['pypi']));
    await expect(
      registry.definitionFor('npm', { sourceId: 'mirror' }),
    ).resolves.toMatchObject({ purlTypes: ['npm'] });
    await expect(
      registry.definitionFor('pypi', { sourceId: 'mirror' }),
    ).resolves.toMatchObject({ purlTypes: ['pypi'] });
  });

  it('refuses an empty source id', () => {
    const registry = new AdapterRegistry();
    expect(() => registry.registerSource('  ', mirror(['npm']))).toThrow(
      AdapterHostError,
    );
  });
});

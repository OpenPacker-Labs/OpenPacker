import { describe, expect, it } from 'vitest';
import {
  AdapterHostError,
  AdapterRegistry,
  assertWitShapedModule,
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
        installer: () => ({ install: async () => ({}) }) as never,
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
    // Present resource is allowed.
    await expect(
      registry.catalogFor('fixture', {}, ['prex.registry.package-metadata/1']),
    ).resolves.toBeDefined();
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
      codec: () => ({ purlType: 'fixture' }) as never,
    });
    await assertWitShapedModule(module);
    const bytes = await serviceIndexBytes(module);
    const parsed = parseServiceIndex(bytes);
    expect(parsed.registryId).toBe('urn:openpacker:registry:fixture');
  });
});

describe('config discovery without core import tables', () => {
  it('loads an external fixture adapter via imports only', async () => {
    const { createRegistryFromDiscovery } = await import('./discovery.js');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const root = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../fixtures/adapters/external-fixture/index.js',
    );
    const registry = await createRegistryFromDiscovery({
      imports: [root],
    });
    expect(registry.has('external-fixture')).toBe(true);
    expect(registry.codecFor('external-fixture').purlType).toBe(
      'external-fixture',
    );
    const def = await registry.definitionFor('external-fixture');
    expect(hasResource(def, 'prex.registry.package-metadata/1')).toBe(true);
    await expect(
      registry.installerFor('external-fixture'),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });
});

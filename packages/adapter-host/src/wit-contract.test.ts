import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  AdapterHostError,
  assertWitShapedModule,
  parseServiceIndex,
  serviceIndexBytes,
  type AdapterModule,
  type RegistryDefinition,
} from './index.js';

const fixtureDirectory = new URL(
  '../../../fixtures/protocol/wit-adapter/',
  import.meta.url,
);

const CATALOG_RESOURCES = [
  'prex.registry.search/1',
  'prex.registry.enumerate-versions/1',
  'prex.registry.package-metadata/1',
  'prex.registry.artifact/1',
  'prex.registry.dependency-graph/1',
] as const;

async function loadServiceIndexFixtures(): Promise<
  readonly { name: string; text: string; definition: RegistryDefinition }[]
> {
  const names = (await readdir(fixtureDirectory))
    .filter((name) => name.endsWith('.json'))
    .sort();
  return Promise.all(
    names.map(async (name) => {
      const text = await readFile(new URL(name, fixtureDirectory), 'utf8');
      return {
        name,
        text,
        definition: JSON.parse(text) as RegistryDefinition,
      };
    }),
  );
}

function advertisedTypes(definition: RegistryDefinition): string[] {
  return definition.resources.flatMap((resource) =>
    Array.isArray(resource['@type'])
      ? [...resource['@type']]
      : [resource['@type']],
  );
}

/** Minimal WIT-shaped guest whose exports match advertised resources. */
function moduleForDefinition(definition: RegistryDefinition): AdapterModule {
  const types = advertisedTypes(definition);
  const module: AdapterModule = {
    id: 'org.openpacker.adapter.wit-contract',
    purlTypes:
      definition.purlTypes.length > 0 ? definition.purlTypes : ['generic'],
    registryDefinition: () => definition,
  };
  if (
    types.some((type) =>
      (CATALOG_RESOURCES as readonly string[]).includes(type),
    )
  )
    module.catalog = () => ({}) as never;
  if (!module.catalog && !module.codec && !module.installer && !module.packer)
    module.codec = () => ({ purlType: module.purlTypes[0] }) as never;
  return module;
}

describe('WIT-shaped contract fixtures', () => {
  it('round-trips committed service-index JSON through parseServiceIndex', async () => {
    const fixtures = await loadServiceIndexFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(2);

    for (const { name, text, definition } of fixtures) {
      const parsed = parseServiceIndex(new TextEncoder().encode(text));
      expect(parsed.registryDefinitionVersion, name).toBe('1');
      expect(parsed.registryId, name).toBe(definition.registryId);
      expect(parsed.resources, name).toEqual(definition.resources);

      const canonical = await serviceIndexBytes(moduleForDefinition(parsed));
      const roundTrip = parseServiceIndex(canonical);
      expect(roundTrip.registryId, name).toBe(parsed.registryId);
      expect(roundTrip.purlTypes, name).toEqual(parsed.purlTypes);
      expect(roundTrip.resources, name).toEqual(parsed.resources);
      expect(roundTrip.registryDefinitionVersion, name).toBe('1');
    }
  });

  it('accepts fixtures as assertWitShapedModule guests when exports match', async () => {
    const fixtures = await loadServiceIndexFixtures();
    expect(
      fixtures.some(({ definition }) =>
        advertisedTypes(definition).includes('prex.registry.search/1'),
      ),
    ).toBe(true);

    for (const { name, definition } of fixtures)
      await expect(
        assertWitShapedModule(moduleForDefinition(definition)),
        name,
      ).resolves.toBeUndefined();
  });

  it('accepts a minimal fake module that matches the WIT-shaped surface', async () => {
    const module: AdapterModule = {
      id: 'org.openpacker.adapter.wit-contract-min',
      purlTypes: ['generic'],
      registryDefinition: () => ({
        registryDefinitionVersion: '1',
        registryId: 'urn:openpacker:registry:wit-contract-min',
        purlTypes: ['generic'],
        resources: [
          {
            '@id': 'https://fixtures.openpacker.invalid/wit-min/',
            '@type': 'prex.registry.package-metadata/1',
          },
        ],
      }),
      catalog: () => ({ inspect: async () => ({}) }) as never,
    };
    await expect(assertWitShapedModule(module)).resolves.toBeUndefined();
  });

  it('rejects advertising prex.registry.search/1 without catalog as INVALID_ADAPTER', async () => {
    const dishonest: AdapterModule = {
      id: 'org.openpacker.adapter.wit-contract-search-lie',
      purlTypes: ['generic'],
      registryDefinition: () => ({
        registryDefinitionVersion: '1',
        registryId: 'urn:openpacker:registry:wit-contract-search-lie',
        purlTypes: ['generic'],
        resources: [
          {
            '@id': 'https://fixtures.openpacker.invalid/search',
            '@type': 'prex.registry.search/1',
          },
        ],
      }),
      // Codec keeps the "no capability export" check from firing first.
      codec: () => ({ purlType: 'generic' }) as never,
    };

    await expect(assertWitShapedModule(dishonest)).rejects.toMatchObject({
      name: 'AdapterHostError',
      code: 'INVALID_ADAPTER',
      message: expect.stringMatching(/prex\.registry\.search\/1.*catalog/u),
    });
    await expect(assertWitShapedModule(dishonest)).rejects.toBeInstanceOf(
      AdapterHostError,
    );
  });
});

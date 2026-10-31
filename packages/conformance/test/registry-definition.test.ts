import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createPrexValidator, parseAndValidateContract } from '../src/index.js';

const fixtureDirectory = new URL(
  '../../../fixtures/protocol/registry-definition/',
  import.meta.url,
);

const SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/registry-definition.schema.json#/$defs/RegistryDefinition';

// One validator for the file, its schema compiled while the file is collected.
// Left to its default, each call below builds a validator and compiles the PREX
// catalog again (about 0.4 s of CPU alone each), and the fixtures test paid
// that once per fixture inside its time budget.
const prex = createPrexValidator();
prex.getSchema(SCHEMA);

describe('Registry Definition fixtures', () => {
  it('validates every v1 fixture against the schema', async () => {
    const names = (await readdir(fixtureDirectory))
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(names.length).toBeGreaterThanOrEqual(4);

    for (const name of names) {
      const text = await readFile(new URL(name, fixtureDirectory), 'utf8');
      const result = parseAndValidateContract(SCHEMA, text, prex);
      expect(result.valid, `${name}: ${JSON.stringify(result.errors)}`).toBe(
        true,
      );
      expect(result.value).toMatchObject({
        registryDefinitionVersion: '1',
      });
    }
  });

  it('rejects a document with no resources', () => {
    const result = parseAndValidateContract(
      SCHEMA,
      JSON.stringify({
        registryDefinitionVersion: '1',
        registryId: 'urn:openpacker:registry:empty',
        purlTypes: ['npm'],
        resources: [],
      }),
      prex,
    );
    expect(result.valid).toBe(false);
  });

  it('rejects an unknown registryDefinitionVersion', () => {
    const result = parseAndValidateContract(
      SCHEMA,
      JSON.stringify({
        registryDefinitionVersion: '99',
        registryId: 'urn:openpacker:registry:future',
        purlTypes: ['npm'],
        resources: [
          {
            '@id': 'https://example.invalid/',
            '@type': 'prex.registry.package-metadata/1',
          },
        ],
      }),
      prex,
    );
    expect(result.valid).toBe(false);
  });
});

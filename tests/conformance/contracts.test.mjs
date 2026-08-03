import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const schemaDirectory = join(root, 'spec/prex/v1/schemas');
const schemas = readdirSync(schemaDirectory)
  .filter((name) => name.endsWith('.schema.json'))
  .sort()
  .map((name) => JSON.parse(readFileSync(join(schemaDirectory, name), 'utf8')));

test('every normative schema has a unique stable PREX id and draft 2020-12 dialect', () => {
  assert.ok(schemas.length >= 7, 'expected the complete PREX v1 schema set');
  const ids = schemas.map((schema) => schema.$id);
  assert.equal(new Set(ids).size, ids.length, 'schema $ids must be unique');
  for (const schema of schemas) {
    assert.match(
      schema.$id,
      /^https:\/\/openpacker\.dev\/spec\/prex\/v1\/schemas\//u,
    );
    assert.equal(
      schema.$schema,
      'https://json-schema.org/draft/2020-12/schema',
    );
  }
});

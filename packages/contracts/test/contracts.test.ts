import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  DIGEST_PROJECTIONS,
  MEDIA_TYPES,
  PREX_CONFORMANCE_LEVELS,
  PREX_PROTOCOL_VERSION,
  schemaCatalog,
} from '../src/index.js';

const specSchemaDirectory = new URL(
  '../../../spec/prex/v1/schemas/',
  import.meta.url,
);

describe('generated PREX contracts', () => {
  it('exports the complete capability and schema catalog', async () => {
    expect(PREX_PROTOCOL_VERSION).toBe('1.0-draft');
    expect(PREX_CONFORMANCE_LEVELS).toHaveLength(10);

    // The catalog must track spec/prex/v1/schemas exactly: a schema added to
    // the spec without regenerating contracts is a drift bug, not a new count.
    const specSchemas = (await readdir(specSchemaDirectory))
      .filter((name) => name.endsWith('.schema.json'))
      .map((name) => `https://openpacker.dev/spec/prex/v1/schemas/${name}`)
      .sort();
    expect(Object.keys(schemaCatalog).sort()).toEqual(specSchemas);
    expect(schemaCatalog).toHaveProperty(
      'https://openpacker.dev/spec/prex/v1/schemas/extensions.schema.json',
    );
    expect(MEDIA_TYPES.overlay).toBe(
      'application/vnd.openpacker.overlay.v1+json',
    );
  });

  it('publishes every declared digest projection with a stable shape', () => {
    const ids = DIGEST_PROJECTIONS.projections.map(
      (projection) => projection.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const projection of DIGEST_PROJECTIONS.projections) {
      expect(projection.algorithm).toBe('sha256');
      expect(projection.canonicalization).toBe('prex-jcs-safe-integer-v1');
      for (const pointer of [
        ...projection.excludePaths,
        ...projection.orderedSetPaths,
      ])
        expect(pointer.startsWith('/')).toBe(true);
    }
    // Realisation and environment identity depend on these existing.
    for (const required of [
      'tree-manifest-v1',
      'build-recipe-v1',
      'recipe-output-v1',
      'substitute-v1',
      'environment-manifest-v1',
      'environment-generation-v1',
    ])
      expect(ids).toContain(required);
  });
});

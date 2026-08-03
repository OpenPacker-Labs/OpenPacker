import { describe, expect, it } from 'vitest';
import {
  MEDIA_TYPES,
  PREX_CONFORMANCE_LEVELS,
  PREX_PROTOCOL_VERSION,
  schemaCatalog,
} from '../src/index.js';

describe('generated PREX contracts', () => {
  it('exports the complete capability and schema catalog', () => {
    expect(PREX_PROTOCOL_VERSION).toBe('1.0-draft');
    expect(PREX_CONFORMANCE_LEVELS).toHaveLength(10);
    expect(Object.keys(schemaCatalog)).toHaveLength(8);
    expect(schemaCatalog).toHaveProperty(
      'https://openpacker.dev/spec/prex/v1/schemas/extensions.schema.json',
    );
    expect(MEDIA_TYPES.overlay).toBe(
      'application/vnd.openpacker.overlay.v1+json',
    );
  });
});

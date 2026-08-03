import { describe, expect, it } from 'vitest';
import {
  parseAndValidateContract,
  validateCanonicalValue,
} from '../src/index.js';

const DIGEST_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/common.schema.json#/$defs/Digest';

describe('PREX canonical contract boundary', () => {
  it('rejects duplicate JSON members before schema validation', () => {
    expect(
      parseAndValidateContract(DIGEST_SCHEMA, '{"a":1,"a":2}'),
    ).toMatchObject({ valid: false });
  });

  it('rejects unsafe numbers and excessive nesting', () => {
    expect(validateCanonicalValue(9_007_199_254_740_992)).not.toEqual([]);
    let value: unknown = null;
    for (let depth = 0; depth < 65; depth += 1) value = [value];
    expect(validateCanonicalValue(value)).not.toEqual([]);
  });
});

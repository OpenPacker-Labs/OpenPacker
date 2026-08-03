import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import {
  canonicalize,
  formatDigest,
  parseCanonicalJson,
  parseDigest,
} from '@openpacker/canonical';

const scalar = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
  fc.string(),
);
const json = fc.letrec((tie) => ({
  value: fc.oneof({ depthSize: 'small' }, scalar, tie('array'), tie('object')),
  array: fc.array(tie('value'), { maxLength: 8 }),
  object: fc.dictionary(fc.string(), tie('value'), { maxKeys: 8 }),
})).value;

test('canonical JSON is parse/serialize idempotent for generated I-JSON', () => {
  fc.assert(
    fc.property(json, (value) => {
      const canonical = canonicalize(value);
      assert.equal(canonicalize(parseCanonicalJson(canonical)), canonical);
    }),
    { seed: 0x50524558, numRuns: 2_000 },
  );
});

test('digest formatting round-trips generated SHA-256 values', () => {
  const hex = fc
    .array(fc.constantFrom(...'0123456789abcdef'), {
      minLength: 64,
      maxLength: 64,
    })
    .map((value) => value.join(''));
  fc.assert(
    fc.property(hex, (value) => {
      assert.deepEqual(
        parseDigest(formatDigest({ algorithm: 'sha256', value })),
        { algorithm: 'sha256', value },
      );
    }),
    { seed: 0x44494745, numRuns: 2_000 },
  );
});

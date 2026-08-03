import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { join, resolve } from 'node:path';
import {
  canonicalize,
  canonicalDigest,
  formatDigest,
} from '@openpacker/canonical';
import { loadEmbeddedResolver } from '@openpacker/embedded';

const root = resolve(import.meta.dirname, '../..');
const input = JSON.parse(
  readFileSync(join(root, 'tests/fixtures/bounded-solve.json'), 'utf8'),
);

async function resolver() {
  return loadEmbeddedResolver(async () => {
    const module = await import('@openpacker/embedded/wasm-node');
    return typeof module.default === 'object' ? module.default : module;
  });
}

test('Node WASM solve, proof checker, and brute-force oracle agree', async () => {
  const embedded = await resolver();
  const first = embedded.solve(input);
  const second = embedded.solve(input);
  assert.deepEqual(
    second,
    first,
    'WASM solve must be byte-structurally deterministic',
  );
  assert.deepEqual(embedded.check(input, first), {
    valid: true,
    diagnostics: [],
  });
  assert.deepEqual(
    embedded.bruteForceOracle(input).selectedNodeIds,
    first.solution.selectedNodeIds,
  );
  const mutated = structuredClone(first);
  mutated.solution.selectedNodeIds = [];
  assert.equal(
    embedded.check(input, mutated).valid,
    false,
    'independent checker accepted a mutated solution',
  );
  const missingWitnesses = structuredClone(first);
  missingWitnesses.proof.requirementWitnesses = [];
  assert.equal(embedded.check(input, missingWitnesses).valid, false);
  const missingObjectiveEvidence = structuredClone(first);
  missingObjectiveEvidence.proof.objectiveEvidence = [];
  assert.equal(embedded.check(input, missingObjectiveEvidence).valid, false);
  const changedSelectedObject = structuredClone(first);
  changedSelectedObject.selected[0].nativeVersion = '999.0.0';
  assert.equal(embedded.check(input, changedSelectedObject).valid, false);
});

test('Rust/WASM and TypeScript canonical bytes and digests agree', async () => {
  const embedded = await resolver();
  const value = { unicode: 'PREX \u2603', nested: { z: true, a: [3, 2, 1] } };
  assert.equal(embedded.canonicalize(value), canonicalize(value));
  assert.equal(
    `${embedded.digest(value).algorithm}:${embedded.digest(value).value}`,
    formatDigest(await canonicalDigest(value)),
  );
});

test('WASM rejects ambiguous JSON and follows native SemVer precedence', async () => {
  const module = await import('@openpacker/embedded/wasm-node');
  const wasm = typeof module.default === 'object' ? module.default : module;
  assert.throws(() => wasm.canonicalize_json('{"a":1,"a":2}'));
  assert.throws(() => wasm.canonicalize_json('9007199254740992'));
  assert.throws(() => wasm.canonicalize_json('-0'));
  assert.equal(wasm.canonicalize_json('1.0'), '1');
  assert.equal(wasm.canonicalize_json('{"":1,"𐀀":2}'), '{"𐀀":2,"":1}');
  assert.equal(wasm.version_satisfies('1.0.0-alpha', 'vers:npm/<1.0.0'), true);
  assert.equal(
    wasm.version_satisfies('1.0.0+build.1', 'vers:npm/=1.0.0+build.2'),
    true,
  );
});

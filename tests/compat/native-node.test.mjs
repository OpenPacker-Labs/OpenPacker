import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { formatDigest } from '@openpacker/canonical';
import { loadEmbeddedResolver } from '@openpacker/embedded';
import { loadNativeEmbeddedResolver } from '@openpacker/embedded/native';

const root = resolve(import.meta.dirname, '../..');
const input = JSON.parse(
  readFileSync(join(root, 'tests/fixtures/bounded-solve.json'), 'utf8'),
);
const receipt = JSON.parse(
  readFileSync(join(root, 'fixtures/golden/receipt.json'), 'utf8'),
);

test('native Node-API and WASM bindings have byte-identical PREX semantics', async () => {
  const wasm = await loadEmbeddedResolver(async () => {
    const module = await import('@openpacker/embedded/wasm-node');
    return typeof module.default === 'object' ? module.default : module;
  });
  const native = await loadNativeEmbeddedResolver();

  const wasmSolved = wasm.solve(input);
  const nativeSolved = native.solve(input);
  assert.deepEqual(nativeSolved, wasmSolved);
  assert.equal(
    native.canonicalize(nativeSolved),
    wasm.canonicalize(wasmSolved),
  );
  const nativeCheck = native.check(input, nativeSolved);
  const wasmCheck = wasm.check(input, wasmSolved);
  assert.deepEqual(nativeCheck, wasmCheck);
  assert.equal(native.canonicalize(nativeCheck), wasm.canonicalize(wasmCheck));

  const canonicalReceipt = wasm.canonicalize(receipt);
  assert.equal(native.canonicalize(receipt), canonicalReceipt);
  assert.deepEqual(native.digest(receipt), wasm.digest(receipt));
  assert.equal(
    native.verifyReceiptDigest(receipt, formatDigest(wasm.digest(receipt))),
    true,
  );
  assert.deepEqual(
    native.bruteForceOracle(input),
    wasm.bruteForceOracle(input),
  );

  for (const profile of ['native-capture-v1', 'native-validated-v1']) {
    const nativeInput = structuredClone(input);
    nativeInput.request.semantics.profile = profile;
    nativeInput.request.environment.locked = [
      nativeInput.universe.packages[0].identity.exactPurl,
    ];
    const nativeProfileSolved = native.solve(nativeInput);
    const wasmProfileSolved = wasm.solve(nativeInput);
    assert.deepEqual(nativeProfileSolved, wasmProfileSolved, profile);
    assert.deepEqual(
      native.check(nativeInput, nativeProfileSolved),
      wasm.check(nativeInput, wasmProfileSolved),
      profile,
    );
  }

  const require = createRequire(import.meta.url);
  const cjsNative =
    await require('@openpacker/embedded/native').loadNativeEmbeddedResolver();
  assert.deepEqual(cjsNative.solve(input), nativeSolved);
});

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createEmbeddedResolver,
  loadEmbeddedResolver,
  type EmbeddedBindings,
} from '../src/index.js';
import { loadNativeEmbeddedResolver } from '../src/native.js';

function bindings(): EmbeddedBindings {
  return {
    solve_json: (input) => input,
    check_json: () => '{"valid":true,"diagnostics":[]}',
    validate_universe_json: () => undefined,
    brute_force_oracle_json: () =>
      '{"selectedNodeIds":[],"assignmentsChecked":1}',
    canonicalize_json: (input) => input,
    digest_json: (input) =>
      `{"algorithm":"sha256","value":"${createHash('sha256').update(input).digest('hex')}"}`,
    version_satisfies: (version, vers) =>
      version === '1.0.0' && vers.includes('1.0.0'),
    normalize_purl: (value) => value.toLowerCase(),
    parse_vers_json: (value) =>
      JSON.stringify({
        vers: value,
        scheme: 'npm',
        original: value,
        normalized: '*',
        ast: { type: 'any' },
        reversible: true,
        semanticLoss: [],
      }),
    verify_sha256: (bytes, expected) =>
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` === expected,
    verify_receipt_digest: () => true,
  };
}

describe('embedded binding boundary', () => {
  it('keeps native and wasm bindings behind the same API', () => {
    const resolver = createEmbeddedResolver(bindings());
    expect(resolver.versionSatisfies('1.0.0', 'vers:npm/>=1.0.0')).toBe(true);
    expect(resolver.normalizePurl('PKG:NPM/DEMO')).toBe('pkg:npm/demo');
    expect(resolver.parseVers('vers:npm/*').ast).toEqual({ type: 'any' });
    expect(
      resolver.verifyArtifactDigest(
        new Uint8Array(),
        'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ),
    ).toBe(true);
    expect(resolver.bruteForceOracle({} as never)).toEqual({
      selectedNodeIds: [],
      assignmentsChecked: 1,
    });
  });

  it('initializes an asynchronously loaded wasm-bindgen module', async () => {
    const init = vi.fn();
    const resolver = await loadEmbeddedResolver(async () =>
      Object.assign(bindings(), { default: init }),
    );
    expect(init).toHaveBeenCalledOnce();
    expect(resolver.check({} as never, {} as never)).toEqual({
      valid: true,
      diagnostics: [],
    });
  });

  it('loads an injected native Node-API binding without WASM initialization', async () => {
    const native = bindings();
    const resolver = await loadNativeEmbeddedResolver(async () => native);
    expect(resolver.normalizePurl('PKG:NPM/DEMO')).toBe('pkg:npm/demo');
  });
});

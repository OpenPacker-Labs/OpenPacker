import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as wasm from '@openpacker/embedded/wasm-node';
import {
  createEmbeddedResolver,
  EmbeddedRefusal,
  type EmbeddedBindings,
  type EmbeddedSolveInput,
} from '../src/index.js';

/**
 * The wasm binding throws the engine's refusal as a string and the Node-API
 * addon as an Error. Through the resolver both are an EmbeddedRefusal with the
 * engine's message unchanged and its leading code in `refusal`, so a caller
 * reads one shape whichever binding it was given.
 */

const UNSATISFIABLE =
  'UNSATISFIABLE: {"code":"UNSATISFIABLE","message":"no assignment satisfies all hard requirements","unsatCore":["root-a"]}';
const RESOURCE_LIMIT =
  'RESOURCE_LIMIT: exhaustive resolution proof requires 2000 work units (limit 1000)';

/** Bindings whose every call throws `thrown`, as the given binding would. */
function refusing(thrown: unknown): EmbeddedBindings {
  const fail = (): never => {
    throw thrown;
  };
  return {
    solve_json: fail,
    check_json: fail,
    validate_universe_json: fail,
    brute_force_oracle_json: fail,
    canonicalize_json: fail,
    digest_json: fail,
    version_satisfies: fail,
    normalize_purl: fail,
    parse_vers_json: fail,
    verify_sha256: fail,
    verify_receipt_digest: fail,
  };
}

/** A Node-API failure: an Error carrying napi's status as its code. */
function napiError(message: string): Error {
  return Object.assign(new Error(message), { code: 'GenericFailure' });
}

/** What `run` threw: an Error, or a string as a binding throws one. */
function caught(run: () => void): Error | string {
  try {
    run();
  } catch (error) {
    if (error instanceof Error || typeof error === 'string') return error;
    throw error;
  }
  throw new Error('expected the call to throw');
}

// SAFETY: The surrounding boundary establishes the asserted domain contract.
const input = { request: {}, universe: {} } as EmbeddedSolveInput;

describe('a refusal from either binding', () => {
  it.each([
    ['UNSATISFIABLE', 'the wasm binding (a string)', UNSATISFIABLE],
    [
      'UNSATISFIABLE',
      'the Node-API addon (an Error)',
      napiError(UNSATISFIABLE),
    ],
    ['RESOURCE_LIMIT', 'the wasm binding (a string)', RESOURCE_LIMIT],
    [
      'RESOURCE_LIMIT',
      'the Node-API addon (an Error)',
      napiError(RESOURCE_LIMIT),
    ],
  ])('%s from %s is an EmbeddedRefusal', (code, _from, thrown) => {
    const error = caught(() =>
      createEmbeddedResolver(refusing(thrown)).solve(input),
    );
    expect(error).toBeInstanceOf(EmbeddedRefusal);
    expect(error).toMatchObject({
      name: 'EmbeddedRefusal',
      message: code === 'UNSATISFIABLE' ? UNSATISFIABLE : RESOURCE_LIMIT,
      refusal: code,
      cause: thrown,
    });
  });

  it('is an EmbeddedRefusal from every call, with no code when the message has none', () => {
    const resolver = createEmbeddedResolver(
      refusing('invalid PREX input: PURL must start with pkg:'),
    );
    for (const call of [
      () => resolver.solve(input),
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      () => resolver.check(input, {} as never),
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      () => resolver.validateUniverse({} as never),
      () => resolver.bruteForceOracle(input),
      () => resolver.canonicalize({}),
      () => resolver.digest({}),
      () => resolver.versionSatisfies('1.0.0', 'vers:npm/*'),
      () => resolver.normalizePurl('demo'),
      () => resolver.parseVers('vers:npm/*'),
      () => resolver.verifyArtifactDigest(new Uint8Array(), 'sha256:00'),
      () => resolver.verifyReceiptDigest({}, 'sha256:00'),
    ])
      expect(caught(call)).toMatchObject({
        name: 'EmbeddedRefusal',
        message: 'invalid PREX input: PURL must start with pkg:',
        refusal: undefined,
      });
  });

  it('leaves an input that is not JSON to its own TypeError', () => {
    const resolver = createEmbeddedResolver(refusing('never reached'));
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const error = caught(() => resolver.canonicalize(undefined as never));
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(EmbeddedRefusal);
  });
});

describe('the wasm binding this package builds', () => {
  const resolver = createEmbeddedResolver(wasm);

  it('refuses an unsatisfiable request with an EmbeddedRefusal, not a string', async () => {
    const golden = async (name: string) =>
      JSON.parse(
        await readFile(
          new URL(`../../../fixtures/golden/${name}.json`, import.meta.url),
          'utf8',
        ),
      );
    const { request, problem } = await golden('unsatisfiable');
    const universe = await golden('universe');
    const error = caught(() => resolver.solve({ request, universe }));
    expect(error).toBeInstanceOf(EmbeddedRefusal);
    expect(error).toMatchObject({
      message: problem.message,
      refusal: 'UNSATISFIABLE',
      cause: problem.message,
    });
  });

  it('refuses an input it cannot read with an EmbeddedRefusal', () => {
    const error = caught(() => resolver.normalizePurl('not a purl'));
    expect(error).toBeInstanceOf(EmbeddedRefusal);
    expect(error).toMatchObject({
      message: 'invalid PREX input: PURL must start with pkg:',
      refusal: undefined,
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbeddedResolver } from '@openpacker/embedded';
import {
  defaultHostEnvironment,
  resolveGraph,
  solveGraph,
} from '../src/index.js';
import { NpmRegistryFixture } from './npm-registry-fixture.js';

/**
 * What the solver's refusal looks like to the caller, in both builds.
 *
 * The wasm build throws the engine's message as a string (`JsValue::from_str`
 * in `crates/openpacker-wasm`); the Node-API addon throws an `Error`. They are
 * one engine, so an unsatisfiable closure must reach a caller as the same
 * `UNRESOLVABLE` that names the requirement nothing can meet, whichever build
 * the machine has. A machine with only one of them tests only one of the two
 * ways to throw, so this file hands the resolver each one itself.
 */

const throwers = [
  {
    name: 'a string, as the wasm build throws it',
    thrown: (message: string): string | Error => message,
  },
  {
    name: 'an Error, as the Node-API addon throws it',
    thrown: (message: string): string | Error => new Error(message),
  },
];

async function graphNeedingAnotherPlatform() {
  return resolveGraph({
    roots: [{ purl: 'pkg:npm/needs-mac' }],
    options: {
      transport: new NpmRegistryFixture([
        {
          name: 'needs-mac',
          versions: {
            '1.0.0': { dependencies: { 'native-darwin-arm64': '1.0.0' } },
          },
        },
        {
          name: 'native-darwin-arm64',
          versions: { '1.0.0': { os: ['darwin'], cpu: ['arm64'] } },
        },
      ]),
    },
    host: defaultHostEnvironment({
      nativeTarget: { os: 'linux', architecture: 'x64', libc: 'glibc' },
    }),
  });
}

describe('an unsatisfiable closure', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(throwers)(
    'is named by its requirement when the engine throws $name',
    async ({ thrown }) => {
      const graph = await graphNeedingAnotherPlatform();
      const solve = EmbeddedResolver.prototype.solve;
      let refused = 0;
      vi.spyOn(EmbeddedResolver.prototype, 'solve').mockImplementation(
        function (this: EmbeddedResolver, input) {
          try {
            return solve.call(this, input);
          } catch (error) {
            refused += 1;
            throw thrown(
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      );
      await expect(
        solveGraph({
          graph,
          rootRequirements: [{ purl: 'pkg:npm/needs-mac' }],
        }),
      ).rejects.toMatchObject({
        code: 'UNRESOLVABLE',
        message: expect.stringMatching(
          /pkg:npm\/needs-mac@1\.0\.0 requires pkg:npm\/native-darwin-arm64 1\.0\.0, and no such release can be installed/u,
        ),
      });
      // The engine did refuse, so the thrown value above was the one tested.
      expect(refused).toBe(1);
    },
  );

  it('does not take any other thrown value for a refusal', async () => {
    const graph = await graphNeedingAnotherPlatform();
    const failure = new Error('INTERNAL_ERROR: the engine broke');
    vi.spyOn(EmbeddedResolver.prototype, 'solve').mockImplementation(() => {
      throw failure;
    });
    await expect(
      solveGraph({
        graph,
        rootRequirements: [{ purl: 'pkg:npm/needs-mac' }],
      }),
    ).rejects.toBe(failure);
  });
});

import { describe, expect, it } from 'vitest';
import { NixStoreProvider } from '../src/index.js';

/**
 * Live Nix: runs only when `nix` is on PATH. Proves the provider drives a real
 * store rather than only the injected fixtures.
 */
const hasNix = await new NixStoreProvider()
  .available()
  .then((a) => a.available);

describe.runIf(hasNix)('live nix', () => {
  const provider = new NixStoreProvider();

  it('resolves nixpkgs#hello through the real store', async () => {
    const closure = await provider.closure('nixpkgs#hello');
    expect(closure.length).toBeGreaterThan(0);
    expect(closure.some((entry) => entry.path.includes('hello'))).toBe(true);
    // Runtime closure includes glibc (or similar) on Linux — dependency
    // resolution that Nix already performed.
    expect(closure.length).toBeGreaterThan(1);
  }, 120_000);

  it('accepts a PURL and records semantic loss for delegated resolution', async () => {
    const { instances, semanticLoss } = await provider.resolve('pkg:nix/hello');
    expect(instances.length).toBeGreaterThan(0);
    expect(semanticLoss.map((loss) => loss.code)).toEqual(
      expect.arrayContaining([
        'NIX_RESOLUTION_DELEGATED',
        'NIX_EXPRESSION_NOT_EVALUATED',
      ]),
    );
  }, 120_000);

  it('plans a profile install without elevation', async () => {
    const plan = await provider.plan('pkg:nix/hello');
    expect(plan.requiresElevation).toBe(false);
    expect(plan.command).toEqual(
      expect.arrayContaining(['nix', 'profile', 'install', 'nixpkgs#hello']),
    );
  });
});

describe.runIf(!hasNix)('live nix (skipped)', () => {
  it('documents that nix was not on PATH for this run', () => {
    expect(hasNix).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { NixStoreProvider } from '../src/index.js';

/** Live host Nix is explicit: tool discovery alone must not touch the store. */
const liveEnabled = process.env.OPENPACKER_LIVE_NIX === '1';
const hasNix = liveEnabled
  ? await new NixStoreProvider().available().then((a) => a.available)
  : false;

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

describe.runIf(!liveEnabled || !hasNix)('live nix (skipped)', () => {
  it('requires explicit opt-in and an available Nix runtime', () => {
    expect(liveEnabled && hasNix).toBe(false);
  });
});

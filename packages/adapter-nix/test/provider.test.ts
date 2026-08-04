import { describe, expect, it } from 'vitest';
import { installableFromPurl, NixStoreProvider } from '../src/index.js';

/**
 * Offline fixtures pin argv and shape decisions. Live Nix coverage lives in
 * `provider.live.test.ts` and runs only when `nix` is on PATH.
 */

// nixbase32 excludes e, o, u and t; this is the alphabet itself.
const OUT = '0123456789abcdfghijklmnpqrsvwxyz';
const LIBC = 'c9dd4k6m8p0r2v6x8z0b2d4f6h8j0l1n';

function nix(responses: Record<string, string>) {
  const calls: string[][] = [];
  const execute = async (file: string, args: readonly string[]) => {
    calls.push([file, ...args]);
    const key = [file, ...args].join(' ');
    // Prefer exact match, then a prefix key so `nix path-info …` and
    // `nix build …` share fixtures without listing every flag.
    const matched =
      responses[key] ??
      responses[
        Object.keys(responses).find((candidate) => key.startsWith(candidate)) ??
          ''
      ];
    if (matched === undefined) throw new Error(`no response for ${key}`);
    return { stdout: matched, stderr: '' };
  };
  return { calls, execute };
}

const closureJson = JSON.stringify({
  [`/nix/store/${OUT}-jq-1.7.1`]: {
    references: [`/nix/store/${OUT}-jq-1.7.1`, `/nix/store/${LIBC}-glibc-2.39`],
    narSize: 100,
  },
  [`/nix/store/${LIBC}-glibc-2.39`]: { references: [], narSize: 200 },
});

/** Responses for the build-then-path-info sequence. */
function withRealise(pathInfo: string) {
  return {
    'nix build': '',
    'nix path-info': pathInfo,
  };
}

describe('availability', () => {
  it('reports the nix it found', async () => {
    const { execute } = nix({ 'nix --version': 'nix (Nix) 2.24.9' });
    expect(await new NixStoreProvider(execute).available()).toMatchObject({
      available: true,
      tool: { name: 'nix', version: '2.24.9' },
    });
  });

  it('reports absence instead of throwing', async () => {
    const provider = new NixStoreProvider(async () => {
      throw new Error('ENOENT');
    });
    expect((await provider.available()).available).toBe(false);
  });
});

describe('installableFromPurl', () => {
  it('passes flake installables through and maps PURLs', () => {
    expect(installableFromPurl('nixpkgs#hello')).toBe('nixpkgs#hello');
    expect(installableFromPurl('pkg:nix/hello')).toBe('nixpkgs#hello');
    expect(installableFromPurl('pkg:nix/hello?flake=nixpkgs/nixos-24.05')).toBe(
      'nixpkgs/nixos-24.05#hello',
    );
    expect(installableFromPurl('pkg:nix/x?installable=nixpkgs%23hello')).toBe(
      'nixpkgs#hello',
    );
  });
});

describe('resolution is delegated to nix', () => {
  it('realises then reads the whole closure', async () => {
    // Realisation first so path-info never sees an unrealised flake ref.
    // --recursive is what makes this dependency resolution: nix has already
    // computed the graph, and the useful thing is to record it.
    const { calls, execute } = nix(withRealise(closureJson));
    const closure = await new NixStoreProvider(execute).closure('nixpkgs#jq');
    expect(calls[0]?.[0]).toBe('nix');
    expect(calls[0]).toContain('build');
    expect(calls[0]).toContain('--no-link');
    expect(calls[1]).toContain('path-info');
    expect(calls[1]).toContain('--recursive');
    expect(closure.map((entry) => entry.path)).toEqual([
      `/nix/store/${OUT}-jq-1.7.1`,
      `/nix/store/${LIBC}-glibc-2.39`,
    ]);
    expect(closure[0]?.references).toHaveLength(2);
  });

  it('accepts a PURL and realises the mapped installable', async () => {
    const { calls, execute } = nix(withRealise(closureJson));
    await new NixStoreProvider(execute).closure('pkg:nix/jq');
    expect(calls[0]).toContain('nixpkgs#jq');
  });

  it('turns the closure into PREX instances', async () => {
    const { execute } = nix(withRealise(closureJson));
    const { instances, semanticLoss } = await new NixStoreProvider(
      execute,
    ).resolve('nixpkgs#jq');
    expect(instances).toHaveLength(2);
    // Nix did the solving; the record must say so rather than implying
    // OpenPacker resolved the graph.
    expect(semanticLoss.map((loss) => loss.code)).toContain(
      'NIX_RESOLUTION_DELEGATED',
    );
    expect(semanticLoss.map((loss) => loss.code)).toContain(
      'NIX_EXPRESSION_NOT_EVALUATED',
    );
  });

  it('accepts the older array-shaped path-info output', async () => {
    const { execute } = nix(
      withRealise(
        JSON.stringify([
          { path: `/nix/store/${OUT}-jq-1.7.1`, references: [], narSize: 1 },
        ]),
      ),
    );
    expect(
      (await new NixStoreProvider(execute).closure('nixpkgs#jq')).length,
    ).toBe(1);
  });

  it('refuses to invent a version list', async () => {
    // A Nix package is an attribute in a flake and the flake ref is what pins
    // it. Returning versions would invent an ordering Nix does not have.
    await expect(
      new NixStoreProvider(nix({}).execute).enumerate(),
    ).rejects.toThrow(/flake/u);
  });
});

describe('argument safety', () => {
  it('refuses an installable that could reach the argument vector as an option', async () => {
    const provider = new NixStoreProvider(nix({}).execute);
    for (const bad of [
      '--version',
      '-x',
      'a b',
      'nixpkgs#jq; rm -rf /',
      '../etc',
    ])
      await expect(provider.plan(bad), bad).rejects.toThrow();
  });

  it('installs into a per-user profile, needing no elevation', async () => {
    const plan = await new NixStoreProvider(nix({}).execute).plan('nixpkgs#jq');
    expect(plan.requiresElevation).toBe(false);
    expect(plan.command.slice(0, 3)).toEqual(['nix', 'profile', 'install']);
  });

  it('plans from a PURL the same way', async () => {
    const plan = await new NixStoreProvider(nix({}).execute).plan(
      'pkg:nix/hello',
    );
    expect(plan.command).toContain('nixpkgs#hello');
    expect(plan.exactPurl).toBe('pkg:nix/hello');
  });
});

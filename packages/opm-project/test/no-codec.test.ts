import { afterAll, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { requireAdapterRegistry } from '../src/adapters.js';
import { resolveTransitive } from '../src/closure-lock.js';
import { hasCodec } from '../src/codecs.js';
import { ProviderPool } from '../src/registry.js';
import { isExactVersion } from '../src/registry-target.js';
import type { LockPackage, OpmManifest } from '../src/types.js';

/**
 * An adapter that exports no codec, as a delegated plugin's does not.
 *
 * Only a codec can tell a version from a range or a tag, order two releases, or
 * read what a release requires. Without one the host still locks the package
 * the adapter serves, as it always has, but it neither guesses at a range nor
 * walks a closure it cannot read.
 */

const manifest: OpmManifest = {
  project: { name: 'plugin-served', ecosystems: ['nocodec'] },
  packages: {},
  options: { offline: false, layout: 'opm' },
  policy: {
    allowYanked: false,
    allowQuarantined: false,
    semanticLossMaximum: 'warning',
    requiredEvidence: [],
  },
};

const direct: LockPackage = {
  alias: 'demo',
  purl: 'pkg:nocodec/demo@1.0.0',
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
  size: 1,
  format: 'tar',
  mediaType: 'application/x-tar',
  source: 'https://nocodec.fixture.test/artifacts/demo-1.0.0.tar',
  storeKey: 'a'.repeat(64),
  bins: [],
  reason: 'direct',
  ecosystem: 'nocodec',
  sourceKind: 'registry',
};

describe('an ecosystem whose adapter exports no codec', () => {
  afterAll(() => configureDefaultAdapters());

  requireAdapterRegistry().register({
    id: 'dev.test.no-codec',
    purlTypes: ['nocodec'],
    registryDefinition: () => ({
      registryDefinitionVersion: '1',
      registryId: 'https://nocodec.fixture.test',
      purlTypes: ['nocodec'],
      resources: [],
    }),
  });

  it('is told from one that has a codec', () => {
    expect(hasCodec('nocodec')).toBe(false);
    expect(hasCodec('npm')).toBe(true);
  });

  it('takes what a manifest wrote after @ for a version', () => {
    expect(isExactVersion('nocodec', '1.0.0')).toBe(true);
    expect(isExactVersion('npm', '1.0.0')).toBe(true);
    expect(isExactVersion('npm', '^1.0.0')).toBe(false);
    expect(isExactVersion('npm', 'next')).toBe(false);
  });

  it('adds nothing to its lock from a walk of its dependencies', async () => {
    const pool = new ProviderPool(() => {
      throw new Error(
        'no registry may be read for an ecosystem without a codec',
      );
    });
    await expect(
      resolveTransitive({ direct: [direct], manifest, pool }),
    ).resolves.toEqual({ packages: {}, dependencies: {}, aliases: {} });
  });
});

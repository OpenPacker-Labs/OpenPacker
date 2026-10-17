import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CatalogProvider, ProviderRecord } from '@openpacker/adapter-core';
import type { PackageInstance } from '@openpacker/contracts';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { requireAdapterRegistry } from '../src/adapters.js';
import { resolveTransitive } from '../src/closure-lock.js';
import { hasCodec } from '../src/codecs.js';
import { resolveManifestToLock } from '../src/project.js';
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
    // Nothing can tell a range or a tag from a version without a codec.
    expect(isExactVersion('nocodec', '^1.0.0')).toBe(true);
    expect(isExactVersion('nocodec', 'next')).toBe(true);
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

  const RECORD: ProviderRecord = {
    key: 'pkg:nocodec/demo',
    endpoint: 'https://nocodec.fixture.test',
    body: {},
    rawBody: new Uint8Array(),
    retrievedAt: '2020-01-01T00:00:00Z',
  };

  /**
   * What the plugin is asked for when `opm add` stores `demo@<hint>`. It
   * publishes 1.0.0, 1.5.0 and 3.0.0 and, unless told which release to answer
   * with, refuses every inspection, so the resolve stops at the first release
   * it is asked about.
   */
  async function asked(hint: string | undefined, answer?: string) {
    const calls: string[] = [];
    const provider: CatalogProvider = {
      providerId: 'dev.test.no-codec',
      capabilities: {
        operations: ['enumerate', 'inspect', 'artifact'],
        purlTypes: ['nocodec'],
        qualifierSupport: 'none',
        targetSpecificSemantics: false,
        offlineReplay: false,
        extensions: {},
      },
      async identify() {
        return [];
      },
      async enumerate(purl) {
        calls.push(`enumerate(${purl})`);
        return ['1.0.0', '1.5.0', '3.0.0'].map((v) => `${purl}@${v}`);
      },
      async inspect(purl) {
        calls.push(`inspect(${purl})`);
        if (answer === undefined)
          throw new Error(`the fixture plugin refuses ${purl}`);
        // SAFETY: the host reads only the identity before it checks it.
        const answered = { identity: { exactPurl: answer } } as PackageInstance;
        return { package: answered, record: RECORD, warnings: [] };
      },
      async fetchArtifactRecord() {
        throw new Error('not reached: every inspection fails');
      },
      async snapshot() {
        throw new Error('not reached: every inspection fails');
      },
    };
    const root = await mkdtemp(join(tmpdir(), 'opm-no-codec-'));
    try {
      const failure: unknown = await resolveManifestToLock({
        root,
        manifest: {
          ...manifest,
          packages: {
            demo: {
              alias: 'demo',
              purl: 'pkg:nocodec/demo',
              ...(hint !== undefined && { version: hint }),
            },
          },
        },
        offline: false,
        registryOptions: { provider },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      return { calls, failure: String(failure) };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it.each(['^1.0.0', '~1.0.0', '1.x', 'next', '1.0.0'])(
    'sends %s to the plugin as written, and lists no releases',
    async (hint) => {
      const { calls, failure } = await asked(hint);
      expect(calls).toEqual([`inspect(pkg:nocodec/demo@${hint})`]);
      expect(failure).toContain('the fixture plugin refuses');
    },
  );

  it('lists the releases and asks for the newest when nothing was written', async () => {
    expect((await asked(undefined)).calls).toEqual([
      'enumerate(pkg:nocodec/demo)',
      'inspect(pkg:nocodec/demo@3.0.0)',
    ]);
  });

  it('refuses a plugin that answers a range with a release', async () => {
    const { failure } = await asked('^1.0.0', 'pkg:nocodec/demo@1.5.0');
    expect(failure).toContain(
      'Provider identity pkg:nocodec/demo@1.5.0 does not match pkg:nocodec/demo@^1.0.0',
    );
  });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  parsePurl,
  type CatalogProvider,
  type ProviderRecord,
} from '@openpacker/adapter-core';
import type { PackageInstance } from '@openpacker/contracts';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { requireAdapterRegistry } from '../src/adapters.js';
import { resolveTransitive } from '../src/closure-lock.js';
import { hasCodec } from '../src/codecs.js';
import { readManifestFile, resolveManifestToLock } from '../src/project.js';
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
   * What the plugin is asked for when an `opm.toml` says `version = <hint>` for
   * `pkg:nocodec/demo`. It publishes 1.0.0, 1.5.0 and 3.0.0 and, unless
   * `answer` says which identity to answer the purl it was asked for with,
   * refuses every inspection, so the resolve stops at the first release it is
   * asked about. An answered inspection goes on to the artifact record, which
   * it refuses.
   */
  async function asked(
    hint: string | undefined,
    answer?: (purl: string) => string,
  ) {
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
        const answered = {
          identity: { exactPurl: answer(purl) },
        } as PackageInstance;
        return { package: answered, record: RECORD, warnings: [] };
      },
      async fetchArtifactRecord(purl) {
        calls.push(`fetchArtifactRecord(${purl})`);
        throw new Error(`the fixture plugin has no artifact for ${purl}`);
      },
      async snapshot() {
        throw new Error('not reached: no artifact record is fetched');
      },
    };
    const root = await mkdtemp(join(tmpdir(), 'opm-no-codec-'));
    try {
      const path = join(root, 'opm.toml');
      await writeFile(path, manifestText(hint));
      const written = await readManifestFile(path);
      const failure: unknown = await resolveManifestToLock({
        root,
        manifest: written,
        offline: false,
        registryOptions: { provider },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      return {
        calls,
        failure,
        message: String(failure),
        version: written.packages.demo?.version,
      };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  /** The operation a recorded call made, and the purl it named, read back. */
  const call = (text: string) => ({
    operation: text.slice(0, text.indexOf('(')),
    purl: parsePurl(text.slice(text.indexOf('(') + 1, -1)),
  });
  const demoAt = (version: string) => ({
    type: 'nocodec',
    name: 'demo',
    qualifiers: {},
    version,
  });

  it.each(['^1.0.0', '~1.0.0', '1.x', 'next', '1.0.0'])(
    'sends %s to the plugin as written, and lists no releases',
    async (hint) => {
      const { calls, message } = await asked(hint);
      expect(calls.map(call)).toEqual([
        { operation: 'inspect', purl: demoAt(hint) },
      ]);
      expect(message).toContain('the fixture plugin refuses');
    },
  );

  // A version line is text, not PURL syntax: an `@`, `/`, `?` or `#` in it
  // must not name another package, a qualifier or a subpath.
  it.each([
    '>=1.0.0 <2 || 3',
    '1.0.0?repository_url=https://evil.example/r',
    'https://evil.example/x.tgz',
    '1.0.0#lib',
    '1.0.0/../other@9',
    '^1@9',
    '1.0.0@2',
    '1.0.0/2',
    '?',
    '#',
    '1.0.0?a=b&c=d#x/y',
    '1.0.0%2F2',
  ])(
    'asks for demo at %j and nothing else, through to its artifact record',
    async (hint) => {
      const { calls, message, version } = await asked(hint, (purl) => purl);
      expect(version).toBe(hint);
      expect(calls.map(call)).toEqual([
        { operation: 'inspect', purl: demoAt(hint) },
        { operation: 'fetchArtifactRecord', purl: demoAt(hint) },
      ]);
      expect(message).toContain('the fixture plugin has no artifact');
    },
  );

  it('refuses the package a crafted version line used to name', async () => {
    // What `1.0.0/../other@9` concatenated after `@` read back as.
    const { calls, failure } = await asked(
      '1.0.0/../other@9',
      () => 'pkg:nocodec/demo%401.0.0/../other@9',
    );
    expect(calls.map((text) => call(text).operation)).toEqual(['inspect']);
    expect(failure).toMatchObject({ code: 'INVALID_PROVIDER_METADATA' });
  });

  it('refuses a version line no PURL can carry before asking the plugin', async () => {
    const { calls, failure } = await asked('1'.repeat(5000));
    expect(calls).toEqual([]);
    expect(failure).toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  it('lists the releases and asks for the newest when nothing was written', async () => {
    expect((await asked(undefined)).calls).toEqual([
      'enumerate(pkg:nocodec/demo)',
      'inspect(pkg:nocodec/demo@3.0.0)',
    ]);
  });

  it('refuses a plugin that answers a range with a release', async () => {
    const { message } = await asked('^1.0.0', () => 'pkg:nocodec/demo@1.5.0');
    expect(message).toContain(
      'Provider identity pkg:nocodec/demo@1.5.0 does not match pkg:nocodec/demo@',
    );
    expect(message).not.toContain('fixture plugin has no artifact');
  });
});

/** An `opm.toml` for `pkg:nocodec/demo`, with `version = <hint>` if given. */
function manifestText(hint: string | undefined): string {
  return [
    '[project]',
    'name = "plugin-served"',
    'ecosystems = ["nocodec"]',
    '',
    '[packages.demo]',
    'purl = "pkg:nocodec/demo"',
    ...(hint === undefined ? [] : [`version = ${JSON.stringify(hint)}`]),
    '',
    '[options]',
    'offline = false',
    'layout = "opm"',
    '',
  ].join('\n');
}

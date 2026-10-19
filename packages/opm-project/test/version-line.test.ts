import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  parsePurl,
  type CatalogProvider,
  type ProviderRecord,
} from '@openpacker/adapter-core';
import type { PackageInstance } from '@openpacker/contracts';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { requireAdapterRegistry } from '../src/adapters.js';
import { readManifestFile, resolveManifestToLock } from '../src/project.js';
import { purlAtVersion } from '../src/spec.js';

/**
 * A manifest's `version` line is text, not PURL syntax. Joined to the package
 * after `@`, an `@`, `/`, `?` or `#` in it read back as another namespace and
 * name, a qualifier or a subpath, so the line alone could re-target a package
 * the reviewed `purl` line still named. These follow such a line from the
 * manifest file into what is locked.
 */

const CRAFTED = '1.0.0/../other@9';

const roots: string[] = [];

async function project(lines: readonly string[], purl = 'pkg:nocodec/demo') {
  const root = await mkdtemp(join(tmpdir(), 'opm-version-line-'));
  roots.push(root);
  const path = join(root, 'opm.toml');
  await writeFile(
    path,
    [
      '[project]',
      'name = "version-line"',
      `ecosystems = ["${parsePurl(purl).type}"]`,
      '',
      '[packages.demo]',
      `purl = "${purl}"`,
      `version = ${JSON.stringify(CRAFTED)}`,
      ...lines,
      '',
    ].join('\n'),
  );
  return { root, manifest: await readManifestFile(path) };
}

describe('a version line with PURL syntax in it', () => {
  afterAll(() => configureDefaultAdapters());
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  requireAdapterRegistry().register({
    id: 'dev.test.version-line',
    purlTypes: ['nocodec'],
    registryDefinition: () => ({
      registryDefinitionVersion: '1',
      registryId: 'https://nocodec.fixture.test',
      purlTypes: ['nocodec'],
      resources: [],
    }),
  });

  it('locks a package from an explicit source under its own name', async () => {
    const { root, manifest } = await project(['source = "./demo.tar"']);
    await writeFile(join(root, 'demo.tar'), 'demo bytes');
    const lock = await resolveManifestToLock({ root, manifest, offline: true });
    expect(parsePurl(lock.packages.demo!.purl)).toEqual({
      type: 'nocodec',
      name: 'demo',
      qualifiers: {},
      version: CRAFTED,
    });
  });

  // Maven's codec reads any text without a space as a version, so the line
  // is the registry target as it stands.
  it('asks a registry whose codec reads it as a version for that package', async () => {
    const { root, manifest } = await project([], 'pkg:maven/org.example/demo');
    const asked: string[] = [];
    const provider: CatalogProvider = {
      providerId: 'dev.test.version-line',
      capabilities: {
        operations: ['enumerate', 'inspect', 'artifact'],
        purlTypes: ['maven'],
        qualifierSupport: 'none',
        targetSpecificSemantics: false,
        offlineReplay: false,
        extensions: {},
      },
      async identify() {
        return [];
      },
      async enumerate() {
        throw new Error('not reached: the line names one version');
      },
      async inspect(purl) {
        asked.push(purl);
        // SAFETY: the host reads only the identity before it checks it.
        const answered = { identity: { exactPurl: purl } } as PackageInstance;
        return { package: answered, record: RECORD, warnings: [] };
      },
      async fetchArtifactRecord(purl) {
        asked.push(purl);
        throw new Error(`the fixture registry has no artifact for ${purl}`);
      },
      async snapshot() {
        throw new Error('not reached: no artifact record is fetched');
      },
    };
    await expect(
      resolveManifestToLock({
        root,
        manifest,
        offline: false,
        registryOptions: { provider },
      }),
    ).rejects.toThrow('the fixture registry has no artifact');
    expect(asked.map((purl) => parsePurl(purl))).toEqual(
      Array.from({ length: 2 }, () => ({
        type: 'maven',
        namespace: 'org.example',
        name: 'demo',
        qualifiers: {},
        version: CRAFTED,
      })),
    );
  });
});

const RECORD: ProviderRecord = {
  key: 'pkg:maven/org.example/demo',
  endpoint: 'https://maven.fixture.test',
  body: {},
  rawBody: new Uint8Array(),
  retrievedAt: '2020-01-01T00:00:00Z',
};

describe('purlAtVersion', () => {
  it('encodes the version as one PURL component', () => {
    expect(purlAtVersion('pkg:nocodec/demo', '^1.0.0')).toBe(
      'pkg:nocodec/demo@%5E1.0.0',
    );
    expect(purlAtVersion('pkg:nocodec/demo', CRAFTED)).toBe(
      'pkg:nocodec/demo@1.0.0%2F..%2Fother%409',
    );
  });

  it("keeps the package's own namespace and qualifiers, and replaces its version", () => {
    const purl = 'pkg:nocodec/ns/demo@0.1.0?repository_url=https://r.test#lib';
    expect(parsePurl(purlAtVersion(purl, '1.0.0?x=y#z'))).toEqual({
      type: 'nocodec',
      namespace: 'ns',
      name: 'demo',
      qualifiers: { repository_url: 'https://r.test' },
      version: '1.0.0?x=y#z',
    });
  });

  it('refuses a version that does not read back as itself', () => {
    for (const version of ['\uD800', '1'.repeat(5000), ''])
      expect(() => purlAtVersion('pkg:nocodec/demo', version)).toThrow(
        expect.objectContaining({ code: 'INVALID_MANIFEST' }),
      );
  });
});

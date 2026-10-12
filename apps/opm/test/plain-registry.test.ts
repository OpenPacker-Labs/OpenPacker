import { describe, expect, it } from 'vitest';
import {
  packageNodeId,
  type CatalogProvider,
  type PackageInstance,
  type ProviderInspection,
  type ProviderRecord,
} from '@openpacker/adapter-core';
import type { AdapterModule } from '@openpacker/opm-project';
import { HOSTILE, lines, runWith, violations } from './plain-fixture.js';
import type { Ran } from './repo-fixture.js';

/**
 * What a registry says cannot shape what `opm search`, `versions`, `info` and
 * `resolve` write: each value is made one line where it is printed, so that no
 * line looks like opm's own after any kind of line break, none holds a character
 * a terminal acts on, and the output has the lines it has for innocent text. A
 * registry here is an adapter that answers with `text` in the value under test
 * (what a plugin-served registry can do, since it is a program the project
 * binds), driven through `runOpm`.
 */
const ENDPOINT = 'https://acme.registry.test';
const DIGEST = 'a'.repeat(64);

async function instance(
  exactPurl: string,
  version: string,
  canonicalPurl = exactPurl.split('@')[0]!,
): Promise<PackageInstance> {
  // SAFETY: only the fields the commands read are filled.
  return {
    nodeId: await packageNodeId({
      exactPurl,
      nativeSemanticsVersion: 'acme-1',
    }),
    identity: {
      canonicalPurl,
      purlType: 'acme',
      name: 'demo',
      version: exactPurl.slice(exactPurl.indexOf('@') + 1),
      qualifiers: {},
      nativeCoordinates: [],
      aliases: [],
      sourceRefs: [],
      publisherRefs: [],
      externalRefs: [],
      exactPurl,
    },
    nativeVersion: version,
    normalizedVersion: version,
    versionSortKey: version,
    requirements: [],
    capabilities: [],
    conflicts: [],
    cardinalityConstraints: [],
    artifacts: [],
    lifecycle: { status: 'published', eligible: true, warnings: [] },
    sourceSnapshots: [],
    metadataDigest: { algorithm: 'sha256', value: DIGEST },
    nativeSemantics: { version: 'acme-1', data: {} },
    semanticLoss: [],
  } as PackageInstance;
}

/** Where `text` goes: the value under test. */
type Where =
  | 'canonical'
  | 'purl'
  | 'inspected'
  | 'version'
  | 'digest'
  | 'mediaType'
  | 'source';

async function provider(where: Where, text: string): Promise<CatalogProvider> {
  const exact =
    where === 'purl' ? `pkg:acme/demo@1.0.0${text}` : 'pkg:acme/demo@1.0.0';
  const version =
    where === 'version' || where === 'purl' ? `1.0.0${text}` : '1.0.0';
  const body = {
    digest: {
      algorithm: 'sha256',
      value: where === 'digest' ? `${DIGEST}${text}` : DIGEST,
    },
    size: 5,
    mediaType:
      where === 'mediaType' ? `application/x-tar${text}` : 'application/x-tar',
    locations: [
      {
        uri:
          where === 'source'
            ? `${ENDPOINT}/a/${text}.tar`
            : `${ENDPOINT}/a.tar`,
      },
    ],
  };
  const record: ProviderRecord = {
    key: exact,
    endpoint: ENDPOINT,
    body,
    rawBody: new TextEncoder().encode(JSON.stringify(body)),
    retrievedAt: '2020-01-01T00:00:00Z',
  };
  const inspection: ProviderInspection = {
    package: await instance(
      where === 'inspected' ? `${exact}?q=${text}` : exact,
      version,
    ),
    record: { ...record, body: { time: {} } },
    warnings: [],
  };
  return {
    providerId: 'dev.test.hostile',
    capabilities: {
      operations: ['identify', 'enumerate', 'inspect', 'artifact'],
      purlTypes: ['acme'],
      qualifierSupport: 'none',
      targetSpecificSemantics: false,
      offlineReplay: false,
      extensions: {},
    },
    async identify() {
      return [
        (
          await instance(
            exact,
            version,
            where === 'canonical' ? `pkg:acme/demo${text}` : 'pkg:acme/demo',
          )
        ).identity,
      ];
    },
    async enumerate() {
      return [exact];
    },
    async inspect() {
      return inspection;
    },
    async fetchArtifactRecord() {
      return record;
    },
    async snapshot() {
      throw new Error('not in the fixture');
    },
  };
}

function adapter(candidate: CatalogProvider): AdapterModule {
  return {
    id: 'dev.test.hostile',
    purlTypes: ['acme'],
    registryDefinition: () => ({
      registryDefinitionVersion: '1',
      registryId: ENDPOINT,
      purlTypes: ['acme'],
      resources: [
        { '@id': '#metadata', '@type': 'prex.registry.package-metadata/1' },
        { '@id': '#enumerate', '@type': 'prex.registry.enumerate-versions/1' },
        { '@id': '#search', '@type': 'prex.registry.search/1' },
        { '@id': '#artifact', '@type': 'prex.registry.artifact/1' },
      ],
    }),
    catalog: () => candidate,
  };
}

async function against(
  where: Where,
  text: string,
  argv: string[],
): Promise<Ran> {
  return runWith({}, argv, {
    adapters: [adapter(await provider(where, text))],
  });
}

/**
 * The same text where a PURL must still parse as the one asked for: the
 * characters that end a name or a version are left out, the rest stay.
 */
const IN_A_PURL = HOSTILE.replace(/[@/?#]/gu, '');

async function expectPlain(
  go: (text: string) => Promise<Ran>,
  hostileText = HOSTILE,
): Promise<void> {
  const innocent = await go('x');
  const hostile = await go(hostileText);
  expect(hostile.code, hostile.err).toBe(innocent.code);
  for (const stream of ['out', 'err'] as const) {
    expect(violations(hostile[stream])).toEqual([]);
    expect(lines(hostile[stream])).toBe(lines(innocent[stream]));
  }
}

describe('a registry that words what it answers', () => {
  it('is one line in the matches of opm search', async () => {
    const argv = ['search', 'pkg:acme/demo'];
    const ran = await against('canonical', 'x', argv);
    expect(ran.out).toBe('pkg:acme/demox\n');
    await expectPlain((text) => against('canonical', text, argv));
  });

  it('is one line in the versions of opm versions', async () => {
    const argv = ['versions', 'pkg:acme/demo'];
    const ran = await against('purl', 'x', argv);
    expect(ran.out).toBe('pkg:acme/demo@1.0.0x\n');
    await expectPlain((text) => against('purl', text, argv), IN_A_PURL);
  });

  it.each([
    ['inspected', 'pkg:acme/demo@1.0.0?q=x\n', IN_A_PURL],
    ['version', 'version   1.0.0x', HOSTILE],
    ['digest', `digest    sha256:${DIGEST}x`, HOSTILE],
    ['mediaType', 'mediaType application/x-tarx', HOSTILE],
    ['source', 'source    https://acme.registry.test/a/x.tar', HOSTILE],
  ] as const)(
    'is one line in the %s of opm info',
    async (where, shown, hostileText) => {
      const argv = ['info', 'pkg:acme/demo@1.0.0'];
      const ran = await against(where, 'x', argv);
      expect(ran.out, ran.err).toContain(shown);
      await expectPlain((text) => against(where, text, argv), hostileText);
    },
  );

  it('names a package opm resolve selects only by a canonical PURL', async () => {
    // The resolver refuses an identity whose exactPurl is not canonical, which
    // is every one with a raw control or separator in it, so what the solve
    // lists is already ASCII: the line needs no flattening, and a registry that
    // tries is told no, in one line of opm's own words.
    const argv = ['resolve', 'pkg:acme/demo'];
    const ran = await against('purl', '', argv);
    expect(ran.code, ran.err).toBe(0);
    expect(ran.out).toBe(
      '1 package(s), proof checked\n  pkg:acme/demo@1.0.0\n',
    );
    const refused = await against('purl', IN_A_PURL, argv);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toBe('');
    expect(violations(refused.err)).toEqual([]);
    expect(lines(refused.err)).toBe(1);
  });
});

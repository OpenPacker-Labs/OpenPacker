import { describe, expect, it } from 'vitest';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import { parseNpmAlias } from './alias.js';
import {
  NpmCodec,
  NpmRegistryProvider,
  type NpmVersionMetadata,
} from './index.js';

const provenance = {
  providerId: 'fixture',
  endpoint: 'https://fixtures.test',
  retrievedAt: '2026-08-02T00:00:00Z',
  evaluationTime: '2026-08-02T00:00:00Z',
  metadataDigest: { algorithm: 'sha256' as const, value: '1'.repeat(64) },
};

/** The install name the adapter recorded on an alias requirement. */
function installNameOf(requirement: {
  nativeSemantics?: { data?: unknown } | undefined;
}): string {
  // SAFETY: the data this adapter wrote.
  const data = requirement.nativeSemantics?.data as
    | { installName: string }
    | undefined;
  return data?.installName ?? '';
}

const translate = (metadata: Record<string, unknown>) =>
  new NpmCodec().translateMetadata(
    // SAFETY: a literal that carries the fields under test.
    { name: 'demo', version: '1.0.0', ...metadata } as NpmVersionMetadata,
    provenance,
  );

describe('reading an npm: alias', () => {
  it.each([
    ['npm:string-width@^4.2.0', 'string-width', '^4.2.0', 'range'],
    ['npm:@scope/name@^2', '@scope/name', '^2', 'range'],
    ['npm:string-width', 'string-width', '*', 'range'],
    ['npm:@scope/name', '@scope/name', '*', 'range'],
    ['npm:string-width@', 'string-width', '*', 'range'],
    ['npm:react-is@18.3.1', 'react-is', '18.3.1', 'range'],
    [
      'npm:@openai/codex@0.130.0-linux-x64',
      '@openai/codex',
      '0.130.0-linux-x64',
      'range',
    ],
    ['npm:foo@>=1 <2', 'foo', '>=1 <2', 'range'],
    ['npm:foo@next', 'foo', 'next', 'tag'],
    ['npm:@scope/foo@latest', '@scope/foo', 'latest', 'tag'],
  ] as const)('reads %j', (value, target, spec, kind) => {
    expect(parseNpmAlias(value)).toEqual({ target, spec, kind });
  });

  it.each([
    ['npm:', 'must name a package'],
    ['npm:@1.0.0', 'not a registry package name'],
    ['npm:npm:foo', 'alias of an alias'],
    ['npm:foo@npm:bar', 'alias of an alias'],
    ['npm:github:user/repo', 'not a registry package name'],
    ['npm:foo@github:user/repo', 'git specifier'],
    ['npm:foo@https://example.test/foo.tgz', 'url specifier'],
    ['npm:foo@file:../foo', 'file specifier'],
    ['npm:foo bar@1', 'not a registry package name'],
  ])('says why %j is not an alias npm would install', (value, problem) => {
    expect(parseNpmAlias(value)).toEqual({
      problem: expect.stringContaining(problem),
    });
  });
});

describe('an alias in a dependency entry', () => {
  it('names the target package and keeps the install name', async () => {
    const { instance } = await translate({
      dependencies: { 'string-width-cjs': 'npm:string-width@^4.2.0' },
    });
    const [requirement] = instance.requirements;
    expect(requirement).toMatchObject({
      id: expect.stringContaining(':runtime:string-width-cjs'),
      kind: 'runtime',
      optional: false,
      expression: {
        type: 'package',
        purl: 'pkg:npm/string-width',
        vers: 'vers:npm/>=4.2.0|<5.0.0',
      },
      nativeSemantics: {
        data: {
          dependencyField: 'dependencies',
          range: '^4.2.0',
          installName: 'string-width-cjs',
          aliasSpec: 'npm:string-width@^4.2.0',
        },
      },
    });
    expect(requirement?.nativeSemantics?.data).not.toHaveProperty('specKind');
  });

  it('reads a scoped target, an unversioned one and an exact one', async () => {
    const { instance } = await translate({
      dependencies: {
        a: 'npm:@scope/pkg@^2',
        b: 'npm:string-width',
        c: 'npm:react-is@18.3.1',
      },
    });
    const byName = Object.fromEntries(
      instance.requirements.map((requirement) => [
        installNameOf(requirement),
        requirement.expression,
      ]),
    );
    expect(byName.a).toMatchObject({ purl: 'pkg:npm/%40scope/pkg' });
    expect(byName.b).toEqual({ type: 'package', purl: 'pkg:npm/string-width' });
    expect(byName.c).toMatchObject({
      purl: 'pkg:npm/react-is',
      vers: expect.stringContaining('18.3.1'),
    });
  });

  it('marks a dist-tag, which the registry has to resolve', async () => {
    const { instance } = await translate({
      dependencies: { beta: 'npm:foo@next' },
    });
    expect(instance.requirements[0]).toMatchObject({
      expression: { purl: 'pkg:npm/foo' },
      nativeSemantics: {
        data: { range: 'next', specKind: 'tag', installName: 'beta' },
      },
    });
    expect(instance.requirements[0]?.expression).not.toHaveProperty('vers');
  });

  it('is followed in optionalDependencies, where the platform builds of a native package live', async () => {
    const { instance } = await translate({
      optionalDependencies: {
        '@openai/codex-linux-x64': 'npm:@openai/codex@0.130.0-linux-x64',
        '@openai/codex-darwin-arm64': 'npm:@openai/codex@0.130.0-darwin-arm64',
      },
    });
    expect(instance.requirements).toHaveLength(2);
    for (const requirement of instance.requirements) {
      expect(requirement).toMatchObject({
        kind: 'optional',
        optional: true,
        expression: { purl: 'pkg:npm/%40openai/codex' },
        nativeSemantics: { data: { dependencyField: 'optionalDependencies' } },
      });
      expect(requirement.nativeSemantics?.data).not.toHaveProperty('specKind');
    }
  });

  it('stays a note in a field an install does not walk', async () => {
    const { instance } = await translate({
      devDependencies: { 'react-is': 'npm:react-is@18.3.1' },
    });
    expect(instance.requirements[0]).toMatchObject({
      kind: 'development',
      optional: true,
      nativeSemantics: { data: { specKind: 'alias' } },
    });
    expect(instance.requirements[0]?.expression).not.toHaveProperty('vers');
  });

  it.each([
    ['npm:npm:foo', 'alias of an alias'],
    ['npm:foo@github:user/foo', 'git specifier'],
    ['npm:', 'must name a package'],
  ])(
    'refuses %j in dependencies, by name and with the reason',
    async (value, why) => {
      await expect(
        translate({ dependencies: { bar: value } }),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_DEPENDENCY_SPEC',
        message: expect.stringMatching(
          new RegExp(`demo@1\\.0\\.0 depends on bar as .*${why}`, 'u'),
        ),
      });
    },
  );

  it.each([['../escape'], ['node_modules'], ['.bin'], ['a/b/c']])(
    'refuses an alias key that cannot be a directory (%j)',
    async (key) => {
      await expect(
        translate({ dependencies: { [key]: 'npm:string-width@^4' } }),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_DEPENDENCY_SPEC',
        message: expect.stringMatching(
          /not (?:an npm package name|a safe directory name)/u,
        ),
      });
    },
  );

  it('keeps an alias it cannot read in optionalDependencies as a note, not a failure', async () => {
    const { instance } = await translate({
      optionalDependencies: { bar: 'npm:foo@github:user/foo' },
    });
    expect(instance.requirements[0]).toMatchObject({
      optional: true,
      nativeSemantics: { data: { specKind: 'alias' } },
    });
  });
});

describe('a dist-tag, resolved by the registry', () => {
  const packument = {
    name: 'foo',
    'dist-tags': { latest: '2.0.0', next: '3.0.0-rc.1', ghost: '9.9.9' },
    versions: { '1.0.0': {}, '2.0.0': {}, '3.0.0-rc.1': {} },
  };
  const provider = () =>
    new NpmRegistryProvider(
      new FixtureHttpTransport(
        new Map([
          [
            'https://fixtures.test/foo',
            [
              {
                status: 200,
                headers: {},
                body: new TextEncoder().encode(JSON.stringify(packument)),
              },
            ],
          ],
        ]),
      ),
      { now: () => '2026-08-02T00:00:00Z' },
      'https://fixtures.test',
    );

  it('names the exact version the tag points at', async () => {
    const npm = provider();
    expect(await npm.resolveTag('pkg:npm/foo', 'next')).toBe(
      'pkg:npm/foo@3.0.0-rc.1',
    );
    expect(await npm.resolveTag('pkg:npm/foo', 'latest')).toBe(
      'pkg:npm/foo@2.0.0',
    );
  });

  it('says nothing for a tag the package does not have, or one that names an unlisted version', async () => {
    const npm = provider();
    expect(await npm.resolveTag('pkg:npm/foo', 'beta')).toBeUndefined();
    expect(await npm.resolveTag('pkg:npm/foo', 'ghost')).toBeUndefined();
  });
});

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import type { PolicyInput } from '@openpacker/contracts';
import {
  installProject,
  parseManifest,
  parsePackageSpec,
  projectNativeFormats,
  projectPaths,
  serializeLockfile,
  serializeManifest,
  writeManifestFile,
} from '../src/index.js';
import { installAndLayout, lockOf, permissive } from './closure-support.js';
import { OLD, type FixturePackage } from './npm-registry-fixture.js';

configureDefaultAdapters();

/**
 * `opm add string-width-cjs@npm:string-width@^4.2.0`: a project asks for a
 * package under a name of its own (ADR 0054).
 */

describe('the spec of an npm alias', () => {
  it.each([
    [
      'string-width-cjs@npm:string-width@^4.2.0',
      {
        alias: 'string-width-cjs',
        installName: 'string-width-cjs',
        purl: 'pkg:npm/string-width',
        version: '^4.2.0',
        ecosystem: 'npm',
      },
    ],
    [
      '@scope/old@npm:@scope/new@next',
      {
        alias: 'old',
        installName: '@scope/old',
        purl: 'pkg:npm/%40scope/new',
        version: 'next',
        ecosystem: 'npm',
      },
    ],
    [
      'x@npm:y',
      { alias: 'x', installName: 'x', purl: 'pkg:npm/y', ecosystem: 'npm' },
    ],
    [
      'x@npm:y@1.2.3',
      {
        alias: 'x',
        installName: 'x',
        purl: 'pkg:npm/y',
        version: '1.2.3',
        ecosystem: 'npm',
      },
    ],
  ])('reads %j', (spec, expected) => {
    expect(parsePackageSpec(spec)).toEqual(expected);
    expect(parsePackageSpec(spec, { ecosystem: 'npm' })).toEqual(expected);
  });

  it('takes the project label from --alias and the install name from the spec', () => {
    expect(
      parsePackageSpec('x@npm:y@1', { ecosystem: 'npm', alias: 'label' }),
    ).toMatchObject({ alias: 'label', installName: 'x' });
  });

  it.each([
    ['x@npm:npm:y', /does not name a registry package/u],
    ['x@npm:', /does not name a registry package|not a package name/u],
    ['x@npm:github:u/r', /not a package name/u],
  ])('refuses %j', (spec, message) => {
    expect(() => parsePackageSpec(spec, { ecosystem: 'npm' })).toThrow(message);
  });

  it('is npm only', () => {
    expect(() => parsePackageSpec('x@npm:y', { ecosystem: 'pypi' })).toThrow(
      /npm: alias/u,
    );
  });

  it('leaves a plain name and version alone', () => {
    expect(parsePackageSpec('foo@1.2.3', { ecosystem: 'npm' })).toEqual({
      alias: 'foo',
      purl: 'pkg:npm/foo',
      version: '1.2.3',
      ecosystem: 'npm',
    });
  });
});

describe('install_name in opm.toml', () => {
  const manifest = () =>
    parseManifest(
      [
        '[project]',
        'name = "demo"',
        'ecosystems = ["npm"]',
        '',
        '[packages.string-width-cjs]',
        'purl = "pkg:npm/string-width"',
        'version = "^4.2.0"',
        'install_name = "string-width-cjs"',
        '',
      ].join('\n'),
    );

  it('round-trips, and changes the digest of the manifest a lock is bound to', () => {
    const parsed = manifest();
    expect(parsed.packages['string-width-cjs']).toEqual({
      alias: 'string-width-cjs',
      purl: 'pkg:npm/string-width',
      version: '^4.2.0',
      installName: 'string-width-cjs',
    });
    const text = serializeManifest(parsed);
    expect(text).toContain('install_name = "string-width-cjs"');
    expect(serializeManifest(parseManifest(text))).toBe(text);
    const without = parseManifest(text.replace(/install_name = .*\n/u, ''));
    expect(serializeManifest(without)).not.toBe(text);
  });

  it.each(['../x', 'a b', '', 'node_modules', '.hidden', 'a/b/c'])(
    'refuses %j as a name to install under',
    (name) => {
      expect(
        () =>
          parseManifest(
            [
              '[project]',
              'name = "demo"',
              'ecosystems = ["npm"]',
              '',
              '[packages.x]',
              'purl = "pkg:npm/y"',
              `install_name = ${JSON.stringify(name)}`,
              '',
            ].join('\n'),
          ),
        // The message of the parser that reads the key, not the "unknown
        // field" a parser that does not know it would give.
      ).toThrow(/install_name must be a package name/u);
    },
  );
});

describe('a direct requirement installed under another name', () => {
  const registry = (): FixturePackage[] => [
    {
      name: 'string-width',
      versions: { '4.2.3': { files: {} }, '5.1.2': { files: {} } },
    },
  ];
  const requirement = (version: string) => ({
    'string-width-cjs': {
      alias: 'string-width-cjs',
      purl: 'pkg:npm/string-width',
      version,
      installName: 'string-width-cjs',
    },
  });

  it('locks the newest release in its range, and installs it under the name', async () => {
    const { lock, root, manifest } = await lockOf(
      registry(),
      requirement('^4.2.0'),
    );
    expect(lock.packages['string-width-cjs']).toMatchObject({
      purl: 'pkg:npm/string-width@4.2.3',
      installName: 'string-width-cjs',
      reason: 'direct',
    });
    await installAndLayout({ root, manifest, lock });
    expect(
      JSON.parse(
        await readFile(
          join(root, 'node_modules', 'string-width-cjs', 'package.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({ name: 'string-width', version: '4.2.3' });
    await expect(
      readFile(join(root, 'node_modules', 'string-width', 'package.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes package.json the way npm would', async () => {
    const { lock, root, manifest } = await lockOf(
      registry(),
      requirement('^4.2.0'),
    );
    await writeFile(join(root, 'package.json'), '{\n  "name": "demo"\n}\n');
    await projectNativeFormats({ root, manifest, lock, level: 'manifest' });
    expect(
      JSON.parse(await readFile(join(root, 'package.json'), 'utf8')),
    ).toMatchObject({
      dependencies: { 'string-width-cjs': 'npm:string-width@^4.2.0' },
    });
    // And takes it out again by the name it was written under.
    delete manifest.packages['string-width-cjs'];
    await projectNativeFormats({ root, manifest, lock, level: 'manifest' });
    expect(
      JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
        .dependencies,
    ).toBeUndefined();
  });

  it('is refused offline when the lock says another name than the manifest', async () => {
    const { lock, root, manifest } = await lockOf(
      registry(),
      requirement('^4.2.0'),
    );
    const paths = projectPaths(root);
    await writeManifestFile(paths.manifest, manifest);
    const tampered = JSON.parse(serializeLockfile(lock)) as {
      packages: Record<string, Record<string, unknown>>;
    };
    delete tampered.packages['string-width-cjs']!.installName;
    await writeFile(paths.lock, `${JSON.stringify(tampered, null, 2)}\n`);
    await expect(installProject({ root, offline: true })).rejects.toMatchObject(
      {
        code: 'INVALID_LOCK',
        message: expect.stringContaining(
          'is installed as its own name, and the manifest says string-width-cjs',
        ),
      },
    );
  });
});

describe('a range or a dist-tag in the manifest', () => {
  const hoursAgo = (hours: number) =>
    new Date(Date.now() - hours * 3_600_000).toISOString();
  const window: PolicyInput = { ...permissive, minimumReleaseAgeMinutes: 1440 };
  const direct = (version: string | undefined) => ({
    x: {
      alias: 'x',
      purl: 'pkg:npm/target',
      ...(!(version === undefined) && { version }),
    },
  });
  const target = (extra: Partial<FixturePackage> = {}): FixturePackage[] => [
    {
      name: 'target',
      versions: { '1.0.0': {}, '1.5.0': {}, '2.0.0': {} },
      ...extra,
    },
  ];
  const picked = async (
    version: string | undefined,
    extra: Partial<FixturePackage> = {},
    policy: PolicyInput = permissive,
  ) =>
    (await lockOf(target(extra), direct(version), policy)).lock.packages.x
      ?.purl;

  it('takes the newest release in a range, not the newest release there is', async () => {
    expect(await picked('^1')).toBe('pkg:npm/target@1.5.0');
    expect(await picked('>=1.0.0 <2.0.0')).toBe('pkg:npm/target@1.5.0');
    expect(await picked('~1.0.0')).toBe('pkg:npm/target@1.0.0');
  });

  it('takes exactly a version', async () => {
    expect(await picked('1.0.0')).toBe('pkg:npm/target@1.0.0');
  });

  it('takes the newest when nothing is asked, as it always did', async () => {
    expect(await picked(undefined)).toBe('pkg:npm/target@2.0.0');
  });

  it('takes the release a dist-tag points at', async () => {
    expect(
      await picked('next', {
        versions: { '1.0.0': {}, '2.0.0': {}, '3.0.0-rc.1': {} },
        distTags: { next: '3.0.0-rc.1' },
      }),
    ).toBe('pkg:npm/target@3.0.0-rc.1');
  });

  it('passes over a release inside the minimum age for the previous one in the range', async () => {
    const times = {
      time: {
        '1.0.0': OLD,
        '1.5.0': hoursAgo(3),
        '2.0.0': OLD,
        '3.0.0-rc.1': OLD,
      },
      modified: hoursAgo(3),
    };
    expect(await picked('^1', times, window)).toBe('pkg:npm/target@1.0.0');
  });

  it('says what it looked for when nothing satisfies, and when the tag is not one', async () => {
    await expect(picked('^9')).rejects.toMatchObject({
      code: 'UNRESOLVABLE',
      message: expect.stringMatching(
        /No published version of pkg:npm\/target satisfies \^9 \(newest is /u,
      ),
    });
    await expect(picked('nope')).rejects.toMatchObject({
      code: 'UNRESOLVABLE',
      message: expect.stringContaining('has no version or dist-tag "nope"'),
    });
  });
});

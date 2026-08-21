import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  addPackage,
  buildPackageManifest,
  importNativeProject,
  initProject,
  nativeName,
  packDelegatedProject,
  projectNativeFormats,
  projectionLevel,
  removePackage,
  parseManifest,
  readManifestFile,
  serializeManifest,
  syncProject,
  sourceForEcosystem,
  withPackedArtifact,
  type OpmManifest,
} from '../src/index.js';

configureDefaultAdapters();

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureCatalog = join(repoRoot, 'fixtures/opm/catalog.json');
const fixtureTgz = join(repoRoot, 'fixtures/opm/demo-tool-1.1.0.tgz');

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempProject(files: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'opm-native-'));
  temps.push(dir);
  await initProject({ root: dir, name: 'test-app' });
  await mkdir(join(dir, '.opm'), { recursive: true });
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const catalog = JSON.parse(await readFile(fixtureCatalog, 'utf8')) as {
    packages: Record<string, { source: string } & Record<string, unknown>>;
  };
  delete catalog.packages['pkg:npm/@openpacker/demo-tool@1.1.0'];
  for (const entry of Object.values(catalog.packages))
    entry.source = `file:${fixtureTgz}`;
  await writeFile(
    join(dir, '.opm/catalog.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
  for (const [name, contents] of Object.entries(files))
    await writeFile(join(dir, name), contents);
  return dir;
}

describe('opm import --native', () => {
  it('writes opm.toml from native requirements and does not re-read them on sync', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-import-native-'));
    temps.push(dir);
    await writeFile(
      join(dir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'native-app',
          version: '0.0.0',
          dependencies: { 'left-pad': '1.3.0' },
          devDependencies: { mocha: '^10.0.0' },
        },
        undefined,
        2,
      )}\n`,
    );

    const result = await importNativeProject({ root: dir });
    expect(result.imported.map((item) => item.alias).sort()).toEqual([
      'left-pad',
      'mocha',
    ]);
    expect(
      result.imported.some(
        (item) => item.purl === 'pkg:npm/left-pad' && item.range === '1.3.0',
      ),
    ).toBe(true);

    const manifest = await readManifestFile(join(dir, 'opm.toml'));
    expect(manifest.packages['left-pad']?.purl).toBe('pkg:npm/left-pad');
    expect(manifest.packages['left-pad']?.version).toBe('1.3.0');
    expect(manifest.packages.mocha?.scope).toBe('development');

    manifest.packages = {};
    await writeFile(join(dir, 'opm.toml'), serializeManifest(manifest));

    await syncProject({ root: dir, offline: true });
    const after = await readManifestFile(join(dir, 'opm.toml'));
    expect(after.packages['left-pad']).toBeUndefined();
    expect(after.packages.mocha).toBeUndefined();
  });

  it('refuses to overwrite an existing opm.toml without --force', async () => {
    const root = await tempProject();
    await expect(importNativeProject({ root })).rejects.toMatchObject({
      code: 'INVALID_MANIFEST',
    });
  });
});

describe('native projection through opm commands', () => {
  it('puts an added package into package.json, not only opm.toml', async () => {
    const root = await tempProject({
      'package.json': '{\n  "name": "test-app",\n  "version": "0.0.0"\n}\n',
    });
    const result = await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });

    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const packageJson = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; name?: string };
    expect(packageJson.dependencies).toEqual({
      '@openpacker/demo-tool': '1.1.0',
    });
    // The rest of the file is the caller's, not ours.
    expect(packageJson.name).toBe('test-app');

    expect(result.native?.projections).toHaveLength(1);
    expect(result.native?.projections[0]?.ecosystem).toBe('npm');
    expect(result.native?.projections[0]?.written).toEqual([
      join(root, 'package.json'),
    ]);
  });

  it('takes a removed package back out of package.json', async () => {
    const root = await tempProject({
      'package.json': '{\n  "name": "test-app"\n}\n',
    });
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    await removePackage({ root, alias: 'demo-tool', offline: true });

    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const packageJson = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    // A leftover entry here would let `npm install` put back what opm removed.
    expect(packageJson.dependencies).toBeUndefined();
  });

  it('never deletes a dependency a person added by hand', async () => {
    const root = await tempProject({
      'package.json':
        '{\n  "name": "test-app",\n  "dependencies": {\n    "hand-written": "^1.0.0"\n  }\n}\n',
    });
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    await removePackage({ root, alias: 'demo-tool', offline: true });

    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const packageJson = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    // opm removes what opm wrote. Treating opm.toml as an allowlist would
    // silently delete this.
    expect(packageJson.dependencies).toEqual({ 'hand-written': '^1.0.0' });
  });

  it('does nothing when the project has no native manifest', async () => {
    const root = await tempProject();
    const result = await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    expect(result.native?.projections).toEqual([]);
    expect(result.native?.unprojected.map((entry) => entry.ecosystem)).toEqual([
      'npm',
    ]);
    expect(result.native?.unprojected[0]?.reason).toMatch(
      /no npm project file/,
    );
  });

  it('writes nothing when native_projection is off', async () => {
    const root = await tempProject({
      'package.json': '{\n  "name": "test-app"\n}\n',
    });
    const manifestPath = join(root, 'opm.toml');
    const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
    manifest.options.nativeProjection = 'off';
    await writeFile(manifestPath, serializeManifest(manifest));

    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(
      '{\n  "name": "test-app"\n}\n',
    );
  });

  it('keeps the declared range rather than narrowing it to the locked version', async () => {
    const root = await tempProject({
      'package.json': '{\n  "name": "test-app"\n}\n',
    });
    // `^1.0.0` is what the project asked for; rewriting it as `1.1.0` would
    // pin the native manifest to something the user never wrote.
    const manifest: OpmManifest = {
      project: { name: 'test-app', ecosystems: ['npm'] },
      packages: {
        'demo-tool': {
          alias: 'demo-tool',
          purl: 'pkg:npm/demo-tool',
          version: '^1.0.0',
        },
      },
      options: { offline: true, layout: 'opm' },
    };
    await projectNativeFormats({
      root,
      manifest,
      lock: {
        schemaVersion: 1,
        generatedBy: 'opm',
        packages: {
          'demo-tool': {
            alias: 'demo-tool',
            purl: 'pkg:npm/@openpacker/demo-tool@1.1.0',
            version: '1.1.0',
            digest: `sha256:${'0'.repeat(64)}`,
            size: 1,
            format: 'tar+gzip',
            mediaType: 'application/octet-stream',
            source: 'file:///demo',
            storeKey: `sha256-${'0'.repeat(64)}`,
            bins: [],
            reason: 'direct',
            ecosystem: 'npm',
          },
        },
      },
    });
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const packageJson = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(packageJson.dependencies).toEqual({ 'demo-tool': '^1.0.0' });
  });

  it('does not write a transitive dependency as a top-level declaration', async () => {
    const root = await tempProject({
      'package.json': '{\n  "name": "test-app"\n}\n',
    });
    const manifest: OpmManifest = {
      project: { name: 'test-app', ecosystems: ['npm'] },
      packages: {
        'demo-tool': { alias: 'demo-tool', purl: 'pkg:npm/demo-tool' },
      },
      options: { offline: true, layout: 'opm' },
    };
    const entry = (
      alias: string,
      purl: string,
      reason: 'direct' | 'transitive',
    ) => ({
      alias,
      purl,
      version: '1.0.0',
      digest: `sha256:${'0'.repeat(64)}`,
      size: 1,
      format: 'tar+gzip' as const,
      mediaType: 'application/octet-stream',
      source: 'file:///demo',
      storeKey: `sha256-${'0'.repeat(64)}`,
      bins: [],
      reason,
      ecosystem: 'npm',
    });
    await projectNativeFormats({
      root,
      manifest,
      lock: {
        schemaVersion: 1,
        generatedBy: 'opm',
        packages: {
          'demo-tool': entry('demo-tool', 'pkg:npm/demo-tool@1.0.0', 'direct'),
          'ansi-styles': entry(
            'ansi-styles',
            'pkg:npm/ansi-styles@1.0.0',
            'transitive',
          ),
        },
      },
    });
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const packageJson = JSON.parse(
      await readFile(join(root, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    // A manifest declares what the project asks for. The closure belongs in a
    // lockfile, not here.
    expect(Object.keys(packageJson.dependencies ?? {})).toEqual(['demo-tool']);
  });
});

describe('native lockfile projection', () => {
  it('writes package-lock.json with the integrity captured at resolve time', async () => {
    const root = await tempProject({
      'package.json': '{\n  "name": "test-app"\n}\n',
    });
    const manifestPath = join(root, 'opm.toml');
    const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
    manifest.options.nativeProjection = 'lock';
    await writeFile(manifestPath, serializeManifest(manifest));

    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });

    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const lock = JSON.parse(
      await readFile(join(root, 'package-lock.json'), 'utf8'),
    ) as {
      lockfileVersion: number;
      packages: Record<string, { integrity?: string; version?: string }>;
    };
    expect(lock.lockfileVersion).toBe(3);
    const entry = lock.packages['node_modules/@openpacker/demo-tool'];
    expect(entry?.version).toBe('1.1.0');
    // SRI over the same bytes opm hashed to sha256 — captured at resolve time
    // because materialize extracts the archive and does not keep it.
    expect(entry?.integrity).toMatch(/^sha512-/u);
  });

  it('leaves the native lockfile alone at the manifest level', async () => {
    const root = await tempProject({
      'package.json': '{\n  "name": "test-app"\n}\n',
    });
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    await expect(
      readFile(join(root, 'package-lock.json'), 'utf8'),
    ).rejects.toThrow();
  });
});

describe('native layout projection', () => {
  it('materialises node_modules from the store, unwrapping the tarball prefix', async () => {
    const root = await tempProject({
      'package.json': '{\n  "name": "test-app"\n}\n',
    });
    const manifestPath = join(root, 'opm.toml');
    const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
    manifest.options.nativeProjection = 'layout';
    await writeFile(manifestPath, serializeManifest(manifest));

    const result = await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });

    // npm tarballs wrap everything in package/; node_modules wants what is
    // inside it, or nothing can resolve the package's main.
    const installed = join(
      root,
      'node_modules',
      '@openpacker',
      'demo-tool',
      'package.json',
    );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const manifestOfInstalled = JSON.parse(
      await readFile(installed, 'utf8'),
    ) as { name?: string };
    expect(manifestOfInstalled.name).toBe('@openpacker/demo-tool');

    // The layout is equivalent to what npm produces, not produced by npm, and
    // it says so rather than letting a project assume install scripts ran.
    const loss = result.native?.projections[0]?.semanticLoss ?? [];
    expect(loss.map((entry) => entry.code)).toContain(
      'NATIVE_LAYOUT_NOT_TOOL_EQUIVALENT',
    );
  });

  it('replaces the layout rather than accumulating a previous resolution', async () => {
    const root = await tempProject({
      'package.json': '{\n  "name": "test-app"\n}\n',
    });
    const manifestPath = join(root, 'opm.toml');
    const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
    manifest.options.nativeProjection = 'layout';
    await writeFile(manifestPath, serializeManifest(manifest));
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });

    const stray = join(
      root,
      'node_modules',
      '@openpacker',
      'demo-tool',
      'stale.txt',
    );
    await writeFile(stray, 'left over from a previous resolution');
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    await expect(readFile(stray, 'utf8')).rejects.toThrow();
  });
});

describe('projection helpers', () => {
  it('defaults to writing the manifest', () => {
    expect(
      projectionLevel({
        project: { name: 'x', ecosystems: [] },
        packages: {},
        options: { offline: false, layout: 'opm' },
      }),
    ).toBe('manifest');
  });

  it('recovers a native name from a PURL, including npm scopes', () => {
    expect(nativeName('pkg:npm/%40scope/name')).toBe('@scope/name');
    expect(nativeName('pkg:nuget/Newtonsoft.Json')).toBe('Newtonsoft.Json');
    expect(nativeName('pkg:npm/chalk?arch=any')).toBe('chalk');
  });
});

describe('package manifest', () => {
  it('does not fall back to a built-in delegated packer', async () => {
    const root = await tempProject({
      'package.json': '{"name":"test-app","version":"1.0.0"}\n',
    });
    await expect(
      packDelegatedProject({
        root,
        ecosystem: 'npm',
        name: 'test-app',
        version: '1.0.0',
        dryRun: true,
        offline: true,
      }),
    ).rejects.toThrow(/No delegated pack provider/u);
  });

  it('describes the package and every ecosystem it ships to', async () => {
    const root = await tempProject({
      'package.json': '{\n  "name": "test-app"\n}\n',
    });
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const lock = JSON.parse(
      await readFile(join(root, 'opm.lock.json'), 'utf8'),
    ) as Parameters<typeof buildPackageManifest>[0]['lock'];

    const built = await buildPackageManifest({
      root,
      manifest: parseManifest(await readFile(join(root, 'opm.toml'), 'utf8')),
      lock,
      name: 'test-app',
      version: '1.2.3',
      producedAt: '2026-08-10T00:00:00.000Z',
      producer: { id: 'org.openpacker.opm', version: '0.1.0' },
    });

    expect(built.manifest.packageManifestVersion).toBe('1');
    expect(built.manifest.version).toBe('1.2.3');

    const npm = built.manifest.distributions.find(
      (entry) => entry.purlType === 'npm',
    );
    expect(npm?.exactPurl).toBe('pkg:npm/test-app@1.2.3');
    // The runtime hint is how server.json says "you can npx this".
    expect(npm?.runtimeHint).toBe('npx');
    // A registryId, not just a URL: a policy can pin who answered.
    expect(npm?.registryId).toBe('urn:openpacker:registry:npmjs-org');
    expect(npm?.requirements).toContainEqual({
      identifier: '@openpacker/demo-tool',
      purl: 'pkg:npm/@openpacker/demo-tool',
      range: '1.1.0',
      scope: 'runtime',
    });

    // External registry providers are described, with the definition they were
    // built against pinned by digest.
    const registry = built.manifest.registries?.[0];
    expect(registry?.registryId).toBe('urn:openpacker:registry:npmjs-org');
    expect(registry?.definitionDigest?.value).toMatch(/^[0-9a-f]{64}$/u);
  }, 30_000);

  it('claims nothing verified until something is actually checked', async () => {
    const root = await tempProject({
      'package.json': '{\n  "name": "test-app"\n}\n',
    });
    const built = await buildPackageManifest({
      root,
      manifest: parseManifest(await readFile(join(root, 'opm.toml'), 'utf8')),
      lock: {
        schemaVersion: 1,
        generatedBy: 'opm',
        packages: {
          demo: {
            alias: 'demo',
            purl: 'pkg:npm/demo@1.0.0',
            version: '1.0.0',
            digest: `sha256:${'0'.repeat(64)}`,
            size: 1,
            format: 'tar+gzip',
            mediaType: 'application/octet-stream',
            source: 'file:///demo',
            storeKey: `sha256-${'0'.repeat(64)}`,
            bins: [],
            reason: 'direct',
            ecosystem: 'npm',
          },
        },
      },
      producedAt: '2026-08-10T00:00:00.000Z',
      producer: { id: 'org.openpacker.opm', version: '0.1.0' },
    });
    // Writing a document does not verify anything, and saying otherwise is the
    // failure a provenance block exists to prevent.
    expect(built.manifest.provenance?.verified).toEqual([]);

    const withArtifact = withPackedArtifact(built.manifest, 'npm', {
      digest: `sha256:${'a'.repeat(64)}`,
      size: 42,
      mediaType: 'application/vnd.npm.install-v1+json',
    });
    // The bytes were hashed to produce that, so that much is now claimable.
    expect(withArtifact.provenance?.verified).toEqual(['artifact-digest']);
    expect(
      withArtifact.distributions.find((entry) => entry.purlType === 'npm')
        ?.digest?.value,
    ).toBe('a'.repeat(64));
  }, 30_000);

  it('canonicalises, so the same inputs give the same digest', async () => {
    const root = await tempProject({
      'package.json': '{\n  "name": "test-app"\n}\n',
    });
    const build = async () =>
      buildPackageManifest({
        root,
        manifest: parseManifest(await readFile(join(root, 'opm.toml'), 'utf8')),
        lock: {
          schemaVersion: 1,
          generatedBy: 'opm',
          packages: {
            demo: {
              alias: 'demo',
              purl: 'pkg:npm/demo@1.0.0',
              version: '1.0.0',
              digest: `sha256:${'0'.repeat(64)}`,
              size: 1,
              format: 'tar+gzip',
              mediaType: 'application/octet-stream',
              source: 'file:///demo',
              storeKey: `sha256-${'0'.repeat(64)}`,
              bins: [],
              reason: 'direct',
              ecosystem: 'npm',
            },
          },
        },
        producedAt: '2026-08-10T00:00:00.000Z',
        producer: { id: 'org.openpacker.opm', version: '0.1.0' },
      });
    const first = await build();
    const second = await build();
    // A manifest is an artifact: publishable, pinnable, and verifiable later
    // as the same document.
    expect(second.digest).toEqual(first.digest);
    expect(second.bytes).toEqual(first.bytes);
  });
});

describe('named registry sources in opm.toml', () => {
  const manifestText = (body: string) => `
[project]
name = "app"
ecosystems = ["npm"]

${body}
[options]
offline = false
layout = "opm"
`;

  it('round-trips a named registry through parse and serialize', () => {
    const parsed = parseManifest(
      manifestText(
        '[registries.mirror]\nurl = "https://reg.corp.example/"\ndefault_for = ["npm", "pypi"]\n',
      ),
    );
    expect(parsed.registries?.mirror).toEqual({
      id: 'mirror',
      url: 'https://reg.corp.example/',
      defaultFor: ['npm', 'pypi'],
    });
    expect(parseManifest(serializeManifest(parsed)).registries).toEqual(
      parsed.registries,
    );
  });

  it('refuses a registry with no url, and an unknown field', () => {
    expect(() =>
      parseManifest(
        manifestText('[registries.mirror]\ndefault_for = ["npm"]\n'),
      ),
    ).toThrow(/missing required url/);
    expect(() =>
      parseManifest(
        manifestText(
          '[registries.mirror]\nurl = "https://x/"\nmirror = true\n',
        ),
      ),
    ).toThrow(/Unknown registry field "mirror"/);
  });

  it('picks the project pin, and an explicit request beats it', () => {
    const manifest = parseManifest(
      manifestText(
        '[registries.mirror]\nurl = "https://reg.corp.example/"\ndefault_for = ["npm"]\n',
      ),
    );
    expect(sourceForEcosystem('npm', manifest)).toBe('mirror');
    expect(sourceForEcosystem('npm', manifest, 'other')).toBe('other');
    // Nothing claims cargo, so the ecosystem default answers.
    expect(sourceForEcosystem('cargo', manifest)).toBeUndefined();
    expect(sourceForEcosystem('npm', undefined)).toBeUndefined();
  });

  it('refuses to guess when two sources claim the same ecosystem', () => {
    const manifest = parseManifest(
      manifestText(
        '[registries.one]\nurl = "https://one/"\ndefault_for = ["npm"]\n\n[registries.two]\nurl = "https://two/"\ndefault_for = ["npm"]\n',
      ),
    );
    // Picking one silently is how a build starts reading from a registry
    // nobody chose.
    expect(() => sourceForEcosystem('npm', manifest)).toThrow(
      /More than one registry claims "npm"/,
    );
  });
});

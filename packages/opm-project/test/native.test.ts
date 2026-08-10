import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  addPackage,
  initProject,
  nativeName,
  projectNativeFormats,
  projectionLevel,
  removePackage,
  parseManifest,
  serializeManifest,
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
  const catalog = JSON.parse(await readFile(fixtureCatalog, 'utf8')) as {
    packages: Record<string, { source: string } & Record<string, unknown>>;
  };
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

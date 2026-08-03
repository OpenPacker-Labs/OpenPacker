import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addPackage,
  initProject,
  installProject,
  listInstalled,
  parseManifest,
  parsePackageSpec,
  removePackage,
  serializeManifest,
  syncProject,
  uninstallProject,
  whyPackage,
} from '../src/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureCatalog = join(repoRoot, 'fixtures/opm/catalog.json');
const fixtureTgz = join(repoRoot, 'fixtures/opm/demo-tool-1.1.0.tgz');

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opm-proj-'));
  temps.push(dir);
  await initProject({ root: dir, name: 'test-app' });
  // point local catalog
  await mkdir(join(dir, '.opm'), { recursive: true });
  const catalog = JSON.parse(await readFile(fixtureCatalog, 'utf8')) as {
    schemaVersion: number;
    packages: Record<string, { source: string } & Record<string, unknown>>;
  };
  for (const entry of Object.values(catalog.packages)) {
    entry.source = `file:${fixtureTgz}`;
  }
  await writeFile(
    join(dir, '.opm/catalog.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
  return dir;
}

describe('manifest TOML', () => {
  it('round-trips', () => {
    const text = serializeManifest({
      project: { name: 'demo', ecosystems: ['npm', 'cargo'] },
      packages: {
        'demo-tool': {
          alias: 'demo-tool',
          purl: 'pkg:npm/@openpacker/demo-tool',
          version: '1.1.0',
          source: 'file:./vendor/demo.tgz',
        },
      },
      options: { offline: true, layout: 'opm' },
    });
    const parsed = parseManifest(text);
    expect(parsed.project.name).toBe('demo');
    expect(parsed.packages['demo-tool']?.version).toBe('1.1.0');
    expect(parsed.options.offline).toBe(true);
  });
});

describe('parsePackageSpec', () => {
  it('parses purl', () => {
    const spec = parsePackageSpec('pkg:npm/@openpacker/demo-tool@1.1.0');
    expect(spec.ecosystem).toBe('npm');
    expect(spec.version).toBe('1.1.0');
    expect(spec.alias).toBe('demo-tool');
  });

  it('requires ecosystem for bare names', () => {
    expect(() => parsePackageSpec('lodash')).toThrow(/ecosystem/);
  });
});

describe('project lifecycle offline', () => {
  it('init add install list remove uninstall sync', async () => {
    const root = await tempProject();

    const added = await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    expect(added.alias).toBe('demo-tool');
    expect(added.lock.packages['demo-tool']?.digest.startsWith('sha256:')).toBe(
      true,
    );

    const listed = await listInstalled(root);
    expect(listed.some((p) => p.alias === 'demo-tool' && p.installed)).toBe(
      true,
    );

    const why = await whyPackage(root, 'demo-tool');
    expect(why).toMatch(/direct dependency/);

    // install is idempotent
    await installProject({ root, offline: true });
    await syncProject({ root, offline: true });

    await removePackage({ root, alias: 'demo-tool', offline: true });
    const afterRemove = await listInstalled(root);
    expect(afterRemove.find((p) => p.alias === 'demo-tool')).toBeUndefined();

    // re-add via manifest source for second path
    await addPackage({
      root,
      spec: 'demo-tool@1.1.0',
      ecosystem: 'npm',
      source: fixtureTgz,
      offline: true,
    });
    await uninstallProject({ root, alias: 'demo-tool' });
    const state = await listInstalled(root);
    // still in lock/manifest but not installed
    const row = state.find((p) => p.alias === 'demo-tool');
    expect(row?.installed).toBe(false);
  });
});

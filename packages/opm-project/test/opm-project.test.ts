import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  addPackage,
  collectGarbage,
  environmentVariables,
  listGenerations,
  readEnvironmentState,
  rollbackTarget,
  switchGeneration,
  assertSafeSegment,
  assertStoreKey,
  fetchArtifactBytes,
  initProject,
  installProject,
  listInstalled,
  materializeLockPackage,
  parseManifest,
  parsePackageSpec,
  removePackage,
  serializeManifest,
  storeKeyFromDigest,
  syncProject,
  uninstallProject,
  writeBinShims,
  whyPackage,
  OpmError,
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

describe('path containment', () => {
  it('rejects unsafe aliases and store keys', () => {
    expect(() => assertSafeSegment('../evil', 'package alias')).toThrow(
      /Invalid package alias/,
    );
    expect(() => assertSafeSegment('a/b', 'bin name')).toThrow(/Invalid bin/);
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(storeKeyFromDigest(digest)).toBe(`sha256-${'a'.repeat(64)}`);
    expect(() => assertStoreKey('../escape', digest)).toThrow(/storeKey/);
    expect(() => assertStoreKey(`sha256-${'b'.repeat(64)}`, digest)).toThrow(
      /does not match/,
    );
  });

  it('rejects bin names that escape bin dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-bin-'));
    temps.push(dir);
    await expect(
      writeBinShims({
        binDir: join(dir, 'bin'),
        storeRoot: join(dir, 'store'),
        bins: [{ name: '../evil', path: 'package/bin/x.js' }],
      }),
    ).rejects.toBeInstanceOf(OpmError);
  });
});

describe('fail-closed install paths', () => {
  it('refuses network fetches while offline', async () => {
    await expect(
      fetchArtifactBytes('https://registry.example.invalid/pkg.tgz', true),
    ).rejects.toMatchObject({ code: 'OFFLINE' });
  });

  it('rejects a tampered artifact with DIGEST_MISMATCH before extraction', async () => {
    const root = await tempProject();
    const wrongDigest = `sha256:${'b'.repeat(64)}`;
    await expect(
      materializeLockPackage({
        root,
        pkg: {
          alias: 'demo-tool',
          purl: 'pkg:npm/@openpacker/demo-tool@1.1.0',
          version: '1.1.0',
          digest: wrongDigest,
          size: 406,
          format: 'tar+gzip',
          mediaType: 'application/vnd.openpacker.package.tgz',
          source: `file:${fixtureTgz}`,
          storeKey: storeKeyFromDigest(wrongDigest),
          bins: [],
          reason: 'direct',
          ecosystem: 'npm',
        },
        offline: true,
      }),
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
  });

  it('rejects a size mismatch even when the digest matches', async () => {
    const root = await tempProject();
    const bytes = await readFile(fixtureTgz);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    await expect(
      materializeLockPackage({
        root,
        pkg: {
          alias: 'demo-tool',
          purl: 'pkg:npm/@openpacker/demo-tool@1.1.0',
          version: '1.1.0',
          digest,
          size: bytes.byteLength + 1,
          format: 'tar+gzip',
          mediaType: 'application/vnd.openpacker.package.tgz',
          source: `file:${fixtureTgz}`,
          storeKey: storeKeyFromDigest(digest),
          bins: [],
          reason: 'direct',
          ecosystem: 'npm',
        },
        offline: true,
      }),
    ).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
  });

  it('rejects adding from a catalog entry whose digest does not match the bytes', async () => {
    const root = await tempProject();
    const catalogPath = join(root, '.opm/catalog.json');
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
      packages: Record<string, { digest?: string }>;
    };
    for (const entry of Object.values(catalog.packages)) {
      entry.digest = `sha256:${'c'.repeat(64)}`;
    }
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    await expect(
      addPackage({
        root,
        spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
        offline: true,
      }),
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
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

describe('environment generations', () => {
  it('appends an immutable, hash-linked generation per install', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });

    const first = await listGenerations(root);
    expect(first).toHaveLength(1);
    expect(first[0]?.sequence).toBe(1);
    expect(first[0]?.parentGenerationDigest).toBeUndefined();
    expect(first[0]?.members).toHaveLength(1);

    const state = await readEnvironmentState(root);
    expect(state?.currentGenerationDigest).toBe(first[0]?.generationDigest);
    expect(state?.retainedGenerationDigests).toContain(
      first[0]?.generationDigest,
    );

    // Removing a package is a new generation, not an edit of the old one.
    await removePackage({ root, alias: 'demo-tool', offline: true });
    const second = await listGenerations(root);
    expect(second).toHaveLength(2);
    expect(second[1]?.sequence).toBe(2);
    expect(second[1]?.parentGenerationDigest).toBe(first[0]?.generationDigest);
    // The first record is byte-identical to what it was.
    expect(second[0]).toEqual(first[0]);
  });

  it('does not record a generation when nothing changed', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    await installProject({ root, offline: true });
    await installProject({ root, offline: true });
    // An install that changes nothing would otherwise grow the ledger forever.
    expect(await listGenerations(root)).toHaveLength(1);
  });

  it('rolls back by repointing state, never by rewriting a record', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    await removePackage({ root, alias: 'demo-tool', offline: true });

    const target = await rollbackTarget(root);
    expect(target?.sequence).toBe(1);
    const before = await listGenerations(root);

    await switchGeneration({ root, target: 1 });
    const state = await readEnvironmentState(root);
    expect(state?.currentGenerationDigest).toBe(target?.generationDigest);
    // Both records survive, so the rollback is itself reversible.
    expect(await listGenerations(root)).toEqual(before);

    await switchGeneration({ root, target: 2 });
    expect((await readEnvironmentState(root))?.currentGenerationDigest).toBe(
      before[1]?.generationDigest,
    );
  });

  it('refuses to switch to an unknown generation', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    await expect(switchGeneration({ root, target: 99 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('collects only store paths outside every retained generation', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    const installed = await listGenerations(root);
    const storePath = installed[0]?.members[0]?.storePath;
    expect(storePath).toBeDefined();

    // Keeping every generation keeps the content reachable.
    const dry = await collectGarbage({ root, dryRun: true });
    expect(dry.removed).not.toContain(storePath);

    await removePackage({ root, alias: 'demo-tool', offline: true });
    // The package is gone from the current generation, but generation 1 still
    // names it, so it must stay collectible-free while retained.
    expect(
      (await collectGarbage({ root, dryRun: true })).removed,
    ).not.toContain(storePath);

    // Keeping only the newest generation makes the old content unreachable.
    const collected = await collectGarbage({ root, keep: 1 });
    expect(collected.removed).toContain(storePath);
    expect(collected.retained).toHaveLength(1);
    // A retained set that no longer includes a generation drops its record.
    expect(await listGenerations(root)).toHaveLength(1);
  });

  it('never collects the current generation', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    const result = await collectGarbage({ root, keep: 1 });
    expect(result.retained.map((item) => item.sequence)).toContain(1);
    expect(result.removed).toEqual([]);
  });

  it('derives shell environment from the current generation', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    const environment = await environmentVariables({ root });
    expect(environment.OPM_GENERATION).toBe('1');
    expect(environment.OPM_ENVIRONMENT).toBe('default');
    expect(environment.PATH?.startsWith(environment.OPM_BIN!)).toBe(true);
  });
});

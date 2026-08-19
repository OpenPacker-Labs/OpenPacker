import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  addPackage,
  activateGeneration,
  collectGarbage,
  mergeStoreReferences,
  readStoreReferences,
  environmentScript,
  environmentVariables,
  generationDigest,
  shellQuote,
  listGenerations,
  readEnvironmentState,
  readProjectState,
  readLockfile,
  readManifestFile,
  recordGeneration,
  rollbackTarget,
  switchGeneration,
  assertSafeSegment,
  assertStoreKey,
  fetchArtifactBytes,
  initProject,
  installFromLock,
  installProject,
  listInstalled,
  lockPackageFromSource,
  loadCatalogFile,
  materializeLockPackage,
  parseManifest,
  parseLockfile,
  parsePackageSpec,
  removePackage,
  serializeManifest,
  storeKeyFromDigest,
  syncProject,
  uninstallProject,
  writeBinShims,
  writeLockfile,
  writeManifestFile,
  discoverBins,
  defaultSupplyChainPolicyInput,
  captureFactsFromSourceUri,
  whyPackage,
  OpmError,
} from '../src/index.js';
import { packTarGzip } from '@openpacker/project-io';
import {
  openStableDirectory,
  projectPaths,
  readStableFile,
  revalidateStableDirectory,
  supportsStableProjectMetadata,
  writeStableFile,
} from '../src/paths.js';
import {
  bindManifestSourceAuthority,
  bindVerifiedArtifactBytes,
  sealVerifiedArtifactBinding,
} from '../src/install.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureCatalog = join(repoRoot, 'fixtures/opm/catalog.json');
const fixtureTgz = join(repoRoot, 'fixtures/opm/demo-tool-1.1.0.tgz');

const temps: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
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
  delete catalog.packages['pkg:npm/@openpacker/demo-tool@1.1.0'];
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
  it('writes allow_lifecycle_scripts = false on a new project', async () => {
    const root = await tempProject();
    const text = await readFile(join(root, 'opm.toml'), 'utf8');
    expect(text).toMatch(/allow_lifecycle_scripts = false/);
    expect(text).toMatch(/block_exotic_transitive = true/);
    expect(text).toMatch(/minimum_release_age_minutes = 1440/);
    expect(text).toMatch(/trust_policy = "no-downgrade"/);
    const policy = parseManifest(text).policy;
    expect(policy?.allowLifecycleScripts).toBe(false);
    expect(policy?.blockExoticSources?.transitive).toBe(true);
    expect(policy?.minimumReleaseAgeMinutes).toBe(1440);
    expect(policy?.trustPolicy).toBe('no-downgrade');
  });

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

  it('round-trips delegated pack provider configuration without secrets', () => {
    const text = serializeManifest({
      project: { name: 'demo', ecosystems: ['acme'] },
      packages: {},
      packProviders: {
        'example-acme': {
          manifest: '.opm/providers/acme.json',
          executable: '/opt/acme/bin/acme-pack',
          defaultFor: ['acme'],
          allowEnvironment: ['ACME_TOKEN'],
        },
      },
      options: { offline: true, layout: 'opm' },
    });

    expect(text).not.toContain('secret');
    expect(parseManifest(text).packProviders).toEqual({
      'example-acme': {
        manifest: '.opm/providers/acme.json',
        executable: '/opt/acme/bin/acme-pack',
        defaultFor: ['acme'],
        allowEnvironment: ['ACME_TOKEN'],
      },
    });
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

describe('catalog identity', () => {
  it('rejects key/body, version, and canonical duplicate substitutions', async () => {
    const root = await tempProject();
    const path = join(root, 'adversarial-catalog.json');
    const entry = {
      purl: 'pkg:npm/victim@1.0.0',
      version: '1.0.0',
      digest: `sha256:${'a'.repeat(64)}`,
      size: 1,
      format: 'tar',
      mediaType: 'application/octet-stream',
      source: 'file:artifact.tar',
    };

    for (const packages of [
      { 'pkg:npm/approved@1.0.0': entry },
      {
        'pkg:npm/victim@1.0.0': { ...entry, version: '2.0.0' },
      },
      {
        'pkg:npm/%76ictim@1.0.0': entry,
        'pkg:npm/victim@1.0.0': entry,
      },
    ]) {
      await writeFile(path, JSON.stringify({ schemaVersion: 1, packages }));
      await expect(loadCatalogFile(path)).rejects.toMatchObject({
        code: 'INVALID_CATALOG',
      });
    }
  });

  it('does not select an exact catalog PURL outside the manifest range', async () => {
    const root = await tempProject();
    await expect(
      addPackage({
        root,
        spec: 'pkg:npm/@openpacker/demo-tool@^2.0.0',
        offline: true,
      }),
    ).rejects.toMatchObject({ code: 'UNRESOLVABLE' });
  });
});

describe('path containment', () => {
  it('withdraws project metadata mutation where stable handles are unavailable', () => {
    expect(supportsStableProjectMetadata('linux')).toBe(true);
    expect(supportsStableProjectMetadata('darwin')).toBe(true);
    expect(supportsStableProjectMetadata('win32')).toBe(false);
  });

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

  it('accepts a "./" bin path but still refuses ".."', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-bin-'));
    temps.push(dir);
    const storeRoot = join(dir, 'store');
    await mkdir(join(storeRoot, 'package/lib'), { recursive: true });
    await writeFile(
      join(storeRoot, 'package/lib/json.js'),
      '#!/usr/bin/env node\n',
    );

    // "./lib/json.js" is how npm packages ordinarily declare a bin; refusing
    // it made real packages uninstallable.
    const written = await writeBinShims({
      binDir: join(dir, 'bin'),
      storeRoot,
      bins: [{ name: 'json', path: 'package/./lib/json.js' }],
    });
    expect(written).toHaveLength(1);

    await expect(
      writeBinShims({
        binDir: join(dir, 'bin'),
        storeRoot,
        bins: [{ name: 'escape', path: 'package/../../etc/passwd' }],
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_BIN' });
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

  it('guarantees shim mode 0o755 regardless of umask', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-shim-mode-'));
    temps.push(dir);
    const storeRoot = join(dir, 'store');
    await mkdir(join(storeRoot, 'package', 'lib'), { recursive: true });
    await writeFile(join(storeRoot, 'package', 'lib', 'tool.js'), '#!x\n');
    // vitest runs each file in its own fork, and tests within a file are
    // sequential, so tightening the process umask here cannot race.
    const previous = process.umask(0o077);
    try {
      await writeBinShims({
        binDir: join(dir, 'bin'),
        storeRoot,
        bins: [{ name: 'tool', path: 'package/lib/tool.js' }],
      });
    } finally {
      process.umask(previous);
    }
    const info = await lstat(join(dir, 'bin', 'tool'));
    expect(info.mode & 0o777).toBe(0o755);
  });

  it('writes a Python launcher that puts every store root on PYTHONPATH', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-py-shim-'));
    temps.push(dir);
    const storeRoot = join(dir, 'store-a');
    const depRoot = join(dir, 'store-b');
    await mkdir(storeRoot, { recursive: true });
    await mkdir(depRoot, { recursive: true });
    // Path is the dist-info entry_points file; the shim only needs a real path.
    await writeFile(join(storeRoot, 'entry_points.txt'), '');
    const [written] = await writeBinShims({
      binDir: join(dir, 'bin'),
      storeRoot,
      pythonPath: [depRoot],
      bins: [
        {
          name: 'tool',
          path: 'entry_points.txt',
          interpreter: 'python',
          entry: 'pkg.mod:main',
        },
      ],
    });
    expect(written?.interpreter).toBe('python');
    const body = await readFile(written!.shim, 'utf8');
    // Shims re-enter via opmx by default (sandbox); ambient only with hatch.
    expect(body).toContain('opmx');
    expect(body).not.toMatch(/process\.env\.OPM_OPMX\?\.trim\(\) \|\| 'opmx'/);
    expect(body).toContain('OPENPACKER_ALLOW_AMBIENT_SHIMS');
    expect(body).toContain('from pkg.mod import main');
    expect(body).toContain(storeRoot);
    expect(body).toContain(depRoot);
  });

  it('writes a .NET launcher that re-enters via opmx', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-dn-shim-'));
    temps.push(dir);
    const storeRoot = join(dir, 'store');
    const toolDir = join(storeRoot, 'tools/net8.0/any');
    await mkdir(toolDir, { recursive: true });
    await writeFile(join(toolDir, 'tool.dll'), '');
    const [written] = await writeBinShims({
      binDir: join(dir, 'bin'),
      storeRoot,
      bins: [
        {
          name: 'tool',
          path: 'tools/net8.0/any/tool.dll',
          interpreter: 'dotnet',
        },
      ],
    });
    expect(written?.interpreter).toBe('dotnet');
    const body = await readFile(written!.shim, 'utf8');
    expect(body).toContain('opmx');
    expect(body).toContain('tool.dll');
    expect(body).toContain('OPENPACKER_ALLOW_AMBIENT_SHIMS');
  });
});

describe('fail-closed install paths', () => {
  it('bounds metadata allocation when a file grows during read', async () => {
    const root = await tempProject();
    const path = join(root, '.opm/growing.json');
    await writeFile(path, new Uint8Array(64 * 1024));
    const probe = await open(path);
    const prototype = Object.getPrototypeOf(probe) as {
      read: (...args: unknown[]) => Promise<unknown>;
    };
    await probe.close();
    const original = prototype.read;
    const read = vi
      .spyOn(prototype, 'read')
      .mockImplementationOnce(async function (
        this: unknown,
        ...args: unknown[]
      ) {
        await appendFile(path, new Uint8Array(2 * 1024 * 1024));
        return await Reflect.apply(original, this, args);
      });
    try {
      await expect(readStableFile(path, 1024 * 1024)).rejects.toMatchObject({
        code: 'INPUT_CHANGED',
      });
      expect(read.mock.calls[0]?.[2]).toBe(64 * 1024);
    } finally {
      read.mockRestore();
    }
  });

  it('refuses a linked project state without reading outside the project', async () => {
    const root = await tempProject();
    const outside = join(root, 'outside-state.json');
    const statePath = join(root, '.opm/project.json');
    await writeFile(outside, 'outside');
    await rm(statePath);
    await symlink(outside, statePath);

    await expect(readProjectState(statePath)).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
    expect(await readFile(outside, 'utf8')).toBe('outside');
  });

  it('replaces linked manifest and lock files without reading or writing their targets', async () => {
    const root = await tempProject();
    const manifestPath = join(root, 'opm.toml');
    const lockPath = join(root, 'opm.lock.json');
    const manifest = await readManifestFile(manifestPath);
    const lock = await readLockfile(lockPath);
    if (!lock) throw new Error('expected lock');
    const outsideManifest = join(root, 'outside-manifest');
    const outsideLock = join(root, 'outside-lock');
    await writeFile(outsideManifest, 'outside manifest');
    await writeFile(outsideLock, 'outside lock');
    await rm(manifestPath);
    await rm(lockPath);
    await symlink(outsideManifest, manifestPath);
    await symlink(outsideLock, lockPath);

    await expect(readManifestFile(manifestPath)).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
    await expect(readLockfile(lockPath)).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
    await writeManifestFile(manifestPath, manifest);
    await writeLockfile(lockPath, lock);

    expect((await lstat(manifestPath)).isFile()).toBe(true);
    expect((await lstat(lockPath)).isFile()).toBe(true);
    expect(await readFile(outsideManifest, 'utf8')).toBe('outside manifest');
    expect(await readFile(outsideLock, 'utf8')).toBe('outside lock');
  });

  it.each(['bin', 'links'])(
    'validates a linked %s directory even for an empty project state',
    async (name) => {
      const root = await tempProject();
      const managed = join(root, '.opm', name);
      const outside = join(root, `outside-${name}`);
      await rm(managed, { recursive: true });
      await mkdir(outside);
      await writeFile(join(outside, 'marker'), 'untouched');
      await symlink(outside, managed, 'dir');

      await expect(
        readProjectState(join(root, '.opm/project.json')),
      ).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(await readdir(outside)).toEqual(['marker']);
    },
  );

  it('replaces a linked final shim without changing its target', async () => {
    const root = await tempProject();
    const outside = join(root, 'outside-shim');
    const shim = join(root, '.opm/bin/demo-tool');
    await writeFile(outside, 'untouched');
    await symlink(outside, shim);

    await addPackage({
      root,
      spec: 'pkg:npm/demo-tool@1.1.0',
      source: fixtureTgz,
      offline: true,
    });

    expect((await lstat(shim)).isFile()).toBe(true);
    expect(await readFile(outside, 'utf8')).toBe('untouched');
  });

  it('detects an ancestor swap during stable publication', async () => {
    const root = await tempProject();
    const bin = join(root, '.opm/bin');
    const outside = join(root, 'outside-bin');
    const backup = join(root, '.opm/bin-original');
    await mkdir(outside);

    let settled = false;
    const writing = writeStableFile(
      join(bin, 'large-shim'),
      new Uint8Array(16 * 1024 * 1024),
      0o755,
    );
    void writing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    let observed = false;
    while (!settled && !observed) {
      observed = (await readdir(bin)).some((entry) => entry.endsWith('.tmp'));
      if (!observed)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(observed).toBe(true);
    await rename(bin, backup);
    await symlink(outside, bin, 'dir');

    await expect(writing).rejects.toMatchObject({ code: 'INPUT_CHANGED' });
    expect(await readdir(outside)).toEqual([]);
  });

  it('operates through a symlinked ancestor of the project root', async () => {
    // Stock macOS symlinks /var → /private/var, so every $TMPDIR project has
    // a symlinked ancestor; the same holds for symlinked home directories and
    // automounters on Linux.
    const base = await mkdtemp(join(tmpdir(), 'opm-alias-'));
    temps.push(base);
    const real = join(base, 'real');
    const alias = join(base, 'alias');
    await mkdir(real);
    await symlink(real, alias, 'dir');

    await writeStableFile(join(alias, '.opm', 'metadata.json'), '{"ok":true}');
    expect(await readStableFile(join(alias, '.opm', 'metadata.json'))).toBe(
      '{"ok":true}',
    );
    expect(await readFile(join(real, '.opm', 'metadata.json'), 'utf8')).toBe(
      '{"ok":true}',
    );
  });

  it('detects a swap of a symlinked ancestor while a handle is held', async () => {
    const base = await mkdtemp(join(tmpdir(), 'opm-alias-swap-'));
    temps.push(base);
    const real = join(base, 'real');
    const decoy = join(base, 'decoy');
    const alias = join(base, 'alias');
    await mkdir(join(real, 'sub'), { recursive: true });
    await mkdir(join(decoy, 'sub'), { recursive: true });
    await symlink(real, alias, 'dir');

    const handle = await openStableDirectory(join(alias, 'sub'));
    try {
      await rm(alias);
      await symlink(decoy, alias, 'dir');
      await expect(
        revalidateStableDirectory(join(alias, 'sub'), handle),
      ).rejects.toMatchObject({ code: 'INPUT_CHANGED' });
    } finally {
      await handle.close();
    }
  });

  it('refuses network fetches while offline', async () => {
    await expect(
      fetchArtifactBytes('https://registry.example.invalid/pkg.tgz', true),
    ).rejects.toMatchObject({ code: 'OFFLINE' });
  });

  it('bounds and cancels remote artifact collection', async () => {
    let canceled = false;
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(2));
            },
            cancel() {
              canceled = true;
            },
          }),
          { status: 200 },
        ),
    );
    await expect(
      fetchArtifactBytes('https://packages.example/artifact', false, {
        maximumBytes: 1,
      }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    expect(canceled).toBe(true);
  });

  it('rejects oversized and linked local artifact sources', async () => {
    const root = await tempProject();
    const artifact = join(root, 'artifact.tgz');
    const linked = join(root, 'linked.tgz');
    await writeFile(artifact, 'too large');
    await symlink(artifact, linked);
    await expect(
      fetchArtifactBytes(artifact, true, { maximumBytes: 1 }),
    ).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    await expect(fetchArtifactBytes(linked, true)).rejects.toMatchObject({
      code: 'UNSAFE_SOURCE',
    });
    await expect(fetchArtifactBytes(root, true)).rejects.toMatchObject({
      code: 'UNSAFE_SOURCE',
    });
  });

  it('refuses an explicit network source while offline', async () => {
    const root = await tempProject();
    await expect(
      addPackage({
        root,
        spec: 'pkg:npm/example@1.0.0',
        source: 'https://registry.example.invalid/example-1.0.0.tgz',
        offline: true,
      }),
    ).rejects.toMatchObject({ code: 'OFFLINE' });
  });

  it('does not treat persisted lifecycle claims as policy authority', async () => {
    const root = await tempProject();
    const digest = `sha256:${'a'.repeat(64)}`;
    const pkg = {
      alias: 'revoked',
      purl: 'pkg:npm/revoked@1.0.0',
      version: '1.0.0',
      digest,
      size: 1,
      format: 'tar' as const,
      mediaType: 'application/octet-stream',
      source: 'https://registry.npmjs.org/revoked/-/revoked-1.0.0.tgz',
      storeKey: storeKeyFromDigest(digest),
      bins: [],
      reason: 'direct' as const,
      ecosystem: 'npm',
      sourceKind: 'registry' as const,
      lifecycle: { status: 'revoked' as const, eligible: false },
      publishedAt: '2020-01-01T00:00:00.000Z',
    };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const policy = defaultSupplyChainPolicyInput();

    await expect(
      installFromLock({
        root,
        lock: {
          schemaVersion: 1,
          generatedBy: 'opm',
          packages: { revoked: pkg },
        },
        offline: false,
        policy,
      }),
    ).rejects.toMatchObject({ code: 'POLICY_INDETERMINATE' });
    await expect(
      materializeLockPackage({ root, pkg, offline: false, policy }),
    ).rejects.toMatchObject({ code: 'POLICY_INDETERMINATE' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed before ambient refetch when remote provenance cannot be replayed', async () => {
    const root = await tempProject();
    const digest = `sha256:${'a'.repeat(64)}`;
    const pkg = {
      alias: 'remote',
      purl: 'pkg:npm/remote@1.0.0',
      version: '1.0.0',
      digest,
      size: 1,
      format: 'tar' as const,
      mediaType: 'application/octet-stream',
      source: 'https://registry.npmjs.org/remote/-/remote-1.0.0.tgz',
      storeKey: storeKeyFromDigest(digest),
      bins: [],
      reason: 'direct' as const,
      ecosystem: 'npm',
      lifecycle: { status: 'published' as const, eligible: true },
      publishedAt: '2020-01-01T00:00:00.000Z',
    };
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      materializeLockPackage({
        root,
        pkg,
        offline: false,
        policy: defaultSupplyChainPolicyInput(),
      }),
    ).rejects.toMatchObject({ code: 'POLICY_INDETERMINATE' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a tampered artifact with DIGEST_MISMATCH before extraction', async () => {
    const root = await tempProject();
    const wrongDigest = `sha256:${'b'.repeat(64)}`;
    const pkg = {
      alias: 'demo-tool',
      purl: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      version: '1.1.0',
      digest: wrongDigest,
      size: 406,
      format: 'tar+gzip' as const,
      mediaType: 'application/vnd.openpacker.package.tgz',
      source: `file:${fixtureTgz}`,
      storeKey: storeKeyFromDigest(wrongDigest),
      bins: [],
      reason: 'direct' as const,
      ecosystem: 'npm',
    };
    bindManifestSourceAuthority(pkg);
    await expect(
      materializeLockPackage({
        root,
        pkg,
        offline: true,
      }),
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
  });

  it('refuses a tampered lock digest and ignores unsigned policy claims', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/demo-tool@1.1.0',
      source: fixtureTgz,
      offline: true,
    });
    const paths = projectPaths(root);
    const lock = await readLockfile(paths.lock);
    if (!lock) throw new Error('expected lock');
    const pkg = lock.packages['demo-tool']!;
    pkg.digest = `sha256:${'b'.repeat(64)}`;
    pkg.storeKey = storeKeyFromDigest(pkg.digest);
    pkg.sourceKind = 'registry';
    pkg.registryId = 'urn:attacker:registry';
    pkg.publishedAt = '2020-01-01T00:00:00.000Z';
    pkg.trustLevel = 'registry-attested';
    pkg.lifecycle = { status: 'published', eligible: true };
    await writeLockfile(paths.lock, lock);

    await expect(installProject({ root, offline: true })).rejects.toMatchObject(
      { code: 'DIGEST_MISMATCH' },
    );
  });

  it('does not trust hand-authored policy claims even when artifact bytes are cached', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      source: fixtureTgz,
      offline: true,
    });
    const serialized = JSON.parse(
      await readFile(projectPaths(root).lock, 'utf8'),
    ) as {
      packages: Record<string, Record<string, unknown>>;
    };
    Object.assign(serialized.packages['demo-tool']!, {
      evidence: [{ type: 'slsa', status: 'valid' }],
      signerIdentity: 'trusted@example.test',
      sigstoreIssuer: 'https://issuer.example.test',
      exactSourceSnapshot: true,
      sourceSnapshotDigests: [{ algorithm: 'sha256', value: 'a'.repeat(64) }],
    });

    // The lock parser deliberately has no assertion-carrying fields for these
    // claims. They cannot become policy authority by being hand-authored next
    // to otherwise valid, cached package bytes.
    const forged = parseLockfile(JSON.stringify(serialized));
    expect(forged.packages['demo-tool']).not.toHaveProperty('evidence');
    await expect(
      installFromLock({
        root,
        lock: forged,
        offline: true,
        policy: {
          ...defaultSupplyChainPolicyInput(),
          requiredEvidence: ['slsa'],
          acceptedIdentities: ['trusted@example.test'],
          acceptedIssuers: ['https://issuer.example.test'],
          requireExactSourceSnapshot: true,
          requiredSourceSnapshotDigests: [
            { algorithm: 'sha256', value: 'a'.repeat(64) },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'POLICY_INDETERMINATE' });
  });

  it('does not let a registry lock rewrite its source to an unbound path', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    const paths = projectPaths(root);
    const lock = await readLockfile(paths.lock);
    const pkg = lock?.packages['demo-tool'];
    if (!lock || !pkg) throw new Error('expected cached lock package');
    pkg.source = `file:${fixtureTgz}`;
    pkg.sourceKind = 'registry';
    pkg.registryId = 'urn:attacker:registry';
    pkg.lifecycle = { status: 'published', eligible: true };
    await writeLockfile(paths.lock, lock);
    const storePath = join(paths.store, pkg.storeKey);
    await uninstallProject({ root, alias: 'demo-tool' });
    await rm(storePath, { recursive: true, force: true });

    // The manifest did not authorize a direct source. Neither the rewritten
    // path nor the adjacent registry/lifecycle assertions may weaken policy.
    await expect(installProject({ root, offline: true })).rejects.toMatchObject(
      { code: 'POLICY_INDETERMINATE' },
    );
    await expect(lstat(storePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('invalidates verified facts after custom serialization and identity mutation', async () => {
    const root = await tempProject();
    const bytes = new Uint8Array(await readFile(fixtureTgz));
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const pkg = {
      alias: 'demo-tool',
      purl: 'pkg:npm/demo-tool@1.1.0',
      version: '1.1.0',
      digest,
      size: bytes.byteLength,
      format: 'tar+gzip' as const,
      mediaType: 'application/vnd.openpacker.package.tgz',
      source: 'https://registry.npmjs.org/demo-tool/-/demo-tool-1.1.0.tgz',
      storeKey: storeKeyFromDigest(digest),
      bins: [],
      reason: 'direct' as const,
      ecosystem: 'npm',
      sourceKind: 'registry' as const,
    };
    const facts = captureFactsFromSourceUri(pkg.purl, pkg.source, {
      evaluationTime: '2026-08-19T00:00:00.000Z',
      fromRegistryArtifactRecord: true,
      lifecycle: { status: 'published', eligible: true },
    });
    facts.publishedAt = '2020-01-01T00:00:00.000Z';
    bindVerifiedArtifactBytes(pkg, bytes, 'registry', facts);
    sealVerifiedArtifactBinding(pkg);
    expect(() =>
      Object.defineProperty(pkg, 'toJSON', {
        value: () => ({ source: pkg.source, purl: pkg.purl }),
      }),
    ).toThrow(TypeError);
    expect(() => {
      pkg.purl = 'pkg:npm/attacker@1.1.0';
    }).toThrow(TypeError);
    expect(() => {
      pkg.source = `file:${fixtureTgz}`;
    }).toThrow(TypeError);
  });

  it('invalidates manifest source authority when a returned lock is mutated', async () => {
    const root = await tempProject();
    const added = await addPackage({
      root,
      spec: 'pkg:npm/demo-tool@1.1.0',
      source: fixtureTgz,
      offline: true,
    });
    const pkg = added.lock.packages['demo-tool'];
    if (!pkg) throw new Error('expected lock package');
    bindManifestSourceAuthority(pkg);
    expect(() => {
      pkg.source = `file:${join(root, 'attacker-controlled.tgz')}`;
    }).toThrow(TypeError);
  });

  it('deep-freezes shallow-frozen lock data and rejects cycles', async () => {
    const root = await tempProject();
    const digest = `sha256:${'a'.repeat(64)}`;
    const pkg = Object.freeze({
      alias: 'demo',
      purl: 'pkg:npm/demo@1.0.0',
      version: '1.0.0',
      digest,
      size: 1,
      format: 'tar' as const,
      mediaType: 'application/octet-stream',
      source: 'file:demo.tar',
      storeKey: storeKeyFromDigest(digest),
      bins: [{ name: 'demo', path: 'package/demo.js' }],
      reason: 'direct' as const,
      ecosystem: 'npm',
    });
    bindManifestSourceAuthority(pkg);
    expect(() => {
      pkg.bins[0]!.path = '../escape';
    }).toThrow(TypeError);

    const cyclic = { ...pkg, bins: [] as unknown[] };
    cyclic.bins.push(cyclic.bins);
    await expect(
      materializeLockPackage({
        root,
        pkg: cyclic as unknown as typeof pkg,
        offline: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_LOCK' });
  });

  it('freezes unbound public lock inputs before the first await', async () => {
    const root = await tempProject();
    const digest = `sha256:${'a'.repeat(64)}`;
    const pkg = {
      alias: 'unbound',
      purl: 'pkg:npm/unbound@1.0.0',
      version: '1.0.0',
      digest,
      size: 1,
      format: 'tar' as const,
      mediaType: 'application/octet-stream',
      source: 'file:unbound.tar',
      storeKey: storeKeyFromDigest(digest),
      bins: [],
      reason: 'direct' as const,
      ecosystem: 'npm',
    };
    const installing = installFromLock({
      root,
      offline: true,
      lock: {
        schemaVersion: 1,
        generatedBy: 'opm',
        packages: { unbound: pkg },
      },
    });
    expect(() => {
      pkg.source = `file:${fixtureTgz}`;
    }).toThrow(TypeError);
    await expect(installing).rejects.toMatchObject({
      code: 'POLICY_INDETERMINATE',
    });
  });

  it('copies caller bytes before the first async policy gate', async () => {
    const root = await tempProject();
    const bytes = new Uint8Array(await readFile(fixtureTgz));
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const pkg = {
      alias: 'demo',
      purl: 'pkg:npm/demo@1.1.0',
      version: '1.1.0',
      digest,
      size: bytes.byteLength,
      format: 'tar+gzip' as const,
      mediaType: 'application/vnd.openpacker.package.tgz',
      source: `file:${fixtureTgz}`,
      storeKey: storeKeyFromDigest(digest),
      bins: [],
      reason: 'direct' as const,
      ecosystem: 'npm',
    };
    bindManifestSourceAuthority(pkg);
    const materialising = materializeLockPackage({
      root,
      pkg,
      offline: true,
      bytes,
    });
    bytes.fill(0);
    await expect(materialising).resolves.toMatchObject({ cached: false });
  });

  it('materializes a public source package without private authority hooks', async () => {
    const root = await tempProject();
    const bytes = new Uint8Array(await readFile(fixtureTgz));
    const pkg = lockPackageFromSource({
      alias: 'demo',
      purl: 'pkg:npm/demo@1.1.0',
      version: '1.1.0',
      ecosystem: 'npm',
      bytes,
      source: `file:${fixtureTgz}`,
      format: 'tar+gzip',
      mediaType: 'application/vnd.openpacker.package.tgz',
    });

    await expect(
      materializeLockPackage({ root, pkg, offline: true }),
    ).resolves.toMatchObject({ cached: false });
    await expect(
      installFromLock({
        root,
        offline: true,
        lock: {
          schemaVersion: 1,
          generatedBy: 'opm',
          packages: { demo: pkg },
        },
      }),
    ).resolves.toMatchObject({
      packages: { demo: { digest: pkg.digest } },
    });
  });

  it('reads public source constructor accessors exactly once', async () => {
    const root = await tempProject();
    const goodBytes = new Uint8Array(await readFile(fixtureTgz));
    const badBytes = new Uint8Array(goodBytes.byteLength);
    let byteReads = 0;
    let sourceReads = 0;
    const source = `file:${fixtureTgz}`;
    const input = {
      alias: 'demo',
      purl: 'pkg:npm/demo@1.1.0',
      version: '1.1.0',
      ecosystem: 'npm',
      get bytes() {
        return byteReads++ === 0 ? goodBytes : badBytes;
      },
      get source() {
        return sourceReads++ === 0
          ? source
          : 'https://attacker.invalid/demo.tgz';
      },
      format: 'tar+gzip' as const,
      mediaType: 'application/vnd.openpacker.package.tgz',
    };

    const pkg = lockPackageFromSource(input);
    expect(byteReads).toBe(1);
    expect(sourceReads).toBe(1);
    expect(pkg.source).toBe(source);
    expect(pkg.digest).toBe(
      `sha256:${createHash('sha256').update(goodBytes).digest('hex')}`,
    );
    await expect(
      materializeLockPackage({ root, pkg, offline: true }),
    ).resolves.toMatchObject({ cached: false });
  });

  it('snapshots lifecycle policy before the first await', async () => {
    const root = await tempProject();
    const purl = 'pkg:npm/policy-race@1.0.0';
    const bytes = packTarGzip([
      {
        path: 'package/package.json',
        contents: new TextEncoder().encode(
          JSON.stringify({
            name: 'policy-race',
            version: '1.0.0',
            scripts: {
              postinstall:
                "node -e \"require('fs').writeFileSync('ran','yes')\"",
            },
          }),
        ),
        executable: false,
      },
    ]);
    const pkg = lockPackageFromSource({
      alias: 'policy-race',
      purl,
      version: '1.0.0',
      ecosystem: 'npm',
      bytes,
      source: 'file:policy-race.tgz',
      format: 'tar+gzip',
      mediaType: 'application/vnd.npm.package+gzip',
    });
    const policy = {
      ...defaultSupplyChainPolicyInput(),
      allowedLifecycleScriptPackages: [] as string[],
    };
    const materialising = materializeLockPackage({
      root,
      pkg,
      offline: true,
      policy,
    });
    policy.allowLifecycleScripts = true;
    policy.allowedLifecycleScriptPackages.push(purl);
    const result = await materialising;
    await expect(readFile(join(result.storePath, 'ran'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
  });

  it('rejects a size mismatch even when the digest matches', async () => {
    const root = await tempProject();
    const bytes = await readFile(fixtureTgz);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const pkg = {
      alias: 'demo-tool',
      purl: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      version: '1.1.0',
      digest,
      size: bytes.byteLength + 1,
      format: 'tar+gzip' as const,
      mediaType: 'application/vnd.openpacker.package.tgz',
      source: `file:${fixtureTgz}`,
      storeKey: storeKeyFromDigest(digest),
      bins: [],
      reason: 'direct' as const,
      ecosystem: 'npm',
    };
    bindManifestSourceAuthority(pkg);
    await expect(
      materializeLockPackage({
        root,
        pkg,
        offline: true,
      }),
    ).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
  });

  it('rebuilds store trees only from a verified canonical artifact cache', async () => {
    const root = await tempProject();
    const bytes = new Uint8Array(await readFile(fixtureTgz));
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const pkg = {
      alias: 'demo-tool',
      purl: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      version: '1.1.0',
      digest,
      size: bytes.byteLength,
      format: 'tar+gzip' as const,
      mediaType: 'application/vnd.openpacker.package.tgz',
      source: `file:${fixtureTgz}`,
      storeKey: storeKeyFromDigest(digest),
      bins: [],
      reason: 'direct' as const,
      ecosystem: 'npm',
    };
    bindManifestSourceAuthority(pkg);
    const storePath = join(root, '.opm/store', pkg.storeKey);
    await mkdir(storePath, { recursive: true });
    await writeFile(join(storePath, 'malicious'), 'unverified');

    const first = await materializeLockPackage({
      root,
      pkg,
      offline: true,
      bytes,
    });
    await expect(readFile(join(storePath, 'malicious'))).rejects.toThrow();
    const bin = first.bins[0];
    if (!bin) throw new Error('fixture must declare a bin');
    const target = join(storePath, ...bin.path.split('/'));
    const original = await readFile(target);
    await writeFile(target, 'tampered');

    const cached = await materializeLockPackage({
      root,
      pkg,
      offline: true,
    });
    expect(cached.cached).toBe(true);
    expect(await readFile(target)).toEqual(original);

    await chmod(`${storePath}.artifact`, 0o644);
    await writeFile(`${storePath}.artifact`, new Uint8Array(bytes.byteLength));
    await expect(
      materializeLockPackage({ root, pkg, offline: true }),
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
  });

  it('preserves the current store tree when replacement materialization fails', async () => {
    const root = await tempProject();
    const bytes = new Uint8Array(await readFile(fixtureTgz));
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const pkg = {
      alias: 'demo-tool',
      purl: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      version: '1.1.0',
      digest,
      size: bytes.byteLength,
      format: 'tar+gzip' as const,
      mediaType: 'application/vnd.openpacker.package.tgz',
      source: `file:${fixtureTgz}`,
      storeKey: storeKeyFromDigest(digest),
      bins: [],
      reason: 'direct' as const,
      ecosystem: 'npm',
    };
    bindManifestSourceAuthority(pkg);
    const { storePath, bins } = await materializeLockPackage({
      root,
      pkg,
      offline: true,
      bytes,
    });
    const bin = bins[0];
    if (!bin) throw new Error('fixture must declare a bin');
    const target = join(storePath, ...bin.path.split('/'));
    const original = await readFile(target);

    await expect(
      materializeLockPackage({
        root,
        pkg: { ...pkg, format: 'zip' },
        offline: true,
        force: true,
        bytes,
      }),
    ).rejects.toBeDefined();
    expect(await readFile(target)).toEqual(original);
  });

  it('keeps lifecycle failures inside quarantine and preserves the published tree', async () => {
    const root = await tempProject();
    const purl = 'pkg:npm/quarantined-build@1.0.0';
    const packageJson = JSON.stringify({
      name: 'quarantined-build',
      version: '1.0.0',
      scripts: {
        postinstall:
          "node -e \"require('fs').writeFileSync('mutated','yes');process.exit(1)\"",
      },
    });
    const bytes = packTarGzip([
      {
        path: 'package/package.json',
        contents: new TextEncoder().encode(packageJson),
        executable: false,
      },
    ]);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const pkg = {
      alias: 'quarantined-build',
      purl,
      version: '1.0.0',
      digest,
      size: bytes.byteLength,
      format: 'tar+gzip' as const,
      mediaType: 'application/vnd.npm.package+gzip',
      source: 'file:unused',
      storeKey: storeKeyFromDigest(digest),
      bins: [],
      reason: 'direct' as const,
      ecosystem: 'npm',
    };
    bindManifestSourceAuthority(pkg);
    const first = await materializeLockPackage({
      root,
      pkg,
      offline: true,
      bytes,
    });
    const publishedManifest = join(first.storePath, 'package/package.json');
    expect(await readFile(publishedManifest, 'utf8')).toBe(packageJson);

    await expect(
      materializeLockPackage({
        root,
        pkg,
        offline: true,
        force: true,
        bytes,
        policy: {
          ...defaultSupplyChainPolicyInput(),
          allowLifecycleScripts: true,
          allowedLifecycleScriptPackages: [purl],
        },
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/LIFECYCLE_FAILED|SANDBOX_UNAVAILABLE/u),
    });
    expect(await readFile(publishedManifest, 'utf8')).toBe(packageJson);
    await expect(
      readFile(join(first.storePath, 'mutated')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a store directory substituted during materialization', async () => {
    const root = await tempProject();
    const bytes = packTarGzip([
      {
        path: 'package/package.json',
        contents: new TextEncoder().encode(
          JSON.stringify({ name: 'swap-test', version: '1.0.0' }),
        ),
        executable: false,
      },
      {
        path: 'package/large.bin',
        contents: new Uint8Array(randomBytes(8 * 1024 * 1024)),
        executable: false,
      },
    ]);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const store = join(root, '.opm/store');
    const backup = join(root, '.opm/store-original');
    const pkg = {
      alias: 'swap-test',
      purl: 'pkg:npm/swap-test@1.0.0',
      version: '1.0.0',
      digest,
      size: bytes.byteLength,
      format: 'tar+gzip' as const,
      mediaType: 'application/vnd.openpacker.package.tgz',
      source: 'file:unused',
      storeKey: storeKeyFromDigest(digest),
      bins: [],
      reason: 'direct' as const,
      ecosystem: 'npm',
    };
    bindManifestSourceAuthority(pkg);
    const materialising = materializeLockPackage({
      root,
      pkg,
      offline: true,
      bytes,
    });
    void materialising.catch(() => undefined);
    let observed = false;
    while (!observed) {
      observed = (await readdir(store)).some((entry) =>
        entry.startsWith(`.${storeKeyFromDigest(digest)}.`),
      );
      if (!observed)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await rename(store, backup);
    await mkdir(store);

    await expect(materialising).rejects.toMatchObject({
      code: 'INPUT_CHANGED',
    });
    expect(await readdir(store)).toEqual([]);
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

  it('refuses a remote catalog artifact before any network request', async () => {
    const root = await tempProject();
    const fetch = vi.fn(() => {
      throw new Error('network must not run');
    });
    vi.stubGlobal('fetch', fetch);
    await writeFile(
      join(root, '.opm', 'catalog.json'),
      JSON.stringify({
        schemaVersion: 1,
        packages: {
          'pkg:npm/catalog-ssrf@1.0.0': {
            purl: 'pkg:npm/catalog-ssrf@1.0.0',
            version: '1.0.0',
            digest: `sha256:${'0'.repeat(64)}`,
            size: 1,
            format: 'tar+gzip',
            mediaType: 'application/vnd.npm.package+gzip',
            source: 'https://127.0.0.1/internal.tgz',
          },
        },
      }),
    );

    await expect(
      addPackage({ root, spec: 'pkg:npm/catalog-ssrf@1.0.0' }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^POLICY_/u) });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects persisted store and bin authority outside the project store', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    const statePath = join(root, '.opm/project.json');
    const valid = JSON.parse(await readFile(statePath, 'utf8')) as {
      packages: Record<
        string,
        { storePath: string; bins: Array<{ target: string }> }
      >;
    };
    const record = Object.values(valid.packages)[0]!;
    const originalStore = record.storePath;
    record.storePath = root;
    await writeFile(statePath, JSON.stringify(valid));
    await expect(readProjectState(statePath)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });

    record.storePath = originalStore;
    record.bins[0]!.target = join(root, 'opm.toml');
    await writeFile(statePath, JSON.stringify(valid));
    await expect(readProjectState(statePath)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });

  it('rejects a linked digest-named store directory', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    const statePath = join(root, '.opm/project.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      packages: Record<string, { storePath: string }>;
    };
    const storePath = Object.values(state.packages)[0]!.storePath;
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'marker'), 'untouched');
    await rm(storePath, { recursive: true });
    await symlink(outside, storePath, 'dir');
    await expect(readProjectState(statePath)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(await readFile(join(outside, 'marker'), 'utf8')).toBe('untouched');
  });

  it('treats a missing persisted bin target as invalid state, not absent state', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    const statePath = join(root, '.opm/project.json');
    const state = await readProjectState(statePath);
    const target = Object.values(state?.packages ?? {})[0]?.bins[0]?.target;
    if (!target) throw new Error('fixture must declare a bin target');
    await rm(target);
    await expect(readProjectState(statePath)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });
});

describe('project lifecycle offline', () => {
  it('reinstalls a committed lock from cached bytes after resolution inputs disappear', async () => {
    const root = await tempProject();
    const source = join(root, 'vendor', 'demo-tool.tgz');
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, await readFile(fixtureTgz));
    await addPackage({
      root,
      spec: 'pkg:npm/demo-tool@1.1.0',
      source,
      offline: true,
    });

    const paths = projectPaths(root);
    const lock = await readLockfile(paths.lock);
    const pkg = lock?.packages['demo-tool'];
    if (!pkg) throw new Error('expected cached lock package');
    const storePath = join(paths.store, pkg.storeKey);
    expect((await lstat(`${storePath}.artifact`)).isFile()).toBe(true);

    await uninstallProject({ root, alias: 'demo-tool' });
    await rm(storePath, { recursive: true, force: true });
    await rm(source);
    await rm(paths.catalog);

    // installProject reads a new lock object, so no in-memory resolution
    // capability survives. The missing source and catalog prove it can only
    // use the digest-checked canonical archive cache.
    const installed = await installProject({ root, offline: true });
    expect(installed.lock).toEqual(lock);
    expect(installed.state.packages['demo-tool']?.digest).toBe(pkg.digest);
    expect((await lstat(storePath)).isDirectory()).toBe(true);
  });

  it('refuses list when stable project metadata is unavailable', async () => {
    const root = await tempProject();
    await expect(listInstalled(root, 'win32')).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
  });

  it('init add install list remove uninstall sync', async () => {
    const root = await tempProject();

    const added = await addPackage({
      root,
      spec: 'pkg:npm/demo-tool@1.1.0',
      source: fixtureTgz,
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
  }, 30_000);
});

describe('environment generations', () => {
  it('appends an immutable, hash-linked generation per install', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      source: fixtureTgz,
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
      spec: 'pkg:npm/demo-tool@1.1.0',
      source: fixtureTgz,
      offline: true,
    });
    await installProject({ root, offline: true });
    await installProject({ root, offline: true });
    // An install that changes nothing would otherwise grow the ledger forever.
    expect(await listGenerations(root)).toHaveLength(1);
  });

  it('rebuilds a legacy v1 generation tree baseline when activating it', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    const [current] = await listGenerations(root);
    if (!current) throw new Error('expected generation');
    const { generationDigest: _currentDigest, ...currentBody } = current;
    const body = {
      ...currentBody,
      generationVersion: '1' as const,
      members: current.members.map(
        ({ treeDigest: _treeDigest, ...member }) => member,
      ),
    };
    const legacy = { ...body, generationDigest: generationDigest(body) };

    const state = await activateGeneration({ root, generation: legacy });
    expect(state.packages['demo-tool']?.purl).toBe(
      'pkg:npm/@openpacker/demo-tool@1.1.0',
    );
  });

  it('rejects an existing lock with a direct package absent from the manifest', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    const paths = projectPaths(root);
    const manifest = parseManifest(await readFile(paths.manifest, 'utf8'));
    manifest.packages = {};
    await writeFile(paths.manifest, serializeManifest(manifest));

    await expect(installProject({ root, offline: true })).rejects.toMatchObject(
      { code: 'INVALID_LOCK' },
    );
  });

  it('rejects an existing lock package outside the manifest dependency closure', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    const paths = projectPaths(root);
    const lock = await readLockfile(paths.lock);
    if (!lock) throw new Error('expected lock');
    const direct = lock.packages['demo-tool']!;
    lock.packages.intruder = {
      ...direct,
      alias: 'intruder',
      purl: 'pkg:npm/intruder@1.0.0',
      reason: 'transitive',
      dependencies: [],
    };
    await writeLockfile(paths.lock, lock);

    await expect(installProject({ root, offline: true })).rejects.toMatchObject(
      { code: 'INVALID_LOCK' },
    );
  });

  it('rejects an existing lock after its committed policy changes', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    const paths = projectPaths(root);
    const manifest = parseManifest(await readFile(paths.manifest, 'utf8'));
    manifest.policy = { ...manifest.policy, allowYanked: true };
    await writeFile(paths.manifest, serializeManifest(manifest));

    await expect(installProject({ root, offline: true })).rejects.toMatchObject(
      { code: 'INVALID_LOCK' },
    );
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

  it('refuses to activate a retained generation whose store tree changed', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    const installed = await readProjectState(projectPaths(root).projectState);
    const target = installed?.packages['demo-tool']?.bins[0]?.target;
    if (!target) throw new Error('expected installed executable');
    await removePackage({ root, alias: 'demo-tool', offline: true });
    const before = await readEnvironmentState(root);
    await writeFile(target, 'tampered executable');

    await expect(switchGeneration({ root, target: 1 })).rejects.toMatchObject({
      code: 'DIGEST_MISMATCH',
    });
    expect(await readEnvironmentState(root)).toEqual(before);
    expect(
      (await readProjectState(projectPaths(root).projectState))?.packages,
    ).toEqual({});
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

  it('keeps the current generation when the target cannot be activated', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    const [first] = await listGenerations(root);
    if (!first?.members[0]) throw new Error('expected installed generation');
    await removePackage({ root, alias: 'demo-tool', offline: true });
    const before = await readEnvironmentState(root);
    await rm(first.members[0].storePath, { recursive: true, force: true });

    await expect(switchGeneration({ root, target: 1 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await readEnvironmentState(root)).toEqual(before);
    expect(
      (await readProjectState(projectPaths(root).projectState))?.packages,
    ).toEqual({});
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

  it('retains store paths reachable through references, not just members', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    const state = await readEnvironmentState(root);
    const [installed] = await listGenerations(root);
    if (!installed || !state)
      throw new Error('expected an installed generation');

    // A store path no generation lists as a member. Nothing reaches it, so it
    // is collectable.
    const referenced = join(root, `.opm/store/sha256-${'d'.repeat(64)}`);
    await mkdir(referenced, { recursive: true });
    await writeFile(join(referenced, 'marker'), 'x');
    expect((await collectGarbage({ root, dryRun: true })).removed).toContain(
      referenced,
    );

    // Recording a generation whose member references it must protect it:
    // collection is defined over the closure, and deleting a referenced path
    // would break the member that needs it.
    const record = Object.values(
      (await readProjectState(join(root, '.opm/project.json')))?.packages ?? {},
    )[0];
    if (!record) throw new Error('expected an installed package record');
    await recordGeneration({
      root,
      packages: { [record.alias]: { ...record, digest: `${record.digest}` } },
      lockDigest: 'sha256:edge',
      references: { [record.storePath]: [referenced] },
    });
    const afterEdge = await collectGarbage({ root, dryRun: true });
    expect(afterEdge.removed).not.toContain(referenced);
  });

  it('retains references transitively, through paths that are not members', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });

    // A three-deep chain. Only the first hop is a generation member: a
    // transitive runtime dependency is by definition not something the project
    // installed directly, so a closure that only walks member edges stops one
    // hop short and deletes content that is still referenced.
    const store = join(root, '.opm/store');
    const middle = join(store, `sha256-${'b'.repeat(64)}`);
    const leaf = join(store, `sha256-${'c'.repeat(64)}`);
    for (const path of [middle, leaf]) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'marker'), 'x');
    }

    const record = Object.values(
      (await readProjectState(join(root, '.opm/project.json')))?.packages ?? {},
    )[0];
    if (!record) throw new Error('expected an installed package record');
    await recordGeneration({
      root,
      packages: { [record.alias]: record },
      lockDigest: 'sha256:chain',
      references: {
        [record.storePath]: [middle],
        [middle]: [leaf],
      },
    });

    const removed = (await collectGarbage({ root, dryRun: true })).removed;
    expect(removed).not.toContain(middle);
    expect(removed).not.toContain(leaf);
  });

  it('keeps the reference graph across a gc that forgets generations', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });

    const store = join(root, '.opm/store');
    const middle = join(store, `sha256-${'b'.repeat(64)}`);
    const leaf = join(store, `sha256-${'c'.repeat(64)}`);
    for (const path of [middle, leaf]) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'marker'), 'x');
    }

    const record = Object.values(
      (await readProjectState(join(root, '.opm/project.json')))?.packages ?? {},
    )[0];
    if (!record) throw new Error('expected an installed package record');

    // The generation that observed the deep edge is not the one that survives
    // gc. If the graph lived in the generation record it would be deleted with
    // it, and a second gc over identical live content would collect the leaf.
    await recordGeneration({
      root,
      packages: { [record.alias]: record },
      lockDigest: 'sha256:observed',
      references: { [record.storePath]: [middle], [middle]: [leaf] },
    });
    await recordGeneration({
      root,
      packages: { [record.alias]: record },
      lockDigest: 'sha256:later',
    });

    const first = await collectGarbage({ root, keep: 1 });
    expect(first.removed).not.toContain(middle);
    expect(first.removed).not.toContain(leaf);

    const second = await collectGarbage({ root, keep: 1 });
    expect(second.removed).not.toContain(middle);
    expect(second.removed).not.toContain(leaf);
  });

  it('forgets reference edges out of a path it collected', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });

    const store = join(root, '.opm/store');
    const orphan = join(store, `sha256-${'a'.repeat(64)}`);
    const target = join(store, `sha256-${'d'.repeat(64)}`);
    for (const path of [orphan, target]) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'marker'), 'x');
    }
    // Nothing reaches the orphan, so both it and what it points at collect.
    await mergeStoreReferences({ root, references: { [orphan]: [target] } });

    const removed = (await collectGarbage({ root })).removed;
    expect(removed).toContain(orphan);
    expect(removed).toContain(target);
    // The ledger must not keep describing paths that no longer exist.
    expect((await readStoreReferences(root)).edges).toEqual({});
  });

  it('unions reference edges across generations rather than overwriting', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });

    const store = join(root, '.opm/store');
    const first = join(store, `sha256-${'e'.repeat(64)}`);
    const second = join(store, `sha256-${'f'.repeat(64)}`);
    for (const path of [first, second]) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'marker'), 'x');
    }

    const record = Object.values(
      (await readProjectState(join(root, '.opm/project.json')))?.packages ?? {},
    )[0];
    if (!record) throw new Error('expected an installed package record');

    // The same store path referenced differently by two retained generations.
    // Both edges are live, because both generations can still be rolled back to.
    await recordGeneration({
      root,
      packages: { [record.alias]: record },
      lockDigest: 'sha256:first',
      references: { [record.storePath]: [first] },
    });
    await recordGeneration({
      root,
      packages: { [record.alias]: record },
      lockDigest: 'sha256:second',
      references: { [record.storePath]: [second] },
    });

    const removed = (await collectGarbage({ root, dryRun: true })).removed;
    expect(removed).not.toContain(first);
    expect(removed).not.toContain(second);
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

  it('refuses a generation whose store path escapes the project store', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    const [generation] = await listGenerations(root);
    if (!generation) throw new Error('expected a generation');
    // A record is digest-verified, but a path outside the store must still be
    // refused rather than generating shims that point anywhere on disk.
    await expect(
      activateGeneration({
        root,
        generation: {
          ...generation,
          members: [{ ...generation.members[0]!, storePath: '/etc' }],
        },
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it("refuses a bin directory containing ':' for every consumer", async () => {
    // PATH cannot represent such a directory, so the environment is wrong for
    // anyone who reads it — the script, `--json`, or an embedder. The check
    // belongs where PATH is built, not in the one consumer that quotes.
    const dir = await mkdtemp(join(tmpdir(), 'opm-colon-'));
    temps.push(dir);
    const root = join(dir, 'has:colon');
    await mkdir(root, { recursive: true });
    await initProject({ root, name: 'test-app' });

    await expect(environmentVariables({ root })).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
    await expect(environmentScript({ root })).rejects.toMatchObject({
      code: 'UNSAFE_PATH',
    });
  });

  it('quotes shell values so eval cannot execute them', async () => {
    // Inside double quotes a shell still expands $, backticks, and \; only
    // single quotes interpret nothing. `eval "$(opm shell)"` is the documented
    // usage, so a project directory name is enough to reach a shell.
    const hostile = [
      '$(touch /tmp/opm-should-not-exist)',
      '`touch /tmp/opm-should-not-exist`',
      '${HOME}',
      "single'quote",
      "quote-at-end'",
      'semi;colon && echo pwned',
      'back\\slash',
      'new\nline',
    ];
    for (const value of hostile) {
      const quoted = shellQuote(value);
      const printed = execFileSync('/bin/sh', ['-c', `printf '%s' ${quoted}`]);
      expect(printed.toString(), value).toBe(value);
    }
    expect(existsSync('/tmp/opm-should-not-exist')).toBe(false);
  });

  it('emits an evaluable script for the current generation', async () => {
    const root = await tempProject();
    await addPackage({
      root,
      spec: 'pkg:npm/@openpacker/demo-tool@1.1.0',
      offline: true,
    });
    const script = await environmentScript({ root });
    // Asserted as a property, not as a quoting style: every line assigns one
    // fixed variable, and evaluating the script reproduces exactly the values
    // the structured form reports. The previous shape assertion pinned single
    // quotes specifically, which is an implementation detail of whatever does
    // the quoting rather than anything a caller depends on.
    for (const line of script.trimEnd().split('\n'))
      expect(line).toMatch(/^export [A-Z_]+=/u);
    const environment = await environmentVariables({ root });
    const names = Object.keys(environment);
    const echoed = execFileSync('/bin/sh', [
      '-c',
      `${script}printf '%s\\0' ${names.map((name) => `"$${name}"`).join(' ')}`,
    ])
      .toString()
      .split('\0')
      .slice(0, -1);
    expect(echoed).toEqual(names.map((name) => environment[name]));
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

describe('cross-ecosystem executable discovery', () => {
  it('reads console scripts from a wheel dist-info', async () => {
    // A wheel has no script file to point at: the entry point is a module and
    // a callable, which is why npm-shaped discovery found nothing here.
    const dir = await mkdtemp(join(tmpdir(), 'opm-wheel-'));
    temps.push(dir);
    await mkdir(join(dir, 'cowsay-6.1.dist-info'), { recursive: true });
    await writeFile(
      join(dir, 'cowsay-6.1.dist-info/entry_points.txt'),
      '[console_scripts]\ncowsay = cowsay.__main__:cli\n\n[gui_scripts]\nnope = x:y\n',
    );
    const bins = await discoverBins(dir, 'pypi');
    expect(bins).toEqual([
      {
        name: 'cowsay',
        path: 'cowsay-6.1.dist-info/entry_points.txt',
        interpreter: 'python',
        entry: 'cowsay.__main__:cli',
      },
    ]);
  });

  it('ignores sections other than console_scripts and malformed entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-wheel-'));
    temps.push(dir);
    await mkdir(join(dir, 'x-1.0.dist-info'), { recursive: true });
    await writeFile(
      join(dir, 'x-1.0.dist-info/entry_points.txt'),
      [
        '[console_scripts]',
        'good = mod:fn',
        'no-colon = mod',
        '../escape = mod:fn',
        'inject = mod:fn; rm -rf /',
      ].join('\n'),
    );
    expect((await discoverBins(dir, 'pypi')).map((bin) => bin.name)).toEqual([
      'good',
    ]);
  });

  it('returns nothing for an ecosystem with no convention yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-other-'));
    temps.push(dir);
    expect(await discoverBins(dir, 'cargo')).toEqual([]);
  });

  it('still finds npm bins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-npm-'));
    temps.push(dir);
    await mkdir(join(dir, 'package'), { recursive: true });
    await writeFile(
      join(dir, 'package/package.json'),
      JSON.stringify({ name: 'demo', bin: { demo: './bin/demo.js' } }),
    );
    const bins = await discoverBins(dir, 'npm');
    expect(bins[0]).toMatchObject({ name: 'demo' });
    // Absent interpreter means Node, so existing lockfiles keep their meaning.
    expect(bins[0]?.interpreter).toBeUndefined();
  });
});

describe('.NET tool discovery', () => {
  const settings = (commands: string) =>
    `<?xml version="1.0" encoding="utf-8"?>\n<DotNetCliTool Version="1">\n<Commands>\n${commands}\n</Commands>\n</DotNetCliTool>\n`;

  it('reads commands from DotnetToolSettings.xml', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-nupkg-'));
    temps.push(dir);
    const toolDir = join(dir, 'tools/netcoreapp2.1/any');
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, 'DotnetToolSettings.xml'),
      settings(
        '<Command Name="dotnetsay" EntryPoint="dotnetsay.dll" Runner="dotnet" />',
      ),
    );
    expect(await discoverBins(dir, 'nuget')).toEqual([
      {
        name: 'dotnetsay',
        path: 'tools/netcoreapp2.1/any/dotnetsay.dll',
        interpreter: 'dotnet',
      },
    ]);
  });

  it('picks one TFM per command, not one entry per framework folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-nupkg-tfm-'));
    temps.push(dir);
    for (const tfm of ['net8.0', 'net9.0', 'net10.0']) {
      const toolDir = join(dir, `tools/${tfm}/any`);
      await mkdir(toolDir, { recursive: true });
      await writeFile(
        join(toolDir, 'DotnetToolSettings.xml'),
        settings(
          `<Command Name="tool" EntryPoint="tool.dll" Runner="dotnet" />`,
        ),
      );
    }
    const bins = await discoverBins(dir, 'nuget');
    // One command, not three — multi-target tools used to look ambiguous.
    expect(bins.map((bin) => bin.name)).toEqual(['tool']);
    // Prefer the highest TFM the host can load (net8 on this machine when 8
    // is installed; net10 only if the host has 10).
    expect(bins[0]?.path).toMatch(/tools\/net\d+\.0\/any\/tool\.dll$/u);
  });

  it('skips a runner it cannot launch rather than emitting a command that fails later', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-nupkg-'));
    temps.push(dir);
    const toolDir = join(dir, 'tools/net8.0/any');
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, 'DotnetToolSettings.xml'),
      settings(
        '<Command Name="native" EntryPoint="native.dll" Runner="executable" />',
      ),
    );
    expect(await discoverBins(dir, 'nuget')).toEqual([]);
  });

  it('refuses names and entry points that are not what they claim to be', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opm-nupkg-'));
    temps.push(dir);
    const toolDir = join(dir, 'tools/net8.0/any');
    await mkdir(toolDir, { recursive: true });
    await writeFile(
      join(toolDir, 'DotnetToolSettings.xml'),
      settings(
        [
          '<Command Name="../escape" EntryPoint="x.dll" Runner="dotnet" />',
          '<Command Name="ok" EntryPoint="../../etc/passwd" Runner="dotnet" />',
          '<Command Name="good" EntryPoint="good.dll" Runner="dotnet" />',
        ].join('\n'),
      ),
    );
    expect((await discoverBins(dir, 'nuget')).map((bin) => bin.name)).toEqual([
      'good',
    ]);
  });
});

describe('Windows-hostile names are refused on every platform', () => {
  it('refuses reserved device names as aliases and bin names', () => {
    // CON, NUL and friends are devices at every directory level and stay
    // devices with an extension. A bin shim written as CON.cmd on Windows
    // writes to the console.
    for (const name of ['CON', 'con', 'nul', 'AUX', 'COM1', 'LPT9', 'CON.cmd'])
      expect(() => assertSafeSegment(name, 'bin name'), name).toThrow(
        /reserved Windows device/u,
      );
  });

  it('refuses a trailing dot, which Windows strips into a collision', () => {
    expect(() => assertSafeSegment('demo.', 'package alias')).toThrow(
      /collide with "demo"/u,
    );
  });

  it('still accepts names that merely start with a device name', () => {
    // "console" and "context" are ordinary; a check that rejected them would
    // be unusable.
    for (const name of ['console', 'context', 'aux-helper', 'com', 'nullable'])
      expect(assertSafeSegment(name, 'bin name'), name).toBe(name);
  });
});

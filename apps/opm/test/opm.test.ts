import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNativeBackend,
  findTrustedSandboxHelper,
} from '@openpacker/sandbox';
import { runOpm } from '../src/opm.js';
import { runOpmx } from '../src/opmx.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureCatalog = join(repoRoot, 'fixtures/opm/catalog.json');
const fixtureTgz = join(repoRoot, 'fixtures/opm/demo-tool-1.1.0.tgz');

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function capture() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (s: string) => ((out += s), true) },
      stderr: { write: (s: string) => ((err += s), true) },
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

describe('opm + opmx CLI', () => {
  it('prints the exact delegated pack plan without executing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-cli-pack-'));
    temps.push(root);
    let cap = capture();
    expect(await runOpm(['init', '--name', 'cli-pack'], cap.io, root)).toBe(0);
    await writeFile(join(root, 'acme.pack'), 'project\n');
    const executable = join(root, 'acme-pack');
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o755);
    await writeFile(
      join(root, 'provider.json'),
      JSON.stringify({
        delegatedPackProviderVersion: '2',
        id: 'example-acme',
        purlTypes: ['acme'],
        detection: { manifestNames: ['acme.pack'] },
        executable: 'node',
        commands: [
          {
            arguments: ['acme-pack.js', '--out', '{outputDirectory}'],
          },
        ],
        identityCommand: {
          arguments: ['identify', '--artifact', '{artifactPath}'],
        },
        authority: { build: false, network: 'never', environment: [] },
        artifacts: [
          {
            suffix: '.acme',
            mediaType: 'application/x-acme',
            nativeRole: 'distribution',
          },
        ],
      }),
    );
    await writeFile(
      join(root, 'provider-default.json'),
      JSON.stringify({
        delegatedPackProviderVersion: '2',
        id: 'example-default',
        purlTypes: ['acme'],
        detection: { manifestNames: ['acme.pack'] },
        executable: 'node',
        commands: [
          {
            arguments: ['default-pack.js', '--out', '{outputDirectory}'],
          },
        ],
        identityCommand: {
          arguments: ['identify', '--artifact', '{artifactPath}'],
        },
        authority: { build: false, network: 'never', environment: [] },
        artifacts: [
          {
            suffix: '.acme',
            mediaType: 'application/x-acme',
            nativeRole: 'distribution',
          },
        ],
      }),
    );
    await writeFile(
      join(root, 'opm.toml'),
      `${await readFile(join(root, 'opm.toml'), 'utf8')}\n[pack.providers.example-default]\nmanifest = "provider-default.json"\nexecutable = ${JSON.stringify(executable)}\ndefault_for = ["acme"]\n\n[pack.providers.example-acme]\nmanifest = "provider.json"\nexecutable = ${JSON.stringify(executable)}\n`,
    );

    for (const selection of [['--provider'], ['--provider=']]) {
      cap = capture();
      const exitCode = await runOpm(
        [
          'pack',
          'acme',
          '--package-version',
          '1.0.0',
          ...selection,
          '--dry-run',
        ],
        cap.io,
        root,
      );
      expect(exitCode, cap.err).toBe(2);
      expect(cap.err).toContain('--provider requires a provider id');
    }

    cap = capture();
    expect(
      await runOpm(
        [
          'pack',
          'acme',
          '--package-version',
          '1.0.0',
          '--provider',
          'example-acme',
          '--dry-run',
          '--offline',
        ],
        cap.io,
        root,
      ),
    ).toBe(0);
    expect(cap.out).toContain(`${executable} acme-pack.js`);
    expect(cap.out).not.toContain('default-pack.js');
    expect(cap.out).toContain('--out');
    await expect(
      readFile(join(root, '.opm', 'pack', 'opm-pack-receipt.json')),
    ).rejects.toThrow();
  });

  it('refuses to guess a pack target version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-cli-pack-version-'));
    temps.push(root);
    const cap = capture();
    expect(await runOpm(['init', '--name', 'cli-pack'], cap.io, root)).toBe(0);
    await writeFile(
      join(root, 'package.json'),
      '{"name":"cli-pack","version":"1.2.3"}\n',
    );
    expect(await runOpm(['pack', 'npm'], cap.io, root)).toBe(2);
    expect(cap.err).toContain('requires --package-version');
    expect(cap.err).not.toContain('0.0.0');
  });

  it('packs standard native bytes and a receipt without npm on PATH', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-cli-standard-pack-'));
    temps.push(root);
    let cap = capture();
    expect(await runOpm(['init', '--name', 'cli-pack'], cap.io, root)).toBe(0);
    await writeFile(
      join(root, 'package.json'),
      '{"name":"cli-pack","version":"1.0.0"}\n',
    );
    cap = capture();
    expect(
      await runOpm(['pack', 'npm', '--package-version', '1.0.0'], cap.io, root),
    ).toBe(0);
    expect(cap.out).toContain('cli-pack-1.0.0.tgz');
    expect(cap.out).toContain('opm-pack-receipt.json');
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const receipt = JSON.parse(
      await readFile(
        join(root, '.opm', 'pack', 'opm-pack-receipt.json'),
        'utf8',
      ),
    ) as { strategy: string; artifacts: unknown[] };
    expect(receipt.strategy).toBe('standard');
    expect(receipt.artifacts).toHaveLength(1);
  });

  it('init add install list opmx remove', { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-cli-'));
    temps.push(root);

    let cap = capture();
    expect(await runOpm(['init', '--name', 'cli-demo'], cap.io, root)).toBe(0);

    // local catalog with absolute file source
    await mkdir(join(root, '.opm'), { recursive: true });
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const catalog = JSON.parse(await readFile(fixtureCatalog, 'utf8')) as {
      packages: Record<string, { source: string }>;
    };
    for (const entry of Object.values(catalog.packages)) {
      entry.source = `file:${fixtureTgz}`;
    }
    await writeFile(
      join(root, '.opm/catalog.json'),
      `${JSON.stringify(catalog, null, 2)}\n`,
    );

    cap = capture();
    const addExit = await runOpm(
      ['add', 'pkg:npm/@openpacker/demo-tool@1.1.0', '--offline'],
      cap.io,
      root,
    );
    expect(addExit, cap.err).toBe(0);
    expect(cap.out).toMatch(/Added demo-tool/);

    const statePath = join(root, '.opm/project.json');
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const forgedState = JSON.parse(await readFile(statePath, 'utf8')) as {
      packages: Record<
        string,
        { purl: string; storePath: string; bins: { target?: string }[] }
      >;
    };
    forgedState.packages['demo-tool']!.purl = 'pkg:npm/attacker@9.9.9';
    await writeFile(statePath, JSON.stringify(forgedState));

    cap = capture();
    expect(await runOpm(['list'], cap.io, root)).toBe(0);
    expect(cap.out).toMatch(/demo-tool/);
    expect(cap.out).toMatch(/installed/);

    cap = capture();
    const versionExit = await runOpmx(['demo-tool', '--version'], cap.io, root);
    if (cap.err.includes('sandbox was not enforced')) {
      expect(versionExit).toBe(6);
      return;
    }
    expect(versionExit, cap.err).toBe(0);
    expect(cap.out).toMatch(/1\.1\.0/);
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const repairedState = JSON.parse(await readFile(statePath, 'utf8')) as {
      packages: Record<
        string,
        { purl: string; storePath: string; bins: { target?: string }[] }
      >;
    };
    // The lock's one spelling of the scope, though the add typed `@`.
    expect(repairedState.packages['demo-tool']?.purl).toBe(
      'pkg:npm/%40openpacker/demo-tool@1.1.0',
    );

    const toolPath = repairedState.packages['demo-tool']!.bins[0]!.target!;
    const toolBytes = await readFile(toolPath);
    await writeFile(
      toolPath,
      Buffer.concat([toolBytes, Buffer.from('\n# tampered')]),
    );
    cap = capture();
    // A tampered store entry is a verification failure (7), matching opm.
    expect(await runOpmx(['demo-tool'], cap.io, root)).toBe(7);
    expect(cap.err).toMatch(/store tree does not match/u);
    await writeFile(toolPath, toolBytes);

    cap = capture();
    expect(await runOpmx(['demo-tool', 'hello'], cap.io, root)).toBe(0);
    expect(cap.out).toMatch(/demo-tool ok hello/);

    cap = capture();
    expect(await runOpm(['sync', '--offline'], cap.io, root)).toBe(0);

    cap = capture();
    expect(await runOpm(['remove', 'demo-tool'], cap.io, root)).toBe(0);

    cap = capture();
    expect(await runOpmx(['demo-tool'], cap.io, root)).toBe(4);
    expect(cap.err).toMatch(/No packages installed/);
  });

  it('preserves committed offline mode without a CLI flag', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-cli-offline-'));
    temps.push(root);
    let cap = capture();
    expect(await runOpm(['init', '--name', 'cli-demo'], cap.io, root)).toBe(0);
    const manifestPath = join(root, 'opm.toml');
    await writeFile(
      manifestPath,
      (await readFile(manifestPath, 'utf8')).replace(
        'offline = false',
        'offline = true',
      ),
    );
    cap = capture();
    expect(
      await runOpm(
        [
          'add',
          'pkg:npm/@openpacker/demo-tool@1.1.0',
          '--source',
          'https://registry.example.invalid/demo.tgz',
        ],
        cap.io,
        root,
      ),
    ).toBe(8);
    expect(cap.err).toMatch(/offline/i);
  });

  it('exits 5 when nothing can resolve a spec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-cli-unres-'));
    temps.push(root);
    let cap = capture();
    expect(await runOpm(['init', '--name', 'cli-demo'], cap.io, root)).toBe(0);
    cap = capture();
    expect(
      await runOpm(
        ['add', 'pkg:npm/@openpacker/not-in-any-catalog@9.9.9', '--offline'],
        cap.io,
        root,
      ),
    ).toBe(5);
    expect(cap.err).toMatch(/Cannot resolve/);
  });

  it('exposes generations, rollback, gc, and shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-gen-'));
    temps.push(root);
    let cap = capture();
    expect(await runOpm(['init', '--name', 'gen-demo'], cap.io, root)).toBe(0);

    await mkdir(join(root, '.opm'), { recursive: true });
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const catalog = JSON.parse(await readFile(fixtureCatalog, 'utf8')) as {
      packages: Record<string, { source: string }>;
    };
    for (const entry of Object.values(catalog.packages))
      entry.source = `file:${fixtureTgz}`;
    await writeFile(
      join(root, '.opm/catalog.json'),
      `${JSON.stringify(catalog, null, 2)}\n`,
    );

    cap = capture();
    const addExit = await runOpm(
      ['add', 'pkg:npm/@openpacker/demo-tool@1.1.0', '--offline'],
      cap.io,
      root,
    );
    expect(addExit, cap.err).toBe(0);

    // One install, one generation, and it is current.
    cap = capture();
    expect(await runOpm(['generations'], cap.io, root)).toBe(0);
    expect(cap.out).toMatch(/\*\s+1\t/);

    cap = capture();
    expect(await runOpm(['remove', 'demo-tool'], cap.io, root)).toBe(0);
    cap = capture();
    expect(await runOpm(['generations'], cap.io, root)).toBe(0);
    expect(cap.out).toMatch(/\*\s+2\t/);

    // Rollback moves the pointer back without deleting history.
    cap = capture();
    expect(await runOpm(['rollback', '--offline'], cap.io, root)).toBe(0);
    expect(cap.out).toMatch(/Rolled back to generation 1/);
    cap = capture();
    expect(await runOpm(['generations'], cap.io, root)).toBe(0);
    expect(cap.out).toMatch(/\*\s+1\t/);
    expect(cap.out).toMatch(/\s+2\t/);

    // A dry-run gc reports without removing.
    cap = capture();
    expect(await runOpm(['gc', '--dry-run'], cap.io, root)).toBe(0);
    expect(cap.out).toMatch(/Would remove/);

    // The shell environment is derived, and composable with eval.
    cap = capture();
    expect(await runOpm(['shell'], cap.io, root)).toBe(0);
    expect(cap.out).toMatch(/export OPM_BIN=/);
    expect(cap.out).toMatch(/export PATH=/);
    cap = capture();
    expect(await runOpm(['shell', '--json'], cap.io, root)).toBe(0);
    expect(JSON.parse(cap.out).OPM_GENERATION).toBe('1');
  }, 30_000);

  it('refuses to roll back with no earlier generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opm-gen-none-'));
    temps.push(root);
    let cap = capture();
    expect(await runOpm(['init', '--name', 'gen-demo'], cap.io, root)).toBe(0);
    cap = capture();
    // Exit 4 is not-found: there is no earlier state to return to.
    expect(await runOpm(['rollback'], cap.io, root)).toBe(4);
  });
});

describe('opmx argument forwarding', () => {
  it('does not forward the -- separator to the tool', async () => {
    // `opmx tool -- -t x` was handing the tool a literal "--", which any
    // argument parser reads as end-of-options and then fails on what follows.
    const { parseForTest } = await import('../src/opmx.js');
    expect(parseForTest(['tool', '--', '-t', 'x']).passthrough).toEqual([
      '-t',
      'x',
    ]);
    // A later `--` is the tool's own argument and must survive.
    expect(parseForTest(['tool', '-a', '--', '-b']).passthrough).toEqual([
      '-a',
      '--',
      '-b',
    ]);
  });

  it('parses --plugin, --allow-env and --offline ahead of the selector', async () => {
    const { parseForTest } = await import('../src/opmx.js');
    const parsed = parseForTest([
      '--plugin',
      'acme',
      '--plugin=globex',
      '--allow-env',
      'ACME_TOKEN',
      '--offline',
      'pkg:acme/demo',
      '--version',
    ]);
    expect(parsed.plugins).toEqual(['acme', 'globex']);
    expect(parsed.allowEnv).toEqual(['ACME_TOKEN']);
    expect(parsed.offline).toBe(true);
    expect(parsed.positionals).toEqual(['pkg:acme/demo']);
    // The tool's own flags stay the tool's.
    expect(parsed.passthrough).toEqual(['--version']);
    // Defaults: no plugins, online.
    const plain = parseForTest(['demo-tool']);
    expect(plain.plugins).toEqual([]);
    expect(plain.allowEnv).toEqual([]);
    expect(plain.offline).toBe(false);
  });

  it('refuses a --plugin or --allow-env without a value', async () => {
    const { parseForTest } = await import('../src/opmx.js');
    // A trailing flag is a malformed invocation, not a silently dropped one.
    expect(() => parseForTest(['--plugin'])).toThrow(/requires a plugin name/u);
    expect(() => parseForTest(['--allow-env'])).toThrow(
      /requires an environment variable name/u,
    );
    // Another flag is never consumed as the value.
    expect(() => parseForTest(['--plugin', '--offline', 'demo'])).toThrow(
      /requires a plugin name/u,
    );
    expect(() => parseForTest(['--plugin='])).toThrow(
      /requires a plugin name/u,
    );
  });
});

const nativeBackend = createNativeBackend();
const bwrapReady =
  process.platform === 'linux' &&
  findTrustedSandboxHelper('bwrap') !== undefined &&
  nativeBackend?.id === 'native-bwrap';

describe('opmx --plugin', () => {
  const PLUGIN_ENV = ['OPM_PLUGIN_HOME'] as const;

  function withPluginHome(home: string): () => void {
    const previous = PLUGIN_ENV.map(
      (name) => [name, process.env[name]] as const,
    );
    process.env.OPM_PLUGIN_HOME = home;
    return () => {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    };
  }

  it('refuses a plugin that is not installed instead of acquiring one', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opmx-plugin-'));
    temps.push(home);
    const restore = withPluginHome(home);
    try {
      const cap = capture();
      expect(
        await runOpmx(['--plugin', 'ghost', 'pkg:acme/demo'], cap.io, home),
      ).toBe(4);
      expect(cap.err).toMatch(/Plugin "ghost" is not installed/);
      expect(cap.err).toMatch(/opm plugin add ghost/);
    } finally {
      restore();
    }
  });

  it('refuses an ephemeral resolve in offline mode', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opmx-plugin-'));
    temps.push(home);
    const restore = withPluginHome(home);
    try {
      const { seedPluginStore } = await import('./plugin-fixture.js');
      await seedPluginStore(home);
      const cap = capture();
      expect(
        await runOpmx(
          ['--offline', '--plugin', 'acme', 'pkg:acme/demo'],
          cap.io,
          home,
        ),
      ).toBe(8);
      expect(cap.err).toMatch(/offline/i);
    } finally {
      restore();
    }
  });

  // End to end: the plugin declares a native tool, the host downloads and
  // verifies the bytes, and opmx runs the verified store file through the
  // sandbox — the full ADR 0040 loop. The plugin runs for real: immutable
  // snapshot, fail-closed jail, bounded stdio protocol. Skipped where no
  // sandbox backend can be enforced.
  it('acquires and runs a plugin-served native tool', async () => {
    if (!bwrapReady) return;
    const home = await mkdtemp(join(tmpdir(), 'opmx-plugin-'));
    const cache = await mkdtemp(join(tmpdir(), 'opmx-cache-'));
    temps.push(home, cache);
    const restore = withPluginHome(home);
    const previousCache = process.env.OPM_TOOL_CACHE;
    process.env.OPM_TOOL_CACHE = cache;
    const { acmeToolFetch, seedPluginStore } = await import(
      './plugin-fixture.js'
    );
    let fetches = 0;
    const serve = acmeToolFetch();
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    vi.stubGlobal('fetch', (async (input: URL | Request | string) => {
      if (
        String(input) === 'https://acme.fixture.test/artifacts/demo-1.0.0.tar'
      )
        fetches += 1;
      return serve(input);
    }) as typeof fetch);
    try {
      await seedPluginStore(home);
      let cap = capture();
      // Without the plugin the purl type has no adapter at all.
      expect(await runOpmx(['pkg:acme/demo'], cap.io, home)).not.toBe(0);
      expect(cap.err).toMatch(/no adapter is registered/i);

      // The plugin answered registry-definition/enumerate/inspect over the
      // protocol; the host fetched the published bytes, digest-verified them,
      // materialized the tool, and ran it.
      cap = capture();
      const exit = await runOpmx(['--plugin', 'acme', 'demo'], cap.io, home);
      expect(exit, cap.err).toBe(0);
      expect(cap.err).toMatch(/pkg:acme\/demo@1\.0\.0/);
      expect(cap.err).not.toMatch(/\(cached\)/);
      expect(cap.out).toBe('acme-demo-ran\n');
      expect(fetches).toBe(1);

      // A repeat run re-resolves the registry metadata (an unpinned run is a
      // different thing tomorrow), but the resolved digest already names a
      // content-addressed cache entry, so the bytes do not move again and the
      // run reports the cache hit.
      cap = capture();
      expect(
        await runOpmx(['--plugin', 'acme', 'demo'], cap.io, home),
        cap.err,
      ).toBe(0);
      expect(cap.err).toMatch(/pkg:acme\/demo@1\.0\.0 \(cached\)/);
      expect(cap.out).toBe('acme-demo-ran\n');
      expect(fetches).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      restore();
      if (previousCache === undefined) delete process.env.OPM_TOOL_CACHE;
      else process.env.OPM_TOOL_CACHE = previousCache;
    }
  }, 30_000);

  // The same loop must fail closed: bytes that digest differently from what
  // the plugin published are a verification failure, and nothing executes.
  it('refuses to run when the served bytes digest differently', async () => {
    if (!bwrapReady) return;
    const home = await mkdtemp(join(tmpdir(), 'opmx-plugin-'));
    const cache = await mkdtemp(join(tmpdir(), 'opmx-cache-'));
    temps.push(home, cache);
    const restore = withPluginHome(home);
    const previousCache = process.env.OPM_TOOL_CACHE;
    process.env.OPM_TOOL_CACHE = cache;
    const { ACME_TOOL_TAR, acmeToolFetch, seedPluginStore } = await import(
      './plugin-fixture.js'
    );
    // Same length as the published tar (so size checks pass), different bytes.
    const tampered = new Uint8Array(ACME_TOOL_TAR);
    tampered[512] = tampered[512]! ^ 0xff;
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    vi.stubGlobal('fetch', acmeToolFetch(tampered) as typeof fetch);
    try {
      await seedPluginStore(home);
      const cap = capture();
      const exit = await runOpmx(['--plugin', 'acme', 'demo'], cap.io, home);
      expect(exit, cap.err).toBe(7);
      expect(cap.err).toMatch(/digest mismatch/i);
      expect(cap.out).toBe('');
    } finally {
      vi.unstubAllGlobals();
      restore();
      if (previousCache === undefined) delete process.env.OPM_TOOL_CACHE;
      else process.env.OPM_TOOL_CACHE = previousCache;
    }
  }, 30_000);
});

describe('opm plugin', () => {
  const PLUGIN_ENV = ['OPM_PLUGIN_HOME', 'OPM_REGISTRY_OPM_PLUGIN'] as const;

  function withPluginEnv(home: string): () => void {
    const previous = PLUGIN_ENV.map(
      (name) => [name, process.env[name]] as const,
    );
    process.env.OPM_PLUGIN_HOME = home;
    delete process.env.OPM_REGISTRY_OPM_PLUGIN;
    return () => {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    };
  }

  it('rejects unknown plugin subcommands with usage', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opm-plugin-cli-'));
    temps.push(home);
    const restore = withPluginEnv(home);
    try {
      let cap = capture();
      expect(await runOpm(['plugin'], cap.io, home)).toBe(2);
      expect(cap.err).toMatch(/Unknown plugin subcommand/);
      cap = capture();
      expect(await runOpm(['plugin', 'frobnicate'], cap.io, home)).toBe(2);
      expect(cap.err).toMatch(/add \| remove \| list/);
    } finally {
      restore();
    }
  });

  it('fails closed when no plugin registry is configured', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opm-plugin-cli-'));
    temps.push(home);
    const restore = withPluginEnv(home);
    try {
      const cap = capture();
      expect(await runOpm(['plugin', 'add', 'acme'], cap.io, home)).toBe(8);
      expect(cap.err).toMatch(/OPM_REGISTRY_OPM_PLUGIN/);
    } finally {
      restore();
    }
  });

  it('maps provider errors to honest exit codes instead of internal', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opm-plugin-cli-'));
    temps.push(home);
    const restore = withPluginEnv(home);
    try {
      // The CLI acquires through the configured registry. Production pins and
      // dials real addresses, so the fixture registry, which knows only the
      // plugin "acme", is handed in as the fetch the CLI uses.
      const { fixturePluginTransport } = await import('./plugin-fixture.js');
      const transport = fixturePluginTransport();
      const fixtureFetch: typeof fetch = async (input) => {
        try {
          const response = await transport.request({
            url: String(input),
            method: 'GET',
            headers: {},
          });
          return new Response(new Uint8Array(response.body), {
            status: response.status,
            headers: response.headers,
          });
        } catch {
          return new Response('not found', { status: 404 });
        }
      };
      process.env.OPM_REGISTRY_OPM_PLUGIN = 'https://plugins.fixture.test';
      const cap = capture();
      // Unknown plugin: the registry answers 404, the provider throws
      // ProviderError PACKAGE_NOT_FOUND — not-found (4), not internal (9).
      expect(
        await runOpm(['plugin', 'add', 'ghost'], cap.io, home, {
          fetch: fixtureFetch,
        }),
      ).toBe(4);
      expect(cap.err).toMatch(/not found/iu);
      expect(cap.err).not.toMatch(/internal error/u);
    } finally {
      restore();
    }
  });

  it('lists an empty store honestly', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opm-plugin-cli-'));
    temps.push(home);
    const restore = withPluginEnv(home);
    try {
      const cap = capture();
      expect(await runOpm(['plugin', 'list'], cap.io, home)).toBe(0);
      expect(cap.out).toBe('(no plugins installed)\n');
    } finally {
      restore();
    }
  });

  it('adds (idempotently), lists, and removes a seeded plugin', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opm-plugin-cli-'));
    temps.push(home);
    const restore = withPluginEnv(home);
    try {
      // Seed the user-level store through the store API against a fixture
      // registry; the CLI flows under test are the pin-driven ones.
      const { addPlugin } = await import('@openpacker/plugin-store');
      const { configureAdapters } = await import('@openpacker/opm-project');
      const { fixturePluginTransport } = await import('./plugin-fixture.js');
      configureAdapters([]);
      const seeded = await addPlugin({
        name: 'acme',
        endpoint: 'https://plugins.fixture.test',
        transport: fixturePluginTransport(),
        storeRoot: home,
        now: () => '2026-08-20T00:00:00.000Z',
      });

      // `plugin add` of the same pin is idempotent and needs no registry.
      let cap = capture();
      expect(await runOpm(['plugin', 'add', 'acme'], cap.io, home)).toBe(0);
      expect(cap.out).toMatch(
        /already installed at pkg:opm-plugin\/acme@1\.0\.0/,
      );
      expect(cap.out).toMatch(new RegExp(`digest: ${seeded.storeDigest}`));

      cap = capture();
      expect(await runOpm(['plugin', 'list'], cap.io, home)).toBe(0);
      expect(cap.out).toMatch(/^acme\tpkg:opm-plugin\/acme@1\.0\.0\tsha256:/m);

      cap = capture();
      expect(await runOpm(['plugin', 'remove', 'acme'], cap.io, home)).toBe(0);
      expect(cap.out).toMatch(/Removed plugin acme/);

      cap = capture();
      expect(await runOpm(['plugin', 'list'], cap.io, home)).toBe(0);
      expect(cap.out).toBe('(no plugins installed)\n');

      // Removing again is an honest not-found, exit 4.
      cap = capture();
      expect(await runOpm(['plugin', 'remove', 'acme'], cap.io, home)).toBe(4);
      expect(cap.err).toMatch(/not installed/);
    } finally {
      restore();
    }
  });

  it('loads installed plugins silently and reports a tampered entry', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opm-plugin-cli-'));
    temps.push(home);
    const restore = withPluginEnv(home);
    try {
      const { addPlugin } = await import('@openpacker/plugin-store');
      const { configureAdapters } = await import('@openpacker/opm-project');
      const { fixturePluginTransport } = await import('./plugin-fixture.js');
      configureAdapters([]);
      const seeded = await addPlugin({
        name: 'acme',
        endpoint: 'https://plugins.fixture.test',
        transport: fixturePluginTransport(),
        storeRoot: home,
        now: () => '2026-08-20T00:00:00.000Z',
      });

      // An intact plugin registers at startup without a word.
      let cap = capture();
      expect(await runOpm(['plugin', 'list'], cap.io, home)).toBe(0);
      expect(cap.err).toBe('');

      // A tampered store entry fails closed: the plugin is not loaded, the
      // refusal is reported, and the CLI keeps working so the store can be
      // repaired.
      await writeFile(join(seeded.storePath, 'plugin.json'), '{}\n');
      cap = capture();
      expect(await runOpm(['plugin', 'list'], cap.io, home)).toBe(0);
      expect(cap.err).toMatch(/plugin acme was not loaded/);
      expect(cap.err).toMatch(/DIGEST_MISMATCH|digest/iu);
      expect(cap.out).toMatch(/^acme\tpkg:opm-plugin\/acme@1\.0\.0/m);
    } finally {
      restore();
    }
  });
});

describe('project plugin bindings', () => {
  it('mentions artifact_origins in help', async () => {
    const cap = capture();
    expect(await runOpm(['--help'], cap.io, process.cwd())).toBe(0);
    expect(cap.out).toMatch(/artifact_origins/);
    expect(cap.out).toMatch(/artifact_origin_token_envs/);
    expect(cap.out).toMatch(/OPM_HOST_FETCH_TOKEN_ENVS/);
    expect(cap.out).toMatch(/artifact_origin_extra_header_names/);
    expect(cap.out).toMatch(/OPM_HOST_FETCH_HEADER_NAMES/);
  });

  function withPluginHome(home: string): () => void {
    const previous = process.env.OPM_PLUGIN_HOME;
    process.env.OPM_PLUGIN_HOME = home;
    return () => {
      if (previous === undefined) delete process.env.OPM_PLUGIN_HOME;
      else process.env.OPM_PLUGIN_HOME = previous;
    };
  }

  async function boundProject(storeDigest: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'opm-bound-'));
    temps.push(root);
    const cap = capture();
    expect(await runOpm(['init', '--name', 'bound-demo'], cap.io, root)).toBe(
      0,
    );
    await writeFile(
      join(root, 'opm.toml'),
      `${await readFile(join(root, 'opm.toml'), 'utf8')}\n[plugins.dev.example.acme-adapter]\nstore_digest = "${storeDigest}"\nartifact_origins = ["https://artifacts.internal.example"]\n`,
    );
    return root;
  }

  it('verifies the binding and lets project commands proceed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opm-bound-store-'));
    temps.push(home);
    const restore = withPluginHome(home);
    try {
      const { seedPluginStore } = await import('./plugin-fixture.js');
      const seeded = await seedPluginStore(home);
      const root = await boundProject(seeded.storeDigest);
      const cap = capture();
      // sync re-resolves the (empty) manifest; the bound plugin is verified
      // and registered first, offline and without any acquisition.
      expect(await runOpm(['sync', '--offline'], cap.io, root), cap.err).toBe(
        0,
      );
    } finally {
      restore();
    }
  });

  it('fails closed when the installed entry digests differently', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opm-bound-store-'));
    temps.push(home);
    const restore = withPluginHome(home);
    try {
      const { seedPluginStore } = await import('./plugin-fixture.js');
      await seedPluginStore(home);
      const root = await boundProject(`sha256:${'b'.repeat(64)}`);
      const cap = capture();
      expect(await runOpm(['sync', '--offline'], cap.io, root)).toBe(7);
      expect(cap.err).toMatch(/binds plugin "dev\.example\.acme-adapter"/);
      expect(cap.err).toMatch(/sha256:b{64}/);
      // remove mutates the manifest and lock, so it verifies the binding too.
      expect(await runOpm(['remove', 'demo-tool'], cap.io, root)).toBe(7);
    } finally {
      restore();
    }
  });

  it('refuses a binding to a plugin that is not installed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'opm-bound-store-'));
    temps.push(home);
    const restore = withPluginHome(home);
    try {
      // A store exists but holds no plugin; the binding must not acquire one.
      const root = await boundProject(`sha256:${'b'.repeat(64)}`);
      const cap = capture();
      expect(await runOpm(['sync', '--offline'], cap.io, root)).toBe(4);
      expect(cap.err).toMatch(/not installed/);
      expect(cap.err).toMatch(/never acquires/);
    } finally {
      restore();
    }
  });

  it('serves the bound purl type through the plugin', async () => {
    if (!bwrapReady) return;
    const home = await mkdtemp(join(tmpdir(), 'opm-bound-store-'));
    temps.push(home);
    const restore = withPluginHome(home);
    try {
      const { seedPluginStore } = await import('./plugin-fixture.js');
      const seeded = await seedPluginStore(home);
      const root = await boundProject(seeded.storeDigest);
      const cap = capture();
      expect(
        await runOpm(['versions', 'pkg:acme/demo'], cap.io, root),
        cap.err,
      ).toBe(0);
      expect(cap.out).toContain('pkg:acme/demo@1.0.0');
    } finally {
      restore();
    }
  }, 30_000);

  // The project path runs the same ADR 0040 acquisition loop as opmx
  // --plugin: add resolves through the bound plugin, the host fetches and
  // verifies the published bytes, and the declared native bin lands in the
  // lock, the project state, and .opm/bin — and opmx runs it.
  it('adds, installs, and runs a plugin-served tool in a bound project', async () => {
    if (!bwrapReady) return;
    const home = await mkdtemp(join(tmpdir(), 'opm-bound-store-'));
    temps.push(home);
    const restore = withPluginHome(home);
    const { acmeToolFetch, seedPluginStore } = await import(
      './plugin-fixture.js'
    );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    vi.stubGlobal('fetch', acmeToolFetch() as typeof fetch);
    try {
      const seeded = await seedPluginStore(home);
      const root = await boundProject(seeded.storeDigest);
      // The project allowlist must name the plugin's purl type.
      const manifestPath = join(root, 'opm.toml');
      await writeFile(
        manifestPath,
        (await readFile(manifestPath, 'utf8')).replace(
          'ecosystems = ["npm", "cargo", "pypi"]',
          'ecosystems = ["npm", "cargo", "pypi", "acme"]',
        ),
      );

      const cap = capture();
      expect(
        await runOpm(['add', 'pkg:acme/demo@1.0.0'], cap.io, root),
        cap.err,
      ).toBe(0);
      expect(cap.out).toMatch(/Added demo → pkg:acme\/demo@1\.0\.0/);

      // The inspection-declared executable is pinned into the lock and
      // materialized into the install: the shim exists and points at the
      // verified store file.
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const lock = JSON.parse(
        await readFile(join(root, 'opm.lock.json'), 'utf8'),
      ) as {
        packages: Record<string, { bins?: { name: string; path: string }[] }>;
      };
      expect(lock.packages['demo']?.bins).toEqual([
        { name: 'acme-demo', path: 'bin/acme-demo', interpreter: 'native' },
      ]);
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const state = JSON.parse(
        await readFile(join(root, '.opm/project.json'), 'utf8'),
      ) as {
        packages: Record<
          string,
          { bins: { name: string; shim: string; target: string }[] }
        >;
      };
      const bin = state.packages['demo']?.bins[0];
      expect(bin?.name).toBe('acme-demo');
      await readFile(join(root, '.opm/bin/acme-demo'));

      // The declared bin survives generation activation: opmx re-activates
      // before resolving, and the member now carries the bins its install
      // pinned instead of re-deriving nothing from the store tree.
      let run = capture();
      expect(await runOpmx(['acme-demo'], run.io, root), run.err).toBe(0);
      expect(run.out).toBe('acme-demo-ran\n');

      run = capture();
      expect(
        await runOpmx(
          ['--package', 'demo', '--bin', 'acme-demo'],
          run.io,
          root,
        ),
        run.err,
      ).toBe(0);
      expect(run.out).toBe('acme-demo-ran\n');
    } finally {
      vi.unstubAllGlobals();
      restore();
    }
  }, 30_000);
});

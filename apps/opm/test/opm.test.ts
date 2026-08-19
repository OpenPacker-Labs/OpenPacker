import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
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
      `${await readFile(join(root, 'opm.toml'), 'utf8')}\n[pack.providers.example-default]\nmanifest = "provider-default.json"\ndefault_for = ["acme"]\n\n[pack.providers.example-acme]\nmanifest = "provider.json"\n`,
    );

    for (const selection of [['--provider'], ['--provider=']]) {
      cap = capture();
      expect(
        await runOpm(
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
        ),
      ).toBe(2);
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
    expect(cap.out).toContain('node acme-pack.js');
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
    expect(
      await runOpm(
        ['add', 'pkg:npm/@openpacker/demo-tool@1.1.0', '--offline'],
        cap.io,
        root,
      ),
    ).toBe(0);
    expect(cap.out).toMatch(/Added demo-tool/);

    const statePath = join(root, '.opm/project.json');
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
    expect(await runOpmx(['demo-tool', '--version'], cap.io, root)).toBe(0);
    expect(cap.out).toMatch(/1\.1\.0/);
    const repairedState = JSON.parse(await readFile(statePath, 'utf8')) as {
      packages: Record<
        string,
        { purl: string; storePath: string; bins: { target?: string }[] }
      >;
    };
    expect(repairedState.packages['demo-tool']?.purl).toBe(
      'pkg:npm/@openpacker/demo-tool@1.1.0',
    );

    const toolPath = repairedState.packages['demo-tool']!.bins[0]!.target!;
    const toolBytes = await readFile(toolPath);
    await writeFile(
      toolPath,
      Buffer.concat([toolBytes, Buffer.from('\n# tampered')]),
    );
    cap = capture();
    expect(await runOpmx(['demo-tool'], cap.io, root)).toBe(9);
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
    expect(
      await runOpm(
        ['add', 'pkg:npm/@openpacker/demo-tool@1.1.0', '--offline'],
        cap.io,
        root,
      ),
    ).toBe(0);

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
  });

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
});

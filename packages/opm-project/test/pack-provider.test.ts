import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdapterRegistry, setAdapterRegistry } from '@openpacker/adapter-host';
import type { RunInSandboxInput, SandboxOutcome } from '@openpacker/sandbox';
import { configurePackProviders } from '../src/pack-providers.js';
import { packProject } from '../src/pack.js';
import type { OpmManifest } from '../src/types.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('configured delegated pack providers', () => {
  it('packs an unknown ecosystem through the host sandbox', async () => {
    const root = await fixture();
    const registry = new AdapterRegistry();
    setAdapterRegistry(registry);
    const outputDirectory = join(root, 'out');
    let call: RunInSandboxInput | undefined;
    const configured = await configurePackProviders({
      root,
      registry,
      manifest: projectManifest(),
      environment: { ACME_TOKEN: 'secret' },
      dependencies: {
        resolveExecutable: async () => '/usr/bin/acme-pack',
        sandboxRun: async (input) => {
          call = input;
          await mkdir(outputDirectory, { recursive: true });
          await writeFile(join(outputDirectory, 'demo.acme'), 'native');
          return outcome();
        },
      },
    });

    const result = await packProject({
      root,
      ecosystem: 'acme',
      strategy: 'delegate',
      name: 'demo',
      version: '1.0.0',
      outputDirectory,
      offline: true,
      allowBuild: true,
      authorizedEnvironment: configured.authorizedEnvironment,
    });

    expect(call?.argv).toEqual([
      '/usr/bin/acme-pack',
      'pack',
      '--out',
      outputDirectory,
    ]);
    expect(call?.grants?.env).toEqual(['ACME_TOKEN']);
    expect(call?.env).toEqual({ ACME_TOKEN: 'secret' });
    expect(result.artifacts.map((artifact) => artifact.nativeRole)).toEqual([
      'distribution',
      'receipt',
    ]);
    expect(result.receipt?.provider).toEqual({
      id: 'example-acme',
      manifestDigest: {
        algorithm: 'sha256',
        value: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
  });

  it('does not treat ambient host secrets as project consent', async () => {
    const root = await fixture();
    vi.stubEnv('ACME_TOKEN', 'ambient-secret');
    const configured = await configurePackProviders({
      root,
      registry: new AdapterRegistry(),
      manifest: projectManifest(),
    });

    expect(configured.authorizedEnvironment['example-acme']).toEqual({});
  });

  it('keeps provider manifests at a direct project-owned path', async () => {
    const root = await fixture();
    const manifest = projectManifest();
    manifest.packProviders!['example-acme']!.manifest = '../provider.json';

    await expect(
      configurePackProviders({
        root,
        manifest,
        registry: new AdapterRegistry(),
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('rejects a configuration key that does not bind the manifest id', async () => {
    const root = await fixture();
    const manifest = projectManifest();
    manifest.packProviders = {
      'example-other': manifest.packProviders!['example-acme']!,
    };

    await expect(
      configurePackProviders({
        root,
        manifest,
        registry: new AdapterRegistry(),
      }),
    ).rejects.toThrow(/does not match manifest id/u);
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-configured-pack-provider-'));
  roots.push(root);
  await writeFile(join(root, 'acme.pack'), 'project');
  await writeFile(
    join(root, 'provider.json'),
    JSON.stringify({
      delegatedPackProviderVersion: '1',
      id: 'example-acme',
      purlTypes: ['acme'],
      detection: { manifestNames: ['acme.pack'] },
      executable: 'acme-pack',
      commands: [
        {
          arguments: ['pack', '--out', '{outputDirectory}'],
        },
      ],
      authority: {
        build: false,
        network: 'never',
        environment: ['ACME_TOKEN'],
      },
      artifacts: [
        {
          suffix: '.acme',
          mediaType: 'application/x-acme',
          nativeRole: 'distribution',
        },
      ],
    }),
  );
  return root;
}

function projectManifest(): OpmManifest {
  return {
    project: { name: 'demo', ecosystems: ['acme'] },
    packages: {},
    packProviders: {
      'example-acme': {
        manifest: 'provider.json',
        defaultFor: ['acme'],
        allowEnvironment: ['ACME_TOKEN'],
      },
    },
    options: { offline: true, layout: 'opm' },
  };
}

function outcome(): SandboxOutcome {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    backend: 'mock',
    profile: 'package-exec',
    enforced: true,
    containmentLimited: false,
    policyDigest: { algorithm: 'sha256', value: '0'.repeat(64) },
    losses: [],
    degraded: false,
  };
}

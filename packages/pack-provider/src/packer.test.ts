import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DelegatedPackProviderManifest } from '@openpacker/contracts';
import type { RunInSandboxInput, SandboxOutcome } from '@openpacker/sandbox';
import { ManifestPackagePacker } from './packer.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('manifest package packer', () => {
  it('compiles the manifest into argv without a shell', async () => {
    const root = await project();
    const packer = configured();
    const plan = await packer.plan(input(root), {
      dryRun: true,
      allowNetwork: true,
      outputDirectory: join(root, 'out'),
    });

    expect(plan.commands).toEqual([
      ['test-pack', 'pack', '--network', '--out', join(root, 'out')],
    ]);
    await expect(
      packer.hostPlan(input(root), {
        allowNetwork: true,
        outputDirectory: join(root, 'out'),
      }),
    ).resolves.toMatchObject({
      executable: 'test-pack',
      commandArguments: [['pack', '--network', '--out', join(root, 'out')]],
    });
    expect(plan.requiresNetwork).toBe(true);
  });

  it('refuses build authority before resolving or running a tool', async () => {
    const root = await project();
    let resolved = false;
    let ran = false;
    const packer = configured(
      { ...manifest(), authority: { ...manifest().authority, build: true } },
      async () => {
        resolved = true;
        return '/usr/bin/test-pack';
      },
      async () => {
        ran = true;
        return outcome();
      },
    );

    await expect(packer.pack(input(root))).rejects.toMatchObject({
      code: 'BUILD_CONSENT_REQUIRED',
    });
    expect(resolved).toBe(false);
    expect(ran).toBe(false);
  });

  it('executes only through the sandbox with explicitly granted environment', async () => {
    const root = await project();
    const outputDirectory = join(root, 'out');
    let call: RunInSandboxInput | undefined;
    const packer = configured(
      manifest(),
      async () => '/usr/bin/test-pack',
      async (input_) => {
        call = input_;
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(join(outputDirectory, 'demo.test'), 'native bytes');
        return outcome();
      },
    );

    const result = await packer.pack(input(root), {
      outputDirectory,
      authorizedEnvironment: { TEST_TOKEN: 'secret' },
    });

    expect(call?.argv).toEqual([
      'test-pack',
      'pack',
      '--offline',
      '--out',
      outputDirectory,
    ]);
    expect(call?.env).toEqual({ TEST_MODE: 'pack', TEST_TOKEN: 'secret' });
    expect(call?.grants?.env).toEqual(['TEST_TOKEN']);
    expect(call?.policy.required).toBe(true);
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        path: join(outputDirectory, 'demo.test'),
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        nativeRole: 'distribution',
      }),
    ]);
  });

  it('rejects undeclared environment and artifact symlinks', async () => {
    const root = await project();
    const outputDirectory = join(root, 'out');
    const packer = configured(
      manifest(),
      async () => '/usr/bin/test-pack',
      async () => {
        await mkdir(outputDirectory, { recursive: true });
        const outside = join(root, 'secret.test');
        await writeFile(outside, 'secret');
        await symlink(outside, join(outputDirectory, 'demo.test'));
        return outcome();
      },
    );

    await expect(
      packer.pack(input(root), {
        authorizedEnvironment: { OTHER_TOKEN: 'no' },
      }),
    ).rejects.toMatchObject({ code: 'AUTHORITY_NOT_DECLARED' });
    await expect(
      packer.pack(input(root), { outputDirectory }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

function configured(
  value = manifest(),
  resolveExecutable: (name: string) => Promise<string | undefined> = async () =>
    '/usr/bin/test-pack',
  sandboxRun: (
    input: RunInSandboxInput,
  ) => Promise<SandboxOutcome> = async () => outcome(),
): ManifestPackagePacker {
  return new ManifestPackagePacker(value, 'test', {
    resolveExecutable,
    sandboxRun,
  });
}

function manifest(): DelegatedPackProviderManifest {
  return {
    delegatedPackProviderVersion: '1',
    id: 'example.test',
    purlTypes: ['test'],
    detection: { manifestNames: ['test.pack'] },
    executable: 'test-pack',
    commands: [
      {
        arguments: [
          'pack',
          { value: '--network', when: 'allow-network' },
          { value: '--offline', when: 'offline' },
          '--out',
          '{outputDirectory}',
        ],
      },
    ],
    environment: { TEST_MODE: 'pack' },
    authority: {
      build: false,
      network: 'consent',
      environment: ['TEST_TOKEN'],
    },
    artifacts: [
      {
        suffix: '.test',
        mediaType: 'application/x-test',
        nativeRole: 'distribution',
      },
    ],
  };
}

function input(root: string) {
  return {
    project: { root, manifestPath: join(root, 'test.pack') },
    target: { purlType: 'test', identifier: 'demo', version: '1.0.0' },
  };
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-pack-provider-'));
  roots.push(root);
  await writeFile(join(root, 'test.pack'), 'project');
  return root;
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

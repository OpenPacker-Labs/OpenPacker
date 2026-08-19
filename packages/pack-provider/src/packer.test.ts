import {
  appendFile,
  chmod,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DelegatedPackProviderManifest } from '@openpacker/contracts';
import {
  runInSandbox,
  type RunInSandboxInput,
  type SandboxBackend,
  type SandboxOutcome,
} from '@openpacker/sandbox';
import {
  ManifestPackagePacker,
  type ManifestPackagePackerLimits,
} from './packer.js';

const directorySwap = vi.hoisted(() => ({
  output: undefined as string | undefined,
  original: undefined as string | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async opendir(path: string) {
      if (path !== directorySwap.output || directorySwap.original === undefined)
        return actual.opendir(path);
      const original = directorySwap.original;
      directorySwap.output = undefined;
      directorySwap.original = undefined;
      await actual.rename(path, original);
      await actual.mkdir(path);
      const handle = await actual.opendir(path);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        await actual.rm(path, { recursive: true });
        await actual.rename(original, path);
      };
      return handle;
    },
  };
});

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

  it('requires execution consent before resolving or running any provider', async () => {
    const root = await project();
    let resolved = false;
    let ran = false;
    const packer = configured(
      manifest(),
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
      allowBuild: true,
      outputDirectory,
      authorizedEnvironment: { TEST_TOKEN: 'secret' },
    });

    expect(call?.argv).toEqual([
      '/usr/bin/test-pack',
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

  it('rejects a native artifact whose provider-reported identity differs from the target', async () => {
    const root = await project();
    const outputDirectory = join(root, 'out');
    const packer = new ManifestPackagePacker(manifest(), 'test', {
      executablePath: '/usr/bin/test-pack',
      inspectExecutable: async () => executableIdentity('/usr/bin/test-pack'),
      sandboxRun: async (sandboxInput) => {
        if (sandboxInput.argv[1] === 'identify') {
          const bytes = await readFile(sandboxInput.argv.at(-1)!);
          return outcome(
            JSON.stringify({
              delegatedPackArtifactIdentityVersion: '1',
              exactPurl: 'pkg:test/other@9.9.9',
              artifactDigest: `sha256:${createHash('sha256')
                .update(bytes)
                .digest('hex')}`,
            }),
          );
        }
        await writeFile(join(outputDirectory, 'demo.test'), 'native bytes');
        return outcome();
      },
    });

    await expect(
      packer.pack(input(root), { allowBuild: true, outputDirectory }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('binds the resolved path and keeps loader env inside a fail-closed jail', async () => {
    const root = await project();
    const outputDirectory = join(root, 'out');
    let backendInput: Parameters<SandboxBackend['run']>[0] | undefined;
    const backend: SandboxBackend = {
      id: 'native-bwrap',
      async run(input_) {
        backendInput = input_;
        await writeFile(join(outputDirectory, 'demo.test'), 'native bytes');
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    const value = manifest();
    value.authority.environment = ['LD_PRELOAD'];
    const packer = configured(
      value,
      async () => '/opt/acme/test-pack',
      async (input_) => runInSandbox({ ...input_, backend }),
    );

    const result = await packer.pack(input(root), {
      allowBuild: true,
      outputDirectory,
      authorizedEnvironment: { LD_PRELOAD: '/tmp/evil.so' },
      sandbox: { mode: 'off' },
    });

    expect(backendInput?.argv[0]).toBe('/opt/acme/test-pack');
    expect(backendInput?.env.LD_PRELOAD).toBe('/tmp/evil.so');
    expect(backendInput?.hostEnv.LD_PRELOAD).toBeUndefined();
    expect(result.sandboxBackend).toBe('native-bwrap');
    expect(result.sandboxEnforced).toBe(true);
    expect(result.tool?.digest).toEqual({
      algorithm: 'sha256',
      value: 'a'.repeat(64),
    });
  });

  it('requires an operator-approved absolute executable path', () => {
    expect(
      () =>
        new ManifestPackagePacker(manifest(), 'test', {
          executablePath: 'test-pack',
        }),
    ).toThrow(/absolute path/u);
  });

  it('rejects executable symlinks and records verified executable bytes', async () => {
    const root = await project();
    const executable = join(root, 'approved-tool');
    const linked = join(root, 'linked-tool');
    await writeFile(executable, '#!/bin/sh\nexit 0\n');
    await chmod(executable, 0o755);
    await symlink(executable, linked);

    const rejected = new ManifestPackagePacker(manifest(), 'test', {
      executablePath: linked,
    });
    await expect(rejected.available()).resolves.toMatchObject({
      available: false,
    });

    const accepted = new ManifestPackagePacker(manifest(), 'test', {
      executablePath: executable,
    });
    const result = await accepted.pack(input(root), { dryRun: true });
    expect(result.tool).toEqual({
      name: 'test-pack',
      path: executable,
      digest: {
        algorithm: 'sha256',
        value: createHash('sha256').update('#!/bin/sh\nexit 0\n').digest('hex'),
      },
    });
  });

  it('refuses an executable whose stable identity changes during execution', async () => {
    const root = await project();
    const outputDirectory = join(root, 'out');
    let revision = 1n;
    const packer = new ManifestPackagePacker(manifest(), 'test', {
      executablePath: '/usr/bin/test-pack',
      inspectExecutable: async () => ({
        ...executableIdentity('/usr/bin/test-pack'),
        inode: revision,
      }),
      sandboxRun: async () => {
        await writeFile(join(outputDirectory, 'demo.test'), 'native');
        revision = 2n;
        return outcome();
      },
    });
    await expect(
      packer.pack(input(root), { allowBuild: true, outputDirectory }),
    ).rejects.toMatchObject({ code: 'AUTHORITY_NOT_DECLARED' });
  });

  it('orders Unicode artifact names by canonical code units', async () => {
    const root = await project();
    const outputDirectory = join(root, 'out');
    const packer = configured(
      manifest(),
      async () => '/usr/bin/test-pack',
      async () => {
        await writeFile(join(outputDirectory, 'ä.test'), 'umlaut');
        await writeFile(join(outputDirectory, 'z.test'), 'ascii');
        return outcome();
      },
    );
    const result = await packer.pack(input(root), {
      allowBuild: true,
      outputDirectory,
    });
    expect(result.artifacts.map((artifact) => artifact.outputName)).toEqual([
      'z.test',
      'ä.test',
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
        allowBuild: true,
        authorizedEnvironment: { OTHER_TOKEN: 'no' },
      }),
    ).rejects.toMatchObject({ code: 'AUTHORITY_NOT_DECLARED' });
    await expect(
      packer.pack(input(root), { allowBuild: true, outputDirectory }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('bounds artifact count', async () => {
    const root = await project();
    const outputDirectory = join(root, 'out');
    const packer = configured(
      manifest(),
      async () => '/usr/bin/test-pack',
      async () => {
        await Promise.all(
          Array.from({ length: 3 }, (_, index) =>
            writeFile(join(outputDirectory, `${index}.test`), ''),
          ),
        );
        return outcome();
      },
      { artifacts: 2 },
    );

    await expect(
      packer.pack(input(root), { allowBuild: true, outputDirectory }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('reserves the host receipt name from delegated providers', async () => {
    const root = await project();
    const outputDirectory = join(root, 'out');
    const packer = configured(
      manifest(),
      async () => '/usr/bin/test-pack',
      async () => {
        await writeFile(join(outputDirectory, 'demo.test'), 'native');
        await writeFile(join(outputDirectory, 'opm-pack-receipt.json'), '{}');
        return outcome();
      },
    );

    await expect(
      packer.pack(input(root), { allowBuild: true, outputDirectory }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('retains preflight authority across a swap to empty and restore', async () => {
    const root = await project();
    const outputDirectory = join(root, 'out');
    const original = join(root, 'out-original');
    await mkdir(outputDirectory);
    await writeFile(join(outputDirectory, 'stale.test'), 'stale');
    directorySwap.output = outputDirectory;
    directorySwap.original = original;

    await expect(
      configured().pack(input(root), { allowBuild: true, outputDirectory }),
    ).rejects.toMatchObject({ code: 'OUTPUT_NOT_EMPTY' });
  });

  it('bounds directory entries before materializing them', async () => {
    const root = await project();
    const outputDirectory = join(root, 'out');
    const packer = configured(
      manifest(),
      async () => '/usr/bin/test-pack',
      async () => {
        await Promise.all(
          ['a', 'b', 'c'].map((name) =>
            writeFile(join(outputDirectory, `${name}.tmp`), ''),
          ),
        );
        return outcome();
      },
      { outputEntries: 2 },
    );

    await expect(
      packer.pack(input(root), { allowBuild: true, outputDirectory }),
    ).rejects.toThrow(/exceeds 2 entries/u);
  });

  it('bounds individual and aggregate artifact bytes', async () => {
    const root = await project();
    const outputDirectory = join(root, 'out');
    const single = configured(
      manifest(),
      async () => '/usr/bin/test-pack',
      async () => {
        await writeFile(join(outputDirectory, 'demo.test'), '12345');
        return outcome();
      },
      { artifactBytes: 4n },
    );
    await expect(
      single.pack(input(root), { allowBuild: true, outputDirectory }),
    ).rejects.toThrow(/exceeds 4 bytes/u);

    await rm(outputDirectory, { recursive: true, force: true });
    const aggregate = configured(
      manifest(),
      async () => '/usr/bin/test-pack',
      async () => {
        await writeFile(join(outputDirectory, 'a.test'), '123');
        await writeFile(join(outputDirectory, 'b.test'), '456');
        return outcome();
      },
      { artifactBytes: 10n, totalArtifactBytes: 5n },
    );
    await expect(
      aggregate.pack(input(root), { allowBuild: true, outputDirectory }),
    ).rejects.toThrow(/exceed 5 total bytes/u);
  });

  it('bounds an artifact that grows during collection', async () => {
    const root = await project();
    const outputDirectory = join(root, 'out');
    let signalOpened!: () => void;
    let releaseOpen!: () => void;
    const opened = new Promise<void>((resolvePromise) => {
      signalOpened = resolvePromise;
    });
    const released = new Promise<void>((resolvePromise) => {
      releaseOpen = resolvePromise;
    });
    const growth = opened
      .then(() => appendFile(join(outputDirectory, 'demo.test'), 'x'))
      .finally(releaseOpen);
    const packer = configured(
      manifest(),
      async () => '/usr/bin/test-pack',
      async () => {
        await writeFile(join(outputDirectory, 'demo.test'), Buffer.alloc(1024));
        return outcome();
      },
      { artifactBytes: 1024n, readChunkBytes: 1 },
      async (...arguments_) => {
        const handle = await open(...arguments_);
        signalOpened();
        await released;
        return handle;
      },
    );

    await expect(
      packer.pack(input(root), { allowBuild: true, outputDirectory }),
    ).rejects.toThrow(/exceeds 1024 bytes/u);
    await growth;
  });

  it('rejects an output-directory swap and restore during collection', async () => {
    const root = await project();
    const outputDirectory = join(root, 'out');
    const original = join(root, 'out-original');
    let attack: Promise<void> | undefined;
    const packer = configured(
      manifest(),
      async () => '/usr/bin/test-pack',
      async () => {
        await writeFile(
          join(outputDirectory, 'demo.test'),
          Buffer.alloc(8 * 1_024),
        );
        attack = new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, 1),
        ).then(async () => {
          await rename(outputDirectory, original);
          await mkdir(outputDirectory);
          await writeFile(join(outputDirectory, 'demo.test'), 'replacement');
          await rm(outputDirectory, { recursive: true });
          await rename(original, outputDirectory);
        });
        return outcome();
      },
      { readChunkBytes: 1 },
    );

    const result = await packer
      .pack(input(root), { allowBuild: true, outputDirectory })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await attack;
    expect(result).toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

function configured(
  value = manifest(),
  resolveExecutable: (name: string) => Promise<string | undefined> = async () =>
    '/usr/bin/test-pack',
  sandboxRun: (
    input: RunInSandboxInput,
  ) => Promise<SandboxOutcome> = async () => outcome(),
  limits?: Partial<ManifestPackagePackerLimits>,
  openFile?: typeof open,
): ManifestPackagePacker {
  return new ManifestPackagePacker(value, 'test', {
    executablePath: '/usr/bin/test-pack',
    inspectExecutable: async () => {
      const path = await resolveExecutable(value.executable);
      if (path === undefined) throw new Error('missing executable');
      return executableIdentity(path);
    },
    sandboxRun: async (input_) => {
      if (input_.argv[1] === 'identify') {
        const path = input_.argv.at(-1)!;
        const bytes = await readFile(path);
        return outcome(
          JSON.stringify({
            delegatedPackArtifactIdentityVersion: '1',
            exactPurl: 'pkg:test/demo@1.0.0',
            artifactDigest: `sha256:${createHash('sha256')
              .update(bytes)
              .digest('hex')}`,
          }),
        );
      }
      return sandboxRun(input_);
    },
    ...(limits === undefined ? {} : { limits }),
    ...(openFile === undefined ? {} : { openFile }),
  });
}

function executableIdentity(path: string) {
  return {
    path,
    digest: { algorithm: 'sha256' as const, value: 'a'.repeat(64) },
    device: 1n,
    inode: 2n,
    size: 3n,
    ctimeNanoseconds: 4n,
    mtimeNanoseconds: 5n,
  };
}

function manifest(): DelegatedPackProviderManifest {
  return {
    delegatedPackProviderVersion: '2',
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
    identityCommand: {
      arguments: ['identify', '--artifact', '{artifactPath}'],
    },
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

function outcome(stdout = ''): SandboxOutcome {
  return {
    exitCode: 0,
    stdout,
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

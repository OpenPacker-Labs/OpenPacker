import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxOutcome } from '@openpacker/sandbox';
import {
  DelegatedCommandPacker,
  type DelegatedCommandPackerOptions,
} from './delegated-pack.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe('delegated command packer', () => {
  it('keeps build and network consent independent', async () => {
    const root = await project();
    const packer = configured(root);

    const offline = await packer.pack(
      { project: detected(root) },
      { dryRun: true },
    );
    expect(offline.command).toEqual(['native', 'pack', '--offline']);
    expect(offline.requiresBuild).toBe(true);
    expect(offline.requiresNetwork).toBe(false);

    const networked = await packer.pack(
      { project: detected(root) },
      { dryRun: true, allowBuild: true, allowNetwork: true },
    );
    expect(networked.command).toEqual(['native', 'pack']);
    expect(networked.requiresNetwork).toBe(true);
  });

  it('uses mise as a wrapper without changing the native plan', async () => {
    const root = await project();
    const packer = configured(root);
    const result = await packer.pack(
      { project: detected(root) },
      { dryRun: true, tool: 'mise' },
    );
    expect(result.command).toEqual([
      'mise',
      'exec',
      '--',
      'native',
      'pack',
      '--offline',
    ]);
    expect(result.tool?.name).toBe('mise');
  });

  it('returns typed digests for every native artifact', async () => {
    const root = await project();
    const outputDirectory = join(root, 'out');
    const packer = configured(root, async (input) => {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(outputDirectory, 'demo.pkg'), 'native bytes');
      return outcome(input.argv);
    });
    const result = await packer.pack(
      { project: detected(root) },
      { outputDirectory, allowBuild: true },
    );
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        path: join(outputDirectory, 'demo.pkg'),
        mediaType: 'application/x-test',
        nativeRole: 'distribution',
        size: 12,
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      }),
    ]);
  });
});

function configured(
  root: string,
  sandbox = async (input: { argv: readonly string[] }) => outcome(input.argv),
): DelegatedCommandPacker {
  const config: DelegatedCommandPackerOptions = {
    providerId: 'test-pack',
    purlType: 'test',
    detect: async () => detected(root),
    defaultTool: 'native',
    tools: {
      native: {
        executable: 'native',
        plan: ({ options }) => ({
          commands: [
            ['native', 'pack', ...(options.allowNetwork ? [] : ['--offline'])],
          ],
          requiresBuild: true,
          requiresNetwork:
            options.allowNetwork === true && options.offline !== true,
          expectedRoles: ['distribution'],
        }),
      },
    },
    artifacts: [
      {
        extension: '.pkg',
        mediaType: 'application/x-test',
        nativeRole: 'distribution',
      },
    ],
  };
  return new DelegatedCommandPacker(
    config,
    async (file) => `/usr/bin/${file}`,
    sandbox as never,
  );
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-delegated-pack-'));
  roots.push(root);
  await writeFile(join(root, 'manifest'), 'test');
  return root;
}

function detected(root: string) {
  return { root, manifestPath: join(root, 'manifest') };
}

function outcome(argv: readonly string[]): SandboxOutcome {
  return {
    exitCode: 0,
    stdout: argv.join(' '),
    stderr: '',
    backend: 'mock',
    profile: 'package-exec',
    enforced: true,
    containmentLimited: false,
    policyDigest: {
      algorithm: 'sha256',
      value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    losses: [],
    degraded: false,
  };
}

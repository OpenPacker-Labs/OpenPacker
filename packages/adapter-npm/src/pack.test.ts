import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SandboxOutcome } from '@openpacker/sandbox';
import { NpmPackagePacker } from './pack.js';

const sandboxOutcome = (stdout: string): SandboxOutcome => ({
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
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'npm-pack-v2-'));
  await writeFile(
    join(root, 'package.json'),
    '{"name":"demo","version":"1.2.3","scripts":{"prepack":"node build.js"}}\n',
  );
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('NpmPackagePacker', () => {
  it('plans native npm pack without scripts or network by default', async () => {
    const project = await fixture();
    try {
      const packer = new NpmPackagePacker(
        async () => '/usr/bin/npm',
        async () => sandboxOutcome('[]'),
      );
      const detected = await packer.detect(project.root);
      expect(detected).toBeDefined();
      const outputDirectory = join(project.root, 'out');
      const plan = await packer.plan(
        { project: detected! },
        { outputDirectory },
      );
      expect(plan.command).toEqual([
        'npm',
        'pack',
        project.root,
        '--json',
        '--pack-destination',
        outputDirectory,
        '--ignore-scripts',
      ]);
      expect(plan.requiresBuild).toBe(false);
      expect(plan.requiresNetwork).toBe(false);
    } finally {
      await project.cleanup();
    }
  });

  it('only grants scripts and network when independently consented', async () => {
    const project = await fixture();
    try {
      const packer = new NpmPackagePacker(
        async () => '/usr/bin/npm',
        async () => sandboxOutcome('[]'),
      );
      const detected = (await packer.detect(project.root))!;
      const scripts = await packer.plan(
        { project: detected },
        { allowBuild: true },
      );
      expect(scripts.command).not.toContain('--ignore-scripts');
      expect(scripts.requiresBuild).toBe(true);
      expect(scripts.requiresNetwork).toBe(false);

      const network = await packer.plan(
        { project: detected },
        { allowNetwork: true },
      );
      expect(network.requiresNetwork).toBe(true);
      const offline = await packer.plan(
        { project: detected },
        { allowNetwork: true, offline: true },
      );
      expect(offline.requiresNetwork).toBe(false);
    } finally {
      await project.cleanup();
    }
  });

  it('captures a typed artifact and hashes the bytes the delegate wrote', async () => {
    const project = await fixture();
    try {
      const calls: readonly string[][] = [];
      const outputDirectory = join(project.root, 'out');
      const packer = new NpmPackagePacker(
        async () => '/usr/bin/npm',
        async (input) => {
          (calls as string[][]).push([...input.argv]);
          await mkdir(outputDirectory, { recursive: true });
          await writeFile(join(outputDirectory, 'demo-1.2.3.tgz'), 'native');
          return sandboxOutcome(
            JSON.stringify([
              { filename: 'demo-1.2.3.tgz', name: 'demo', version: '1.2.3' },
            ]),
          );
        },
      );
      const detected = (await packer.detect(project.root))!;
      const result = await packer.pack(
        { project: detected },
        { outputDirectory },
      );
      expect(result.performed).toBe(true);
      expect(result.sandboxEnforced).toBe(true);
      expect(result.artifacts).toEqual([
        expect.objectContaining({
          path: join(outputDirectory, 'demo-1.2.3.tgz'),
          exactPurl: 'pkg:npm/demo@1.2.3',
          nativeRole: 'distribution',
          size: 6,
          digest:
            'sha256:bef32d2c315a289576f2a6828d27edb16bb316a4d85c271f2d794045f3ea668d',
        }),
      ]);
      expect(calls).toHaveLength(1);
    } finally {
      await project.cleanup();
    }
  });

  it('does not run the delegate on dry-run', async () => {
    const project = await fixture();
    try {
      let ran = false;
      const packer = new NpmPackagePacker(
        async () => '/usr/bin/npm',
        async () => {
          ran = true;
          return sandboxOutcome('[]');
        },
      );
      const detected = (await packer.detect(project.root))!;
      const result = await packer.pack({ project: detected }, { dryRun: true });
      expect(result.performed).toBe(false);
      expect(result.artifacts).toEqual([]);
      expect(ran).toBe(false);
    } finally {
      await project.cleanup();
    }
  });

  it('rejects delegate output that escapes the output directory', async () => {
    const project = await fixture();
    try {
      const packer = new NpmPackagePacker(
        async () => '/usr/bin/npm',
        async () =>
          sandboxOutcome(
            JSON.stringify([
              { filename: '../escape.tgz', name: 'demo', version: '1.2.3' },
            ]),
          ),
      );
      const detected = (await packer.detect(project.root))!;
      await expect(
        packer.pack(
          { project: detected },
          { outputDirectory: join(project.root, 'out') },
        ),
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    } finally {
      await project.cleanup();
    }
  });

  it('reports a missing npm executable without throwing from availability', async () => {
    const packer = new NpmPackagePacker(async () => {
      throw new Error('ENOENT');
    });
    expect(await packer.available()).toEqual({
      available: false,
      reason: 'npm is not on PATH',
    });
  });
});

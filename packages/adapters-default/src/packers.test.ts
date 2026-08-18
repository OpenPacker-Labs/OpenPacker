import { describe, expect, it } from 'vitest';
import type { DetectedProject, PackagePacker } from '@openpacker/adapter-core';
import {
  cargoPacker,
  chocolateyPacker,
  debPacker,
  mavenPacker,
  nixPacker,
  nugetPacker,
  ociPacker,
  pypiPacker,
  wingetPacker,
} from './packers.js';

const root = '/workspace';
const project: DetectedProject = {
  root,
  manifestPath: '/workspace/manifest',
};

describe('delegated pack plans', () => {
  it.each([
    [cargoPacker(), 'cargo', '--target-dir', false],
    [pypiPacker(), 'uv', '--out-dir', true],
    [nugetPacker(), 'dotnet', '--output', true],
    [mavenPacker(), 'mvn', 'package', true],
    [nixPacker(), 'nix', 'file:///out', true],
    [debPacker(), 'dpkg-deb', 'package.deb', false],
    [wingetPacker(), 'winget', '--manifest', false],
    [chocolateyPacker(), 'choco', '--output-directory', false],
  ] as const)(
    'plans %s without silently enabling build or network',
    async (
      packer: PackagePacker,
      executable: string,
      expected: string,
      requiresBuild: boolean,
    ) => {
      const plan = await packer.plan({ project }, { outputDirectory: '/out' });
      expect(plan.command?.[0]).toBe(executable);
      expect(plan.command?.join(' ')).toContain(expected);
      expect(plan.requiresBuild).toBe(requiresBuild);
      expect(plan.requiresNetwork).toBe(false);
    },
  );

  it('requires build consent before dotnet can evaluate project targets', async () => {
    const packer = nugetPacker();
    await expect(
      packer.pack({ project }, { outputDirectory: '/out', tool: 'dotnet' }),
    ).rejects.toMatchObject({ code: 'BUILD_CONSENT_REQUIRED' });
  });

  it('plans OCI archives for both Docker and Podman', async () => {
    const docker = await ociPacker().plan(
      { project },
      { outputDirectory: '/out', allowBuild: true, tool: 'docker' },
    );
    expect(docker.commands).toEqual([
      [
        'docker',
        'buildx',
        'build',
        '--output',
        'type=oci,dest=/out/image.oci.tar',
        '--network',
        'none',
        root,
      ],
    ]);

    const podman = await ociPacker().plan(
      { project },
      { outputDirectory: '/out', allowBuild: true, tool: 'podman' },
    );
    expect(podman.commands).toHaveLength(2);
    expect(podman.commands?.[1]?.slice(0, 6)).toEqual([
      'podman',
      'save',
      '--format',
      'oci-archive',
      '--output',
      '/out/image.oci.tar',
    ]);
    expect(podman.cleanupCommands?.[0]?.slice(0, 4)).toEqual([
      'podman',
      'image',
      'rm',
      '--force',
    ]);
  });

  it('routes a native format through mise without inventing a new format', async () => {
    const plan = await cargoPacker().plan(
      { project },
      { outputDirectory: '/out', tool: 'mise' },
    );
    expect(plan.command?.slice(0, 4)).toEqual(['mise', 'exec', '--', 'cargo']);
    expect(plan.purlType).toBe('cargo');
  });
});

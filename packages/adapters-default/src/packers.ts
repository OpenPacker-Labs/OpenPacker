import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CargoProjectFormat } from '@openpacker/adapter-cargo';
import { GolangProjectFormat } from '@openpacker/adapter-golang';
import { MavenProjectFormat } from '@openpacker/adapter-maven';
import { NugetProjectFormat } from '@openpacker/adapter-nuget';
import { PypiProjectFormat } from '@openpacker/adapter-pypi';
import {
  DelegatedCommandPacker,
  extensionDetector,
  markerDetector,
  type DelegatedCommandPackerOptions,
} from './delegated-pack.js';
import { standardEmitters } from './standard-pack.js';

const cargo = new CargoProjectFormat();
const pypi = new PypiProjectFormat();
const nuget = new NugetProjectFormat();
const maven = new MavenProjectFormat();
const golang = new GolangProjectFormat();

export function cargoPacker(): DelegatedCommandPacker {
  return packer({
    providerId: 'cargo-pack',
    purlType: 'cargo',
    detect: (root) => cargo.detect(root),
    defaultTool: 'cargo',
    tools: {
      cargo: {
        executable: 'cargo',
        plan: ({ project, outputDirectory, options }) => ({
          commands: [
            [
              'cargo',
              'package',
              '--manifest-path',
              project.manifestPath,
              '--target-dir',
              join(outputDirectory, '.cargo-target'),
              ...(options.allowBuild ? [] : ['--no-verify']),
              ...(network(options) ? [] : ['--offline']),
            ],
          ],
          requiresBuild: options.allowBuild === true,
          requiresNetwork: network(options),
          expectedRoles: ['distribution'],
        }),
      },
    },
    artifacts: [
      {
        extension: '.crate',
        mediaType: 'application/gzip',
        nativeRole: 'distribution',
      },
    ],
    standard: standardEmitters.cargo,
  });
}

export function pypiPacker(): DelegatedCommandPacker {
  return packer({
    providerId: 'pypi-pack',
    purlType: 'pypi',
    detect: (root) => pypi.detect(root),
    defaultTool: 'uv',
    tools: {
      uv: {
        executable: 'uv',
        plan: ({ project, outputDirectory, options }) => ({
          commands: [
            [
              'uv',
              'build',
              project.root,
              '--out-dir',
              outputDirectory,
              ...(network(options) ? [] : ['--offline']),
              '--no-python-downloads',
            ],
          ],
          requiresBuild: true,
          requiresNetwork: network(options),
          expectedRoles: ['source-distribution', 'wheel'],
        }),
      },
      python: {
        executable: 'python',
        plan: ({ project, outputDirectory, options }) => ({
          commands: [
            [
              'python',
              '-m',
              'build',
              project.root,
              '--outdir',
              outputDirectory,
            ],
          ],
          requiresBuild: true,
          requiresNetwork: network(options),
          expectedRoles: ['source-distribution', 'wheel'],
        }),
      },
    },
    artifacts: [
      {
        extension: '.whl',
        mediaType: 'application/zip',
        nativeRole: 'wheel',
      },
      {
        extension: '.gz',
        mediaType: 'application/gzip',
        nativeRole: 'source-distribution',
      },
    ],
    standard: standardEmitters.pypi,
  });
}

export function nugetPacker(): DelegatedCommandPacker {
  return packer({
    providerId: 'nuget-pack-v2',
    purlType: 'nuget',
    detect: (root) => nuget.detect(root),
    defaultTool: 'dotnet',
    tools: {
      dotnet: {
        executable: 'dotnet',
        plan: ({ project, outputDirectory, options }) => ({
          commands: [
            [
              'dotnet',
              'pack',
              project.manifestPath,
              '--output',
              outputDirectory,
              ...(options.allowBuild ? [] : ['--no-build']),
              ...(network(options) ? [] : ['--no-restore']),
            ],
          ],
          // MSBuild evaluates project-controlled Pack targets even with --no-build.
          requiresBuild: true,
          requiresNetwork: network(options),
          expectedRoles: ['distribution', 'symbols'],
        }),
      },
      nuget: {
        executable: 'nuget',
        plan: ({ project, outputDirectory, options }) => ({
          commands: [
            [
              'nuget',
              'pack',
              project.manifestPath,
              '-OutputDirectory',
              outputDirectory,
            ],
          ],
          requiresBuild: false,
          requiresNetwork: network(options),
          expectedRoles: ['distribution'],
        }),
      },
    },
    artifacts: [
      {
        extension: '.nupkg',
        mediaType: 'application/zip',
        nativeRole: 'distribution',
      },
      {
        extension: '.snupkg',
        mediaType: 'application/zip',
        nativeRole: 'symbols',
      },
    ],
    standard: standardEmitters.nuget,
  });
}

export function mavenPacker(): DelegatedCommandPacker {
  return packer({
    providerId: 'maven-pack',
    purlType: 'maven',
    detect: async (root) => {
      const project = await maven.detect(root);
      return project?.metadata?.kind === 'maven' ? project : undefined;
    },
    defaultTool: 'mvn',
    tools: {
      mvn: {
        executable: 'mvn',
        plan: ({ project, outputDirectory, options }) => ({
          commands: [
            [
              'mvn',
              '-f',
              project.manifestPath,
              `-Dproject.build.directory=${outputDirectory}`,
              ...(network(options) ? [] : ['--offline']),
              'package',
            ],
          ],
          requiresBuild: true,
          requiresNetwork: network(options),
          expectedRoles: ['distribution'],
        }),
      },
    },
    artifacts: [
      {
        extension: '.jar',
        mediaType: 'application/java-archive',
        nativeRole: 'distribution',
      },
      {
        extension: '.war',
        mediaType: 'application/java-archive',
        nativeRole: 'distribution',
      },
    ],
    standard: standardEmitters.maven,
  });
}

export function ociPacker(): DelegatedCommandPacker {
  return packer({
    providerId: 'oci-pack',
    purlType: 'oci',
    detect: markerDetector('oci', ['Dockerfile', 'Containerfile']),
    defaultTool: 'docker',
    tools: {
      docker: {
        executable: 'docker',
        plan: ({ project, outputDirectory, options }) => ({
          commands: [
            [
              'docker',
              'buildx',
              'build',
              '--output',
              `type=oci,dest=${join(outputDirectory, 'image.oci.tar')}`,
              ...(network(options) ? [] : ['--network', 'none']),
              project.root,
            ],
          ],
          requiresBuild: true,
          requiresNetwork: network(options),
          expectedRoles: ['oci-layout'],
        }),
      },
      podman: {
        executable: 'podman',
        plan: ({ project, outputDirectory, options }) => {
          const tag = `localhost/opm-pack-${createHash('sha256')
            .update(`${project.root}:${process.pid}`)
            .digest('hex')
            .slice(0, 16)}`;
          return {
            commands: [
              [
                'podman',
                'build',
                '--tag',
                tag,
                ...(network(options) ? [] : ['--network', 'none']),
                project.root,
              ],
              [
                'podman',
                'save',
                '--format',
                'oci-archive',
                '--output',
                join(outputDirectory, 'image.oci.tar'),
                tag,
              ],
            ],
            cleanupCommands: [['podman', 'image', 'rm', '--force', tag]],
            requiresBuild: true,
            requiresNetwork: network(options),
            expectedRoles: ['oci-layout'],
          };
        },
      },
    },
    artifacts: [
      {
        extension: '.tar',
        mediaType: 'application/vnd.oci.image.layout.v1.tar',
        nativeRole: 'oci-layout',
      },
    ],
    standard: standardEmitters.oci,
  });
}

export function nixPacker(): DelegatedCommandPacker {
  return packer({
    providerId: 'nix-pack',
    purlType: 'nix',
    detect: markerDetector('nix', ['flake.nix', 'default.nix']),
    defaultTool: 'nix',
    tools: {
      nix: {
        executable: 'nix',
        plan: ({ project, outputDirectory, options }) => ({
          commands: [
            [
              'nix',
              'copy',
              '--to',
              `file://${outputDirectory}`,
              `path:${project.root}`,
              ...(network(options) ? [] : ['--offline']),
            ],
          ],
          requiresBuild: true,
          requiresNetwork: network(options),
          expectedRoles: ['nar', 'narinfo', 'cache-metadata'],
        }),
      },
    },
    artifacts: [
      {
        extension: '.nar.xz',
        mediaType: 'application/x-xz',
        nativeRole: 'nar',
      },
      {
        extension: '.nar.zst',
        mediaType: 'application/zstd',
        nativeRole: 'nar',
      },
      {
        extension: '.nar',
        mediaType: 'application/x-nix-archive',
        nativeRole: 'nar',
      },
      {
        extension: '.narinfo',
        mediaType: 'text/x-nix-narinfo',
        nativeRole: 'narinfo',
      },
      {
        basename: 'nix-cache-info',
        mediaType: 'text/plain',
        nativeRole: 'cache-metadata',
      },
    ],
    standard: standardEmitters.nix,
  });
}

export function debPacker(): DelegatedCommandPacker {
  return packer({
    providerId: 'deb-pack',
    purlType: 'deb',
    detect: markerDetector('deb', [join('DEBIAN', 'control')]),
    defaultTool: 'dpkg-deb',
    tools: {
      'dpkg-deb': {
        executable: 'dpkg-deb',
        plan: ({ project, outputDirectory }) => ({
          commands: [
            [
              'dpkg-deb',
              '--build',
              '--root-owner-group',
              project.root,
              join(outputDirectory, 'package.deb'),
            ],
          ],
          requiresBuild: false,
          requiresNetwork: false,
          expectedRoles: ['distribution'],
        }),
      },
    },
    artifacts: [
      {
        extension: '.deb',
        mediaType: 'application/vnd.debian.binary-package',
        nativeRole: 'distribution',
      },
    ],
    standard: standardEmitters.deb,
  });
}

export function wingetPacker(): DelegatedCommandPacker {
  return packer({
    providerId: 'winget-pack',
    purlType: 'winget',
    detect: extensionDetector('winget', ['.yaml', '.yml']),
    defaultTool: 'winget',
    tools: {
      winget: {
        executable: 'winget',
        plan: ({ project }) => ({
          commands: [
            [
              'winget',
              'validate',
              '--manifest',
              project.root,
              '--disable-interactivity',
            ],
          ],
          requiresBuild: false,
          requiresNetwork: false,
          expectedRoles: ['manifest'],
        }),
      },
    },
    artifacts: [
      {
        extension: '.yaml',
        mediaType: 'application/yaml',
        nativeRole: 'manifest',
      },
      {
        extension: '.yml',
        mediaType: 'application/yaml',
        nativeRole: 'manifest',
      },
    ],
    copyProjectArtifacts: true,
    standard: standardEmitters.winget,
  });
}

export function chocolateyPacker(): DelegatedCommandPacker {
  return packer({
    providerId: 'chocolatey-pack',
    purlType: 'chocolatey',
    detect: extensionDetector('chocolatey', ['.nuspec']),
    defaultTool: 'choco',
    tools: {
      choco: {
        executable: 'choco',
        plan: ({ project, outputDirectory }) => ({
          commands: [
            [
              'choco',
              'pack',
              project.manifestPath,
              '--output-directory',
              outputDirectory,
              '--no-progress',
              '--yes',
            ],
          ],
          requiresBuild: false,
          requiresNetwork: false,
          expectedRoles: ['distribution'],
        }),
      },
    },
    artifacts: [
      {
        extension: '.nupkg',
        mediaType: 'application/zip',
        nativeRole: 'distribution',
      },
    ],
    standard: standardEmitters.chocolatey,
  });
}

export function golangPacker(): DelegatedCommandPacker {
  return packer({
    providerId: 'golang-pack',
    purlType: 'golang',
    detect: (root) => golang.detect(root),
    defaultTool: 'go',
    tools: {
      go: {
        executable: 'go',
        plan: () => {
          throw new Error(
            'Go has no native pack command; use standardized packing',
          );
        },
      },
    },
    artifacts: [],
    standard: standardEmitters.golang,
  });
}

function packer(config: DelegatedCommandPackerOptions): DelegatedCommandPacker {
  return new DelegatedCommandPacker(config);
}

function network(options: {
  allowNetwork?: boolean;
  offline?: boolean;
}): boolean {
  return options.allowNetwork === true && options.offline !== true;
}

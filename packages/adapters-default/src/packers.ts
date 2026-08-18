import { join } from 'node:path';
import { CargoProjectFormat } from '@openpacker/adapter-cargo';
import { GolangProjectFormat } from '@openpacker/adapter-golang';
import { MavenProjectFormat } from '@openpacker/adapter-maven';
import { npmPublishPaths, NpmProjectFormat } from '@openpacker/adapter-npm';
import { NugetProjectFormat } from '@openpacker/adapter-nuget';
import { PypiProjectFormat } from '@openpacker/adapter-pypi';
import { standardEmitters } from './standard-pack.js';
import {
  StandardPackagePacker,
  extensionDetector,
  markerDetector,
  type StandardPackagePackerOptions,
} from './standard-packer.js';

const npm = new NpmProjectFormat();
const cargo = new CargoProjectFormat();
const pypi = new PypiProjectFormat();
const nuget = new NugetProjectFormat();
const maven = new MavenProjectFormat();
const golang = new GolangProjectFormat();

export const npmPacker = () =>
  standard({
    purlType: 'npm',
    detect: (root) => npm.detect(root),
    capturePaths: npmPublishPaths,
    emitter: standardEmitters.npm,
  });

export const cargoPacker = () =>
  standard({
    purlType: 'cargo',
    detect: (root) => cargo.detect(root),
    emitter: standardEmitters.cargo,
  });

export const pypiPacker = () =>
  standard({
    purlType: 'pypi',
    detect: (root) => pypi.detect(root),
    emitter: standardEmitters.pypi,
  });

export const nugetPacker = () =>
  standard({
    purlType: 'nuget',
    detect: (root) => nuget.detect(root),
    emitter: standardEmitters.nuget,
  });

export const mavenPacker = () =>
  standard({
    purlType: 'maven',
    detect: async (root) => {
      const project = await maven.detect(root);
      return project?.metadata?.kind === 'maven' ? project : undefined;
    },
    emitter: standardEmitters.maven,
  });

export const golangPacker = () =>
  standard({
    purlType: 'golang',
    detect: (root) => golang.detect(root),
    emitter: standardEmitters.golang,
  });

export const ociPacker = () =>
  standard({
    purlType: 'oci',
    detect: markerDetector('oci', ['Dockerfile', 'Containerfile']),
    emitter: standardEmitters.oci,
  });

export const nixPacker = () =>
  standard({
    purlType: 'nix',
    detect: markerDetector('nix', ['flake.nix', 'default.nix']),
    emitter: standardEmitters.nix,
  });

export const debPacker = () =>
  standard({
    purlType: 'deb',
    detect: markerDetector('deb', [join('DEBIAN', 'control')]),
    emitter: standardEmitters.deb,
  });

export const wingetPacker = () =>
  standard({
    purlType: 'winget',
    detect: extensionDetector('winget', ['.yaml', '.yml']),
    emitter: standardEmitters.winget,
  });

export const chocolateyPacker = () =>
  standard({
    purlType: 'chocolatey',
    detect: extensionDetector('chocolatey', ['.nuspec']),
    emitter: standardEmitters.chocolatey,
  });

function standard(
  config: Omit<StandardPackagePackerOptions, 'providerId'>,
): StandardPackagePacker {
  return new StandardPackagePacker({
    ...config,
    providerId: `standard-${config.purlType}`,
  });
}

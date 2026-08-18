import type { NormalizedPackInput } from '@openpacker/adapter-core';
import { standardEmitters } from './standard-pack.js';

const encode = (value: string) => new TextEncoder().encode(value);

export function normalized(
  kind: keyof typeof standardEmitters,
): NormalizedPackInput {
  const identifier = kind === 'maven' ? 'dev.openpacker:demo' : 'demo';
  const files = [
    {
      path: kind === 'winget' ? 'demo.installer.yaml' : 'hello.txt',
      contents: encode(
        kind === 'winget'
          ? [
              'PackageIdentifier: demo',
              'PackageVersion: 1.0.0',
              'PackageLocale: en-US',
              'Publisher: OpenPacker',
              'PackageName: demo',
              'License: MIT',
              'ShortDescription: demo package',
              'Installers:',
              '  - Architecture: x64',
              '    InstallerType: portable',
              '    InstallerUrl: https://example.invalid/demo.exe',
              `    InstallerSha256: ${'a'.repeat(64)}`,
              'ManifestType: singleton',
              'ManifestVersion: 1.6.0',
              '',
            ].join('\n')
          : 'hello',
      ),
      executable: false,
    },
    ...fixtureFiles(kind),
  ];
  return {
    files,
    manifest: {
      normalizedPackManifestVersion: '1',
      package: {
        packageManifestVersion: '1',
        name: 'demo',
        version: '1.0.0',
        distributions: [{ purlType: kind, identifier, version: '1.0.0' }],
      },
      target: { purlType: kind, identifier, version: '1.0.0' },
      tree: { manifestVersion: '1', entries: [] },
      oci: {
        imageLayoutVersion: '1.0.0',
        config: {
          entrypoint: [],
          arguments: [],
          environment: {},
          labels: {},
          exposedPorts: [],
          volumes: [],
        },
        layers: [
          {
            descriptorId: 'layer',
            digest: { algorithm: 'sha256', value: '0'.repeat(64) },
            size: 0,
            mediaType: 'application/vnd.oci.image.layer.v1.tar',
            artifactType: 'application/vnd.openpacker.normalized-source.v1.tar',
            nativeRole: 'normalized-source',
            locations: [],
            referrers: [],
            externalRefs: [],
          },
        ],
      },
      requirements: [],
      lifecycle: [],
      nativeMetadata: {
        'dev.openpacker.capture': 'project-tree-v1',
        'dev.openpacker.oci.os': 'linux',
        'dev.openpacker.oci.architecture': 'amd64',
      },
      semanticLoss: [],
    },
  };
}

function fixtureFiles(kind: keyof typeof standardEmitters) {
  if (kind === 'npm')
    return [file('package.json', '{"name":"demo","version":"1.0.0"}\n')];
  if (kind === 'cargo')
    return [
      file(
        'Cargo.toml',
        '[package]\nname="demo"\nversion="1.0.0"\nedition="2021"\n',
      ),
      file('src/lib.rs', 'pub fn hello() {}\n'),
    ];
  if (kind === 'pypi')
    return [
      file(
        'setup.py',
        'from setuptools import setup\nsetup(name="demo", version="1.0.0")\n',
      ),
    ];
  if (kind === 'chocolatey')
    return [
      file(
        'demo.nuspec',
        '<?xml version="1.0"?><package><metadata><id>demo</id><version>1.0.0</version><authors>OpenPacker</authors><description>demo</description></metadata></package>',
      ),
    ];
  if (kind === 'deb')
    return [
      file(
        'DEBIAN/control',
        'Package: demo\nVersion: 1.0.0\nArchitecture: all\nMaintainer: OpenPacker <noreply@openpacker.dev>\nDescription: demo package\n',
      ),
    ];
  if (kind === 'golang') return [file('go.mod', 'module demo\n')];
  return [];
}

function file(path: string, contents: string) {
  return { path, contents: encode(contents), executable: false };
}

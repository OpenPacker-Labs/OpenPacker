import { describe, expect, it } from 'vitest';
import type { NormalizedPackInput } from '@openpacker/adapter-core';
import { inspectArchive } from '@openpacker/materializer';
import { standardEmitters } from './standard-pack.js';

describe('standard pack emitters', () => {
  it.each([
    ['npm', 'tar+gzip'],
    ['cargo', 'tar+gzip'],
    ['pypi', 'tar+gzip'],
    ['nuget', 'zip'],
    ['maven', 'zip'],
    ['chocolatey', 'zip'],
    ['golang', 'zip'],
    ['oci', 'tar'],
  ] as const)(
    'emits deterministic, independently readable %s bytes',
    async (kind, format) => {
      const emitter = standardEmitters[kind];
      const first = await emitter.emit(normalized(kind));
      const second = await emitter.emit(normalized(kind));
      expect(first.map((item) => item.bytes)).toEqual(
        second.map((item) => item.bytes),
      );
      const archive = first.find((item) =>
        kind === 'golang' ? item.fileName.endsWith('.zip') : true,
      )!;
      const entries = await inspectArchive(archive.bytes, format);
      expect(entries.length).toBeGreaterThan(0);
      if (kind === 'oci')
        expect(entries.map((entry) => entry.path)).toContain('oci-layout');
    },
  );

  it('emits a parseable Debian ar and Nix NAR', async () => {
    const deb = (await standardEmitters.deb.emit(normalized('deb')))[0]!;
    expect(new TextDecoder().decode(deb.bytes.slice(0, 8))).toBe('!<arch>\n');
    expect(arMembers(deb.bytes)).toEqual([
      'debian-binary',
      'control.tar.gz',
      'data.tar.gz',
    ]);

    const nar = (await standardEmitters.nix.emit(normalized('nix')))[0]!;
    expect(readNarString(nar.bytes, 0).value).toBe('nix-archive-1');
    expect(new TextDecoder().decode(nar.bytes)).toContain('hello.txt');
  });

  it('keeps a WinGet package as a typed native manifest set', async () => {
    const artifacts = await standardEmitters.winget.emit(normalized('winget'));
    expect(artifacts.map((artifact) => artifact.fileName)).toEqual([
      'demo.installer.yaml',
    ]);
    expect(artifacts[0]?.nativeRole).toBe('manifest');
  });
});

function normalized(kind: keyof typeof standardEmitters): NormalizedPackInput {
  const identifier = kind === 'maven' ? 'dev.openpacker:demo' : 'demo';
  const files = [
    {
      path: kind === 'winget' ? 'demo.installer.yaml' : 'hello.txt',
      contents: new TextEncoder().encode('hello'),
      executable: false,
    },
    ...(kind === 'deb'
      ? [
          {
            path: 'DEBIAN/control',
            contents: new TextEncoder().encode(
              'Package: demo\nVersion: 1.0.0\nArchitecture: all\n',
            ),
            executable: false,
          },
        ]
      : []),
    ...(kind === 'golang'
      ? [
          {
            path: 'go.mod',
            contents: new TextEncoder().encode('module demo\n'),
            executable: false,
          },
        ]
      : []),
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

function arMembers(bytes: Uint8Array): string[] {
  const names: string[] = [];
  let offset = 8;
  while (offset < bytes.byteLength) {
    const header = new TextDecoder().decode(bytes.slice(offset, offset + 60));
    names.push(header.slice(0, 16).trim().replace(/\/$/u, ''));
    const size = Number(header.slice(48, 58).trim());
    offset += 60 + size + (size % 2);
  }
  return names;
}

function readNarString(
  bytes: Uint8Array,
  offset: number,
): { value: string; next: number } {
  const size = Number(
    new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(
      0,
      true,
    ),
  );
  const start = offset + 8;
  return {
    value: new TextDecoder().decode(bytes.slice(start, start + size)),
    next: start + size + ((8 - (size % 8)) % 8),
  };
}

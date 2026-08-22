import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { inspectArchive } from '@openpacker/materializer';
import { standardEmitters } from './standard-pack.js';
import { normalized } from './standard-pack.fixture.js';

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

  it.each([
    ['npm', 'npm', 'tar+gzip', 'package/package.json', /"name":"demo"/u],
    ['Cargo', 'cargo', 'tar+gzip', 'demo-1.0.0/Cargo.toml', /name="demo"/u],
    ['pip', 'pypi', 'tar+gzip', 'demo-1.0.0/PKG-INFO', /Name: demo/u],
    ['uv', 'pypi', 'tar+gzip', 'demo-1.0.0/setup.py', /setuptools/u],
    ['NuGet', 'nuget', 'zip', 'demo.nuspec', /<id>demo<\/id>/u],
    [
      'Maven',
      'maven',
      'zip',
      'META-INF/MANIFEST.MF',
      /Manifest-Version: 1\.0/u,
    ],
    ['Go', 'golang', 'zip', 'demo@v1.0.0/go.mod', /module demo/u],
    ['Docker', 'oci', 'tar', 'oci-layout', /"imageLayoutVersion":"1\.0\.0"/u],
    ['Podman', 'oci', 'tar', 'index.json', /"schemaVersion":2/u],
    ['Chocolatey', 'chocolatey', 'zip', 'demo.nuspec', /<id>demo<\/id>/u],
  ] as const)(
    '%s standard %s output matches its required archive structure',
    async (_manager, target, format, expectedPath, expectedContents) => {
      const artifacts = await standardEmitters[target].emit(normalized(target));
      const archive = artifacts.find((artifact) =>
        target === 'golang' ? artifact.fileName.endsWith('.zip') : true,
      )!;
      const entries = await inspectArchive(archive.bytes, format);
      const entry = entries.find(({ path }) => path === expectedPath);
      expect(entry).toBeDefined();
      expect(new TextDecoder().decode(entry!.data)).toMatch(expectedContents);
    },
  );

  it.each([
    ['Nix', 'nix'],
    ['APT/dpkg', 'deb'],
    ['WinGet', 'winget'],
  ] as const)(
    '%s standard %s output matches its required native structure',
    async (_manager, target) => {
      const artifact = (
        await standardEmitters[target].emit(normalized(target))
      )[0]!;
      if (target === 'nix') {
        expect(readNarString(artifact.bytes, 0).value).toBe('nix-archive-1');
      } else if (target === 'deb') {
        expect(arMembers(artifact.bytes)).toEqual([
          'debian-binary',
          'control.tar.gz',
          'data.tar.gz',
        ]);
      } else {
        expect(artifact.fileName).toBe('demo.installer.yaml');
        expect(new TextDecoder().decode(artifact.bytes)).toContain(
          'ManifestType: singleton',
        );
      }
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
    expect(
      (
        await inspectArchive(arMember(deb.bytes, 'control.tar.gz'), 'tar+gzip')
      ).map(({ path }) => path),
    ).toEqual(['control']);
    expect(
      (
        await inspectArchive(arMember(deb.bytes, 'data.tar.gz'), 'tar+gzip')
      ).map(({ path }) => path),
    ).toContain('hello.txt');

    const nar = (await standardEmitters.nix.emit(normalized('nix')))[0]!;
    expect(narStrings(nar.bytes)).toEqual(
      expect.arrayContaining(['nix-archive-1', 'hello.txt', 'hello']),
    );
  });

  it('orders Unicode NAR entries by canonical code units', async () => {
    const input = normalized('nix');
    input.files = [
      { path: 'ä', contents: new Uint8Array([1]), executable: false },
      { path: 'z', contents: new Uint8Array([2]), executable: false },
    ];
    const artifact = (await standardEmitters.nix.emit(input))[0]!;
    const values = narStrings(artifact.bytes);
    expect(values.indexOf('z')).toBeLessThan(values.indexOf('ä'));
  });

  it('emits an internally complete OCI digest graph', async () => {
    const artifact = (await standardEmitters.oci.emit(normalized('oci')))[0]!;
    const entries = await inspectArchive(artifact.bytes, 'tar');
    const blobs = new Map(entries.map((entry) => [entry.path, entry.data]));
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const index = JSON.parse(
      new TextDecoder().decode(blobs.get('index.json')!),
    ) as { manifests: Array<{ digest: string; size: number }> };
    const manifestDescriptor = index.manifests[0]!;
    const manifest = digestBlob(blobs, manifestDescriptor);
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const parsed = JSON.parse(new TextDecoder().decode(manifest)) as {
      config: { digest: string; size: number };
      layers: Array<{ digest: string; size: number }>;
    };
    digestBlob(blobs, parsed.config);
    for (const layer of parsed.layers) digestBlob(blobs, layer);
  });

  it('emits a complete Go module proxy set', async () => {
    const artifacts = await standardEmitters.golang.emit(normalized('golang'));
    expect(artifacts.map(({ nativeRole }) => nativeRole)).toEqual([
      'module-zip',
      'module-file',
      'version-info',
    ]);
    expect(new TextDecoder().decode(artifacts[1]!.bytes)).toBe('module demo\n');
    expect(JSON.parse(new TextDecoder().decode(artifacts[2]!.bytes))).toEqual({
      Time: '1970-01-01T00:00:00Z',
      Version: 'v1.0.0',
    });
  });

  it('keeps a WinGet package as a typed native manifest set', async () => {
    const artifacts = await standardEmitters.winget.emit(normalized('winget'));
    expect(artifacts.map((artifact) => artifact.fileName)).toEqual([
      'demo.installer.yaml',
    ]);
    expect(artifacts[0]?.nativeRole).toBe('manifest');
  });

  it('rejects incomplete WinGet YAML instead of relabelling it', async () => {
    const input = normalized('winget');
    input.files[0]!.contents = new TextEncoder().encode('hello');
    await expect(standardEmitters.winget.emit(input)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it.each([
    ['npm', 'npm package.json'],
    ['cargo', 'Cargo.toml'],
    ['pypi', 'Python build manifest'],
    ['chocolatey', '.nuspec manifest'],
  ] as const)('rejects %s output without %s', async (target, _description) => {
    const input = normalized(target);
    input.files = input.files.filter(
      (file) =>
        ![
          'package.json',
          'Cargo.toml',
          'pyproject.toml',
          'setup.py',
          'setup.cfg',
          'demo.nuspec',
        ].includes(file.path),
    );
    await expect(standardEmitters[target].emit(input)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
});

function arMembers(bytes: Uint8Array): string[] {
  return arEntries(bytes).map(({ name }) => name);
}

function arMember(bytes: Uint8Array, name: string): Uint8Array {
  return arEntries(bytes).find((entry) => entry.name === name)!.bytes;
}

function arEntries(bytes: Uint8Array) {
  const entries: Array<{ name: string; bytes: Uint8Array }> = [];
  let offset = 8;
  while (offset < bytes.byteLength) {
    const header = new TextDecoder().decode(bytes.slice(offset, offset + 60));
    const name = header.slice(0, 16).trim().replace(/\/$/u, '');
    const size = Number(header.slice(48, 58).trim());
    entries.push({ name, bytes: bytes.slice(offset + 60, offset + 60 + size) });
    offset += 60 + size + (size % 2);
  }
  return entries;
}

function narStrings(bytes: Uint8Array): string[] {
  const values: string[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const value = readNarString(bytes, offset);
    values.push(value.value);
    offset = value.next;
  }
  return values;
}

function digestBlob(
  blobs: Map<string, Uint8Array>,
  descriptor: { digest: string; size: number },
): Uint8Array {
  const bytes = blobs.get(`blobs/sha256/${descriptor.digest.slice(7)}`)!;
  expect(bytes.byteLength).toBe(descriptor.size);
  expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(
    descriptor.digest,
  );
  return bytes;
}

function readNarString(bytes: Uint8Array, offset: number) {
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

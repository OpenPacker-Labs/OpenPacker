import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NativeRequirement } from '@openpacker/adapter-core';
import { NugetProjectFormat } from './project.js';

const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <Nullable>enable</Nullable>
  </PropertyGroup>

  <!-- Kept deliberately: proves comments survive an edit. -->
  <ItemGroup>
    <PackageReference Include="Serilog" Version="3.1.1" />
  </ItemGroup>

</Project>
`;

async function project(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'nuget-project-'));
  for (const [name, contents] of Object.entries(files))
    await writeFile(join(dir, name), contents);
  const format = new NugetProjectFormat();
  const detected = await format.detect(dir);
  if (!detected) throw new Error('fixture was not detected as a NuGet project');
  return {
    dir,
    format,
    detected,
    read: (name: string) => readFile(join(dir, name), 'utf8'),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const requirement = (
  name: string,
  range: string,
  scope: NativeRequirement['scope'] = 'runtime',
): NativeRequirement => ({
  purl: `pkg:nuget/${name}`,
  name,
  range,
  scope,
});

describe('NugetProjectFormat', () => {
  it('updates a version in place and leaves comments and formatting alone', async () => {
    const fixture = await project({ 'app.csproj': CSPROJ });
    try {
      const result = await fixture.format.writeManifest(fixture.detected, [
        requirement('Serilog', '4.0.0'),
      ]);
      expect(result.written).toEqual([fixture.detected.manifestPath]);
      const text = await fixture.read('app.csproj');
      expect(text).toContain(
        '<PackageReference Include="Serilog" Version="4.0.0" />',
      );
      expect(text).toContain(
        '<!-- Kept deliberately: proves comments survive an edit. -->',
      );
      expect(text).toContain('    <Nullable>enable</Nullable>');
    } finally {
      await fixture.cleanup();
    }
  });

  it('adds a new reference beside its siblings, not in a new group', async () => {
    const fixture = await project({ 'app.csproj': CSPROJ });
    try {
      await fixture.format.writeManifest(fixture.detected, [
        requirement('Serilog', '3.1.1'),
        requirement('Newtonsoft.Json', '13.0.3'),
      ]);
      const text = await fixture.read('app.csproj');
      expect(text.match(/<ItemGroup>/gu)).toHaveLength(1);
      expect(text).toContain(
        '<PackageReference Include="Newtonsoft.Json" Version="13.0.3" />',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('creates an ItemGroup when the project has none', async () => {
    const fixture = await project({
      'app.csproj':
        '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net9.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n',
    });
    try {
      await fixture.format.writeManifest(fixture.detected, [
        requirement('Serilog', '4.0.0'),
      ]);
      const text = await fixture.read('app.csproj');
      expect(text).toContain('<ItemGroup>');
      expect(text).toContain(
        '<PackageReference Include="Serilog" Version="4.0.0" />',
      );
      expect(text.trimEnd().endsWith('</Project>')).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it('writes development scope as PrivateAssets=all and reads it back', async () => {
    const fixture = await project({ 'app.csproj': CSPROJ });
    try {
      await fixture.format.writeManifest(fixture.detected, [
        requirement('StyleCop.Analyzers', '1.2.0', 'development'),
      ]);
      const read = await fixture.format.readRequirements(fixture.detected);
      expect(read).toContainEqual({
        purl: 'pkg:nuget/StyleCop.Analyzers',
        name: 'StyleCop.Analyzers',
        range: '1.2.0',
        scope: 'development',
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it('puts the version in Directory.Packages.props under central management', async () => {
    // Writing Version on the PackageReference here is MSBuild error NU1008.
    const fixture = await project({
      'app.csproj': CSPROJ,
      'Directory.Packages.props':
        '<Project>\n  <PropertyGroup>\n    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>\n  </PropertyGroup>\n  <ItemGroup>\n    <PackageVersion Include="Serilog" Version="3.1.1" />\n  </ItemGroup>\n</Project>\n',
    });
    try {
      await fixture.format.writeManifest(fixture.detected, [
        requirement('Serilog', '4.0.0'),
      ]);
      const props = await fixture.read('Directory.Packages.props');
      const csproj = await fixture.read('app.csproj');
      expect(props).toContain(
        '<PackageVersion Include="Serilog" Version="4.0.0" />',
      );
      expect(csproj).toContain('<PackageReference Include="Serilog" />');
      expect(csproj).not.toContain('Version="4.0.0"');
    } finally {
      await fixture.cleanup();
    }
  });

  it('is idempotent — a second write changes nothing', async () => {
    const fixture = await project({ 'app.csproj': CSPROJ });
    try {
      const reqs = [
        requirement('Serilog', '4.0.0'),
        requirement('Newtonsoft.Json', '13.0.3'),
      ];
      await fixture.format.writeManifest(fixture.detected, reqs);
      const first = await fixture.read('app.csproj');
      const second = await fixture.format.writeManifest(fixture.detected, reqs);
      expect(second.written).toEqual([]);
      expect(await fixture.read('app.csproj')).toBe(first);
    } finally {
      await fixture.cleanup();
    }
  });

  it('escapes a version that would otherwise break the XML', async () => {
    const fixture = await project({ 'app.csproj': CSPROJ });
    try {
      await fixture.format.writeManifest(fixture.detected, [
        requirement('Serilog', '[1.0,2.0) & up'),
      ]);
      const text = await fixture.read('app.csproj');
      expect(text).toContain('Version="[1.0,2.0) &amp; up"');
    } finally {
      await fixture.cleanup();
    }
  });

  it('refuses to guess between sibling project files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nuget-project-'));
    try {
      await writeFile(join(dir, 'one.csproj'), CSPROJ);
      await writeFile(join(dir, 'two.csproj'), CSPROJ);
      // Writing into the wrong project of a pair is worse than doing nothing.
      expect(await new NugetProjectFormat().detect(dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('NugetProjectFormat — packages.lock.json', () => {
  const entry = (name: string, version: string, hash?: string) => ({
    purl: `pkg:nuget/${name}`,
    exactPurl: `pkg:nuget/${name}@${version}`,
    name,
    version,
    scope: 'runtime' as const,
    source: `https://api.nuget.org/v3-flatcontainer/${name}`,
    digest: `sha256:${'0'.repeat(64)}`,
    size: 10,
    transitive: false,
    ...(hash && {
      nativeIntegrity: {
        algorithm: 'sha512',
        value: hash,
        encoding: 'base64',
      },
    }),
  });

  it('keys the lock by the project target framework', async () => {
    const fixture = await project({ 'app.csproj': CSPROJ });
    try {
      const result = await fixture.format.writeLockfile!(fixture.detected, [
        entry('Serilog', '4.0.0', 'BASE64HASH=='),
      ]);
      expect(result.written).toHaveLength(1);
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const lock = JSON.parse(await fixture.read('packages.lock.json')) as {
        version: number;
        dependencies: Record<string, Record<string, { contentHash: string }>>;
      };
      // The fixture declares net9.0; guessing a framework here would make
      // `dotnet restore --locked-mode` reject the file.
      expect(Object.keys(lock.dependencies)).toEqual(['net9.0']);
      expect(lock.dependencies['net9.0']?.Serilog?.contentHash).toBe(
        'BASE64HASH==',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('refuses rather than writing a package with no contentHash', async () => {
    const fixture = await project({ 'app.csproj': CSPROJ });
    try {
      const result = await fixture.format.writeLockfile!(fixture.detected, [
        entry('Serilog', '4.0.0'),
      ]);
      expect(result.written).toEqual([]);
      expect(result.semanticLoss[0]?.code).toBe(
        'NATIVE_LOCK_INTEGRITY_UNAVAILABLE',
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('NugetProjectFormat — pack', () => {
  it('rejects a target framework that escapes the project', async () => {
    const fixture = await project({
      'app.csproj': CSPROJ.replace('net9.0', '../../../outside'),
    });
    try {
      await expect(
        fixture.format.pack!(fixture.detected),
      ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects traversal in package metadata before writing', async () => {
    const fixture = await project({
      'app.csproj': CSPROJ.replace(
        '    <Nullable>enable</Nullable>',
        '    <Nullable>enable</Nullable>\n    <PackageId>Demo</PackageId>\n    <Version>../../../victim</Version>',
      ),
    });
    try {
      await expect(
        fixture.format.pack!(fixture.detected),
      ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
      await expect(
        readFile(join(fixture.dir, 'victim.nupkg')),
      ).rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });
});

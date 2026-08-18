import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parityContainerCommand } from '../../../scripts/pack-parity-container.mjs';
import { standardEmitters } from './standard-pack.js';
import { normalized } from './standard-pack.fixture.js';

type Target = keyof typeof standardEmitters;
type NativeCase = {
  manager: string;
  target: Target;
  imageEnvironment: string;
  command: readonly string[];
};

const mode = process.env.OPENPACKER_NATIVE_PACK_PARITY ?? '';
const runtime = process.env.OPENPACKER_PARITY_RUNTIME ?? 'docker';
const platform = mode === 'windows' ? 'windows' : 'linux';
let artifacts = '';

const linuxCases: readonly NativeCase[] = [
  {
    manager: 'npm',
    target: 'npm',
    imageEnvironment: 'OPENPACKER_PARITY_NPM_IMAGE',
    command: [
      'npm',
      'install',
      '--ignore-scripts',
      '--offline',
      '--no-audit',
      '--no-fund',
      '--prefix=/work/install',
      '/input/demo-1.0.0.tgz',
    ],
  },
  {
    manager: 'Cargo',
    target: 'cargo',
    imageEnvironment: 'OPENPACKER_PARITY_CARGO_IMAGE',
    command: [
      'sh',
      '-ceu',
      'mkdir /work/source && tar -xzf /input/demo-1.0.0.crate -C /work/source --strip-components=1 && cargo metadata --offline --format-version=1 --manifest-path /work/source/Cargo.toml',
    ],
  },
  {
    manager: 'pip',
    target: 'pypi',
    imageEnvironment: 'OPENPACKER_PARITY_PIP_IMAGE',
    command: [
      'python',
      '-m',
      'pip',
      'install',
      '--no-index',
      '--no-deps',
      '--no-build-isolation',
      '--target=/work/install',
      '/input/demo-1.0.0.tar.gz',
    ],
  },
  {
    manager: 'uv',
    target: 'pypi',
    imageEnvironment: 'OPENPACKER_PARITY_UV_IMAGE',
    command: [
      'uv',
      'pip',
      'install',
      '--offline',
      '--no-deps',
      '--no-build-isolation',
      '--target=/work/install',
      '/input/demo-1.0.0.tar.gz',
    ],
  },
  {
    manager: 'NuGet',
    target: 'nuget',
    imageEnvironment: 'OPENPACKER_PARITY_NUGET_IMAGE',
    command: [
      'sh',
      '-ceu',
      'printf %s \'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="demo" Version="1.0.0" /></ItemGroup></Project>\' > /work/demo.csproj && dotnet restore /work/demo.csproj --packages /work/packages --source /input --ignore-failed-sources',
    ],
  },
  {
    manager: 'Maven',
    target: 'maven',
    imageEnvironment: 'OPENPACKER_PARITY_MAVEN_IMAGE',
    command: [
      'mvn',
      '--offline',
      'install:install-file',
      '-Dfile=/input/demo-1.0.0.jar',
      '-DgroupId=dev.openpacker',
      '-DartifactId=demo',
      '-Dversion=1.0.0',
      '-Dpackaging=jar',
      '-DgeneratePom=true',
      '-Dmaven.repo.local=/work/repository',
    ],
  },
  {
    manager: 'Go',
    target: 'golang',
    imageEnvironment: 'OPENPACKER_PARITY_GO_IMAGE',
    command: [
      'sh',
      '-ceu',
      'mkdir -p /work/proxy/demo/@v /work/client && cp /input/demo-v1.0.0.* /work/proxy/demo/@v/ && printf "module client\\nrequire demo v1.0.0\\n" > /work/client/go.mod && cd /work/client && GOPROXY=file:///work/proxy GOSUMDB=off go mod download demo@v1.0.0',
    ],
  },
  {
    manager: 'Docker/Podman OCI',
    target: 'oci',
    imageEnvironment: 'OPENPACKER_PARITY_OCI_IMAGE',
    command: [
      'skopeo',
      'inspect',
      '--config',
      'oci-archive:/input/demo-1.0.0.oci.tar',
    ],
  },
  {
    manager: 'Nix',
    target: 'nix',
    imageEnvironment: 'OPENPACKER_PARITY_NIX_IMAGE',
    command: ['nix', 'nar', 'ls', '/input/demo-1.0.0.nar'],
  },
  {
    manager: 'APT/dpkg',
    target: 'deb',
    imageEnvironment: 'OPENPACKER_PARITY_APT_IMAGE',
    command: ['dpkg-deb', '--info', '/input/demo-1.0.0.deb'],
  },
];

const windowsCases: readonly NativeCase[] = [
  {
    manager: 'WinGet',
    target: 'winget',
    imageEnvironment: 'OPENPACKER_PARITY_WINGET_IMAGE',
    command: [
      'winget',
      'validate',
      '--manifest',
      'C:\\input',
      '--disable-interactivity',
      '--no-proxy',
    ],
  },
  {
    manager: 'Chocolatey',
    target: 'chocolatey',
    imageEnvironment: 'OPENPACKER_PARITY_CHOCOLATEY_IMAGE',
    command: ['choco', 'info', 'demo', '--source=C:\\input', '--limit-output'],
  },
];

const selected = mode === 'windows' ? windowsCases : linuxCases;

describe.runIf(mode === 'linux' || mode === 'windows')(
  `native ${mode} pack parity`,
  () => {
    beforeAll(async () => {
      artifacts = await mkdtemp(join(tmpdir(), 'openpacker-pack-parity-'));
      const targets = new Set(selected.map(({ target }) => target));
      for (const target of targets)
        for (const artifact of await standardEmitters[target].emit(
          normalized(target),
        ))
          await writeFile(join(artifacts, artifact.fileName), artifact.bytes, {
            mode: 0o444,
          });
      await chmod(artifacts, 0o555);
    });

    afterAll(async () => {
      if (artifacts !== '') {
        await chmod(artifacts, 0o700);
        await rm(artifacts, { recursive: true, force: true });
      }
    });

    it.each(selected)(
      '$manager accepts the emitted $target artifact',
      ({ imageEnvironment, command }) => {
        const image = process.env[imageEnvironment];
        expect(image, `${imageEnvironment} is required`).toBeTruthy();
        const plan = parityContainerCommand({
          runtime,
          image: image!,
          artifactDirectory: artifacts,
          command: [...command],
          platform,
        });
        const result = spawnSync(plan.executable, plan.arguments, {
          stdio: 'inherit',
          shell: false,
          timeout: 120_000,
        });
        if (result.error) throw result.error;
        expect(result.signal).toBeNull();
        expect(result.status).toBe(0);
      },
      130_000,
    );
  },
);

describe.runIf(!['', 'linux', 'windows'].includes(mode))(
  'native pack parity mode',
  () => {
    it('rejects an unknown host execution mode', () => {
      expect(mode).toMatch(/^(linux|windows)$/u);
    });
  },
);

describe.runIf(mode === '')('native pack parity (skipped)', () => {
  it('covers every standard target without enabling host execution', () => {
    expect(mode).toBe('');
    expect(
      [
        ...new Set(
          [...linuxCases, ...windowsCases].map(({ target }) => target),
        ),
      ].sort(),
    ).toEqual(Object.keys(standardEmitters).sort());
    expect(
      [...linuxCases, ...windowsCases].map(({ manager }) => manager),
    ).toEqual([
      'npm',
      'Cargo',
      'pip',
      'uv',
      'NuGet',
      'Maven',
      'Go',
      'Docker/Podman OCI',
      'Nix',
      'APT/dpkg',
      'WinGet',
      'Chocolatey',
    ]);
  });
});

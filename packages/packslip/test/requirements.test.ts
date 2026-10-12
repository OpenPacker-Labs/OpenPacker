import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkRequirements,
  compareDotted,
  detectHost,
  type Artifact,
  type HostFacts,
} from '../src/index.js';

const artifact = (
  requires: Artifact['requires'],
  libc: string | null = 'gnu',
): Artifact => ({
  name: 'tool.tar.gz',
  size: 1,
  format: 'tar.gz',
  os: 'linux',
  ...(libc !== null && { libc }),
  ...(requires !== undefined && { requires }),
});

describe('comparing minimum versions', () => {
  it.each([
    ['2.10', '2.9', 1],
    ['2.9', '2.10', -1],
    ['17', '17.0.0', 0],
    ['21', '17', 1],
    ['16.9', '17', -1],
    ['6.18.44-fc-v114', '5.15', 1],
    ['5.15.0+', '5.15', 0],
    ['10.0.17763', '10.0.17134', 1],
  ])('%s against %s is %d', (left, right, expected) => {
    expect(compareDotted(left, right)).toBe(expected);
  });

  it.each([
    ['', '1'],
    ['abc', '1'],
    ['v1.2', '1'],
    ['1', ''],
    ['1', 'latest'],
  ])('cannot compare %j with %j, so the answer is unknown', (left, right) => {
    expect(compareDotted(left, right)).toBeUndefined();
  });
});

describe('checking what the host must provide', () => {
  const linux: HostFacts = {
    os: 'linux',
    osVersion: '6.1.0',
    glibcVersion: '2.36',
  };

  it('passes an artifact that declares nothing', () => {
    expect(checkRequirements(artifact(undefined), linux)).toEqual({
      refusals: [],
      warnings: [],
    });
  });

  it('refuses an old glibc, an old OS, and a missing library: those stop the program starting', () => {
    const report = checkRequirements(
      artifact({
        glibcMin: '2.39',
        osMin: '6.8',
        libs: ['libssl.so.3', 'libz.so.1'],
      }),
      { ...linux, hasLibrary: (name) => name === 'libz.so.1' },
    );
    expect(report.refusals).toHaveLength(3);
    expect(report.refusals.join('\n')).toContain('glibc 2.39');
    expect(report.refusals.join('\n')).toContain('linux 6.8');
    expect(report.refusals.join('\n')).toContain('libssl.so.3');
    expect(report.refusals.join('\n')).not.toContain('libz.so.1');
  });

  it('meets a requirement exactly at the minimum', () => {
    expect(
      checkRequirements(artifact({ glibcMin: '2.36', osMin: '6.1' }), linux)
        .refusals,
    ).toEqual([]);
  });

  it('applies glibc_min only to a gnu build', () => {
    expect(
      checkRequirements(artifact({ glibcMin: '9.9' }, 'musl'), linux).refusals,
    ).toEqual([]);
    expect(
      checkRequirements(artifact({ glibcMin: '9.9' }, null), linux).refusals,
    ).toEqual([]);
  });

  it('warns, and never refuses, when it cannot tell', () => {
    const report = checkRequirements(
      artifact({
        glibcMin: '2.39',
        osMin: '6.8',
        libs: ['libssl.so.3'],
        bin: [{ name: 'java', min: '17' }],
      }),
      { os: 'linux' },
    );
    expect(report.refusals).toEqual([]);
    expect(report.warnings).toHaveLength(4);
  });

  it('warns about a missing or old command rather than refusing', () => {
    const command = (found: boolean, version?: string): HostFacts => ({
      ...linux,
      command: () => ({ found, ...(version !== undefined && { version }) }),
    });
    const need = artifact({ bin: [{ name: 'java', min: '17' }] });
    expect(checkRequirements(need, command(false))).toMatchObject({
      refusals: [],
      warnings: [expect.stringContaining('not on PATH')],
    });
    expect(checkRequirements(need, command(true, '11.0.2'))).toMatchObject({
      refusals: [],
      warnings: [expect.stringContaining('found 11.0.2')],
    });
    expect(checkRequirements(need, command(true, '21')).warnings).toEqual([]);
    expect(checkRequirements(need, command(true)).warnings[0]).toContain(
      'Could not read the version',
    );
    expect(
      checkRequirements(artifact({ bin: [{ name: 'git' }] }), command(true))
        .warnings,
    ).toEqual([]);
  });

  it('refuses nothing for an empty library list: the executables were inspected and need none', () => {
    expect(checkRequirements(artifact({ libs: [] }), linux)).toEqual({
      refusals: [],
      warnings: [],
    });
  });
});

describe('describing the host', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const directory of dirs.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    [
      { platform: 'linux', arch: 'x64', glibcVersion: '2.36' },
      { os: 'linux', arch: 'x86_64', libc: 'gnu' },
    ],
    [
      { platform: 'linux', arch: 'arm64', musl: true },
      { os: 'linux', arch: 'aarch64', libc: 'musl' },
    ],
    [
      { platform: 'linux', arch: 'x64' },
      { os: 'linux', arch: 'x86_64' },
    ],
    [
      { platform: 'darwin', arch: 'arm64' },
      { os: 'darwin', arch: 'aarch64' },
    ],
    [
      { platform: 'win32', arch: 'x64' },
      { os: 'windows', arch: 'x86_64' },
    ],
    [
      { platform: 'win32', arch: 'arm64' },
      { os: 'windows', arch: 'aarch64' },
    ],
    [
      { platform: 'freebsd', arch: 'ia32' },
      { os: 'freebsd', arch: 'i686' },
    ],
    [
      { platform: 'linux', arch: 'riscv64', glibcVersion: '2.39' },
      { os: 'linux', arch: 'riscv64', libc: 'gnu' },
    ],
  ])('maps %j to packslip’s vocabulary', (runtime, expected) => {
    expect(
      detectHost({ kernelRelease: '1.0.0', env: {}, ...runtime }).platform,
    ).toEqual(expected);
  });

  it('never reports a libc on a platform without one', () => {
    expect(
      detectHost({
        platform: 'darwin',
        arch: 'arm64',
        glibcVersion: '2.36',
        kernelRelease: '24.0.0',
        env: {},
      }).platform.libc,
    ).toBeUndefined();
  });

  it('reads the kernel on Linux, and offers no OS version on macOS where it is not the product version', () => {
    expect(
      detectHost({
        platform: 'linux',
        arch: 'x64',
        kernelRelease: '6.1.0-13-amd64',
        env: {},
      }).facts.osVersion,
    ).toBe('6.1.0-13-amd64');
    expect(
      detectHost({
        platform: 'darwin',
        arch: 'arm64',
        kernelRelease: '24.1.0',
        env: {},
      }).facts.osVersion,
    ).toBeUndefined();
  });

  it('finds a command on PATH without running it, and not one that is absent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'packslip-path-'));
    dirs.push(directory);
    writeFileSync(join(directory, 'present'), '#!/bin/sh\nexit 99\n', {
      mode: 0o755,
    });
    mkdirSync(join(directory, 'dir-not-file'));
    const host = detectHost({
      platform: 'linux',
      arch: 'x64',
      kernelRelease: '1',
      env: { PATH: `${directory}:/nonexistent` },
    });
    expect(host.facts.command?.('present')).toEqual({ found: true });
    expect(host.facts.command?.('absent')).toEqual({ found: false });
    expect(host.facts.command?.('dir-not-file')).toEqual({ found: false });
  });

  it('looks for a shared library in the directories it is told the loader searches, including multiarch ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'packslip-lib-'));
    dirs.push(root);
    mkdirSync(join(root, 'x86_64-linux-gnu'));
    writeFileSync(join(root, 'libz.so.1'), '');
    writeFileSync(join(root, 'x86_64-linux-gnu', 'libssl.so.3'), '');
    const host = detectHost({
      platform: 'linux',
      arch: 'x64',
      kernelRelease: '1',
      env: {},
      libraryDirectories: [root],
    });
    expect(host.facts.hasLibrary?.('libz.so.1')).toBe(true);
    expect(host.facts.hasLibrary?.('libssl.so.3')).toBe(true);
    expect(host.facts.hasLibrary?.('libnope.so.1')).toBe(false);
  });

  it('cannot check libraries off Linux, which makes the check unknown rather than failed', () => {
    expect(
      detectHost({
        platform: 'win32',
        arch: 'x64',
        kernelRelease: '10.0.19045',
        env: {},
      }).facts.hasLibrary,
    ).toBeUndefined();
  });

  it('detects the real machine without throwing', () => {
    const host = detectHost();
    expect(host.platform.os).toMatch(/^[a-z]+$/u);
    expect(host.platform.arch).toMatch(/^[a-z0-9_]+$/u);
  });
});

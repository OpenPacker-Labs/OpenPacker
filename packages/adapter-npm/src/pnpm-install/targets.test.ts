import { describe, expect, it } from 'vitest';
import type { FrozenLockOptions } from '@openpacker/adapter-core';
import type { PnpmProjectConfig } from './config.js';
import { platformsOf } from './targets.js';

const HOST = { os: 'linux', architecture: 'x64', libc: 'glibc' } as const;
const options = (more: Partial<FrozenLockOptions> = {}): FrozenLockOptions => ({
  target: HOST,
  omit: new Set(),
  ...more,
});
const config = (
  supportedArchitectures?: PnpmProjectConfig['supportedArchitectures'],
): PnpmProjectConfig => ({
  overrides: new Map(),
  catalogs: new Map(),
  supportedArchitectures,
  patches: [],
  project: {},
  ignoredOptionalDependencies: [],
});

describe('the machines an install is for', () => {
  it('is the host alone by default', () => {
    expect(platformsOf(options(), config())).toEqual([HOST]);
  });

  it('is the machines the host was told', () => {
    const arm = { os: 'linux', architecture: 'arm64', libc: 'glibc' };
    expect(platformsOf(options({ targets: [HOST, arm] }), config())).toEqual([
      HOST,
      arm,
    ]);
  });

  it("takes the project's own supportedArchitectures when asked, `current` being the host", () => {
    // HoBo's: os [current], cpu [arm64, x64, current].
    expect(
      platformsOf(
        options({ architectures: 'project' }),
        config({
          os: ['current'],
          cpu: ['arm64', 'x64', 'current'],
          libc: ['current'],
        }),
      ),
    ).toEqual([
      { os: 'linux', architecture: 'arm64', libc: 'glibc' },
      { os: 'linux', architecture: 'x64', libc: 'glibc' },
    ]);
  });

  it('crosses the lists, and gives libc to linux only', () => {
    expect(
      platformsOf(
        options({ architectures: 'project' }),
        config({
          os: ['linux', 'darwin'],
          cpu: ['x64'],
          libc: ['glibc', 'musl'],
        }),
      ),
    ).toEqual([
      { os: 'linux', architecture: 'x64', libc: 'glibc' },
      { os: 'linux', architecture: 'x64', libc: 'musl' },
      { os: 'darwin', architecture: 'x64' },
    ]);
  });

  it('refuses `project` when the project sets nothing, and says what to use', () => {
    expect(() =>
      platformsOf(options({ architectures: 'project' }), config()),
    ).toThrow(/sets no supportedArchitectures[\s\S]*--os, --cpu and --libc/u);
  });
});

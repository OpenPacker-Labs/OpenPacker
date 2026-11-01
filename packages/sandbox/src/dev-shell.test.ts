import { describe, expect, it, vi } from 'vitest';
import {
  createMockBackend,
  runDevShell,
  type DevShellPlan,
} from './dev-shell.js';
import { planLxcBindDevices, probeLxc } from './backends/lxc.js';
import { scratch } from './test-scratch.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('dev-shell', () => {
  const plan: DevShellPlan = {
    projectRoot: '/proj',
    cwd: '/proj',
    readonlyPaths: ['/proj/.opm/store'],
    readwritePaths: ['/proj'],
    env: { OPM_BIN: '/proj/.opm/bin', PATH: '/proj/.opm/bin:/usr/bin' },
    network: false,
  };

  it('runDevShell runs argv through injected mock backend', async () => {
    const dir = scratch('dev-shell-run-');
    const localPlan: DevShellPlan = {
      ...plan,
      projectRoot: dir,
      cwd: dir,
      readwritePaths: [dir],
      readonlyPaths: [],
    };
    const backend = createMockBackend();
    const run = vi.spyOn(backend, 'run');
    const { exitCode, backend: id } = await runDevShell({
      plan: localPlan,
      prefer: 'mxc',
      backend,
      argv: ['/usr/bin/true'],
    });
    expect(id).toBe('mock');
    expect(exitCode).toBe(0);
    expect(run).toHaveBeenCalledOnce();
  });

  it('planLxcBindDevices deduplicates project root', async () => {
    const dir = scratch('lxc-plan-');
    await mkdir(join(dir, '.opm', 'store'), { recursive: true });
    await writeFile(join(dir, 'opm.lock.json'), '{}');
    const devices = planLxcBindDevices({
      projectRoot: dir,
      readonlyPaths: [join(dir, '.opm', 'store')],
      readwritePaths: [dir],
    });
    const paths = devices.map((d) => d.source);
    expect(new Set(paths).size).toBe(paths.length);
    expect(devices.some((d) => d.name === 'project')).toBe(true);
  });
});

describe('probeLxc', () => {
  it('reports unavailable when incus/lxc are absent', async () => {
    const probe = await probeLxc();
    if (probe.available) return;
    expect(probe.id).toBe('lxc');
    expect(probe.reason).toBeTruthy();
  });
});

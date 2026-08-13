import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertGrantsNotDangerous,
  createMockBackend,
  digestSandboxPolicy,
  isDeniedCredential,
  JailPathError,
  matchPackageGrant,
  mxcFilesystemPaths,
  planSandboxSummary,
  resolvePolicy,
  runHostInstaller,
  runInSandbox,
  scrubEnvironment,
  SANDBOX_LOSS,
} from './index.js';

describe('@openpacker/sandbox', () => {
  it('defaults to fail-closed and auto prefer', () => {
    const resolved = resolvePolicy({});
    expect(resolved.mode).toBe('fail-closed');
    expect(resolved.prefer).toBe('auto');
    expect(resolved.required).toBe(true);
    expect(resolved.enabled).toBe(true);
  });

  it('scrubs credential-shaped env and rewrites HOME', () => {
    const env = scrubEnvironment({
      parent: {
        PATH: '/usr/bin',
        NPM_TOKEN: 'secret',
        AWS_SECRET_ACCESS_KEY: 'x',
        GITHUB_TOKEN: 'g',
        SAFE_OK: 'nope',
        npm_package_name: 'demo',
      },
      grantEnv: [],
      jailHome: '/tmp/jail-home',
    });
    // minimalPath defaults on when scrubbing for package-exec callers
    expect(env.PATH?.split(':')).toEqual(
      expect.arrayContaining(['/usr/bin', '/bin']),
    );
    expect(env.HOME).toBe('/tmp/jail-home');
    expect(env.NPM_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.SAFE_OK).toBeUndefined();
    expect(env.npm_package_name).toBe('demo');
  });

  it('allows granted credential env names only when listed', () => {
    expect(isDeniedCredential('NPM_TOKEN')).toBe(true);
    const env = scrubEnvironment({
      parent: { NPM_TOKEN: 'secret', PATH: '/bin' },
      grantEnv: ['NPM_TOKEN'],
      jailHome: '/tmp/j',
    });
    expect(env.NPM_TOKEN).toBe('secret');
  });

  it('matches package grants with coordinate boundaries', () => {
    const packages = {
      'pkg:npm/@acme/': { network: true },
      'pkg:npm/left-pad': { network: false, write: ['/tmp/x'] },
    };
    expect(matchPackageGrant('pkg:npm/@acme/sharp', packages)?.network).toBe(
      true,
    );
    expect(
      matchPackageGrant('pkg:npm/left-pad-installer', packages),
    ).toBeUndefined();
    expect(matchPackageGrant('pkg:npm/left-pad', packages)?.write).toEqual([
      '/tmp/x',
    ]);
  });

  it('policy digest is stable for equivalent policy objects', async () => {
    const a = await digestSandboxPolicy({
      mode: 'fail-closed',
      packages: { 'pkg:npm/a': { network: true }, 'pkg:npm/b': { env: ['X'] } },
    });
    const b = await digestSandboxPolicy({
      packages: { 'pkg:npm/b': { env: ['X'] }, 'pkg:npm/a': { network: true } },
      mode: 'fail-closed',
    });
    expect(a).toEqual(b);
  });

  it('fail-closed refuses when no backend is available', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'op-sandbox-'));
    const outcome = await runInSandbox({
      argv: [process.execPath, '-e', 'console.log("hi")'],
      cwd,
      policy: { mode: 'fail-closed', prefer: 'native' },
      readwritePaths: [cwd],
      readonlyPaths: [],
      backend: createMockBackend({ unavailable: true }),
    });
    expect(outcome.exitCode).not.toBe(0);
    expect(outcome.enforced).toBe(false);
    expect(outcome.backend).toBe('none');
    expect(
      outcome.losses.some((l) => l.code === SANDBOX_LOSS.UNAVAILABLE),
    ).toBe(true);
  });

  it('degrade-warn runs ambient when backend unavailable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'op-sandbox-'));
    const outcome = await runInSandbox({
      argv: [process.execPath, '-e', 'process.stdout.write("ok")'],
      cwd,
      policy: { mode: 'degrade-warn', required: false },
      readwritePaths: [cwd],
      readonlyPaths: [],
      backend: createMockBackend({ unavailable: true }),
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain('ok');
    expect(outcome.degraded).toBe(true);
    expect(outcome.losses.some((l) => l.code === SANDBOX_LOSS.DEGRADED)).toBe(
      true,
    );
  });

  it('mock backend executes argv with scrubbed env', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'op-sandbox-'));
    const script = join(cwd, 'probe.mjs');
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify({
        home: process.env.HOME,
        token: process.env.NPM_TOKEN ?? null,
      }))`,
    );
    const outcome = await runInSandbox({
      argv: [process.execPath, script],
      cwd,
      env: { NPM_TOKEN: 'should-not-leak' },
      policy: { mode: 'fail-closed' },
      readwritePaths: [cwd],
      readonlyPaths: [],
      backend: createMockBackend(),
    });
    expect(outcome.exitCode).toBe(0);
    const body = JSON.parse(outcome.stdout) as {
      home: string;
      token: string | null;
    };
    expect(body.token).toBeNull();
    expect(body.home).toContain('openpacker-sandbox');
  });

  it('mode off marks degraded ambient execution', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'op-sandbox-'));
    const outcome = await runInSandbox({
      argv: [process.execPath, '-e', 'process.stdout.write("off")'],
      cwd,
      policy: { mode: 'off' },
      readwritePaths: [cwd],
      readonlyPaths: [],
    });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.backend).toBe('off');
    expect(outcome.degraded).toBe(true);
    expect(outcome.enforced).toBe(false);
  });

  it('host installer helper records ambient loss when unsandboxed is allowed', async () => {
    const summary = planSandboxSummary({
      allowHostUnsandboxedInstall: true,
    });
    expect(summary.willEnforce).toBe(false);
    const result = await runHostInstaller({
      argv: [process.execPath, '-e', 'process.stdout.write("apt")'],
      ecosystem: 'deb',
      sandbox: { allowHostUnsandboxedInstall: true },
      ambientExecute: async () => ({ stdout: 'ok', stderr: '' }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.sandboxEnforced).toBe(false);
    expect(result.containmentLimited).toBe(true);
    expect(
      result.extraLosses.some(
        (l) => l.code === SANDBOX_LOSS.SYSTEM_NOT_SANDBOXED,
      ),
    ).toBe(true);
  });

  it('does not auto-grant MXC write on cwd (C2)', () => {
    const paths = mxcFilesystemPaths({
      readonlyPaths: ['/proj'],
      readwritePaths: ['/tmp/jail'],
      cwd: '/proj',
    });
    expect(paths.readwritePaths).not.toContain('/proj');
    expect(paths.readonlyPaths).toContain('/proj');
    const writable = mxcFilesystemPaths({
      readonlyPaths: [],
      readwritePaths: ['/proj'],
      cwd: '/proj',
    });
    expect(writable.readwritePaths).toContain('/proj');
  });

  it('refuses dangerous write grants unless allowed', () => {
    expect(() => assertGrantsNotDangerous(['/'], false)).toThrow(JailPathError);
    expect(() => assertGrantsNotDangerous(['/'], true)).not.toThrow();
  });

  it('refuses package-exec readonly binds of /', async () => {
    await expect(
      runInSandbox({
        argv: [process.execPath, '-e', 'process.exit(0)'],
        cwd: await mkdtemp(join(tmpdir(), 'op-sandbox-ro-')),
        policy: { mode: 'fail-closed' },
        profile: 'package-exec',
        readwritePaths: [],
        readonlyPaths: ['/'],
        backend: createMockBackend(),
      }),
    ).rejects.toBeInstanceOf(JailPathError);
  });

  it('refuses package-exec binds of / or the user home', async () => {
    await expect(
      runInSandbox({
        argv: [process.execPath, '-e', 'process.exit(0)'],
        cwd: '/',
        policy: { mode: 'fail-closed' },
        profile: 'package-exec',
        readwritePaths: ['/'],
        readonlyPaths: [],
        backend: createMockBackend(),
      }),
    ).rejects.toBeInstanceOf(JailPathError);
  });

  it('kills hung package-exec after timeout', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'op-sandbox-timeout-'));
    const started = Date.now();
    const outcome = await runInSandbox({
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 30_000)'],
      cwd,
      policy: { mode: 'fail-closed', timeoutMs: 250 },
      readwritePaths: [cwd],
      readonlyPaths: [],
      backend: createMockBackend(),
    });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(outcome.exitCode).not.toBe(0);
  });

  it('mock package-exec is not enforced (honesty)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'op-sandbox-'));
    const outcome = await runInSandbox({
      argv: [process.execPath, '-e', 'process.exit(0)'],
      cwd,
      policy: { mode: 'fail-closed' },
      profile: 'package-exec',
      readwritePaths: [cwd],
      readonlyPaths: [],
      backend: createMockBackend(),
    });
    expect(outcome.enforced).toBe(false);
    expect(outcome.profile).toBe('package-exec');
  });
});

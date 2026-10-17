import { constants } from 'node:fs';
import { chmod, open, readFile, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { collectMxcChild } from './backends/mxc.js';
import {
  assertGrantsNotDangerous,
  buildBwrapArgv,
  buildSeatbeltProfile,
  createMockBackend,
  digestSandboxPolicy,
  findTrustedSandboxHelper,
  findHostExecutable,
  isDeniedCredential,
  isPathInside,
  JailPathError,
  limitedContainmentLoss,
  matchPackageGrant,
  mxcFilesystemPaths,
  quoteCommandLine,
  networkToolMaskFiles,
  notSandboxedLoss,
  planSandboxSummary,
  probeNativeBackends,
  resolvePolicy,
  runHostInstaller,
  runInSandbox,
  SandboxBackendError,
  scrubEnvironment,
  SANDBOX_LOSS,
  sandboxPolicyFromInstallOptions,
  sensitiveMaskDirectories,
  sensitiveMaskFiles,
  type SandboxBackend,
} from './index.js';
import { scratch } from './test-scratch.js';

describe('@openpacker/sandbox', () => {
  it('does not trust a package-manager executable from project PATH', async () => {
    const directory = scratch('opm-host-path-');
    const name = `opm-project-manager-${process.pid}`;
    const executable = join(directory, name);
    await writeFile(executable, '#!/bin/sh\n');
    await chmod(executable, 0o755);
    await expect(
      findHostExecutable(name, { PATH: directory }),
    ).resolves.toBeUndefined();
  });

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

  it('denies OPM_HOST_FETCH_ names even when they are not suffix-shaped', () => {
    expect(isDeniedCredential('OPM_HOST_FETCH_BEARER')).toBe(true);
    expect(isDeniedCredential('OPM_HOST_FETCH_TOKEN_ENVS')).toBe(true);
    expect(isDeniedCredential('OPM_HOST_FETCH_ORIGINS')).toBe(true);
    const env = scrubEnvironment({
      parent: {
        OPM_HOST_FETCH_BEARER: 'tok68value',
        OPM_HOST_FETCH_TOKEN_ENVS: 'ACME_TOKEN',
        OPM_HOST_FETCH_ORIGINS: 'https://a.example',
        PATH: '/bin',
      },
      grantEnv: [],
      jailHome: '/tmp/j',
    });
    expect(env.OPM_HOST_FETCH_BEARER).toBeUndefined();
    expect(env.OPM_HOST_FETCH_TOKEN_ENVS).toBeUndefined();
    expect(env.OPM_HOST_FETCH_ORIGINS).toBeUndefined();
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
    const cwd = scratch('op-sandbox-');
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

  it('degrade-warn refuses ambient execution without owned tree containment', async () => {
    const cwd = scratch('op-sandbox-');
    await expect(
      runInSandbox({
        argv: [process.execPath, '-e', 'process.stdout.write("never")'],
        cwd,
        policy: { mode: 'degrade-warn', required: false },
        readwritePaths: [cwd],
        readonlyPaths: [],
        backend: createMockBackend({ unavailable: true }),
      }),
    ).rejects.toMatchObject({
      code: 'TREE_CONTAINMENT_UNAVAILABLE',
      message: expect.stringContaining('ambient execution is refused'),
    });
  });

  it('degrade-warn refuses ambient execution when MXC cannot consume directory authorities', async () => {
    // macOS/Windows outcome: the only probed backend is MXC, which fails
    // closed because every run requires stable directory-handle binds.
    const cwd = scratch('op-sandbox-');
    const mxc: SandboxBackend = {
      id: 'mxc',
      async run() {
        throw new SandboxBackendError(
          'UNAVAILABLE',
          'MXC SDK does not expose inherited directory-handle binds',
        );
      },
    };
    await expect(
      runInSandbox({
        argv: [process.execPath, '-e', 'process.stdout.write("never")'],
        cwd,
        policy: { mode: 'degrade-warn', required: false },
        readwritePaths: [cwd],
        readonlyPaths: [],
        backend: mxc,
      }),
    ).rejects.toMatchObject({
      code: 'TREE_CONTAINMENT_UNAVAILABLE',
      message: expect.stringContaining('ambient execution is refused'),
    });
  });

  it('mock backend executes argv with scrubbed env', async () => {
    const cwd = scratch('op-sandbox-');
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const body = JSON.parse(outcome.stdout) as {
      home: string;
      token: string | null;
    };
    expect(body.token).toBeNull();
    expect(body.home).toContain('openpacker-sandbox');
  });

  it('keeps a directory authority accessible after exec', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const cwd = scratch('op-sandbox-fd-');
    await writeFile(join(cwd, 'proof'), 'stable');
    const authority = await open(
      cwd,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const fdPath =
        process.platform === 'linux' ? '/proc/self/fd/3' : '/dev/fd/3';
      const outcome = await runInSandbox({
        argv: [
          process.execPath,
          '-e',
          `process.stdout.write(require('fs').readFileSync(${JSON.stringify(
            `${fdPath}/proof`,
          )}, 'utf8'))`,
        ],
        cwd,
        policy: { mode: 'fail-closed' },
        readwritePaths: [cwd],
        readonlyPaths: [],
        directoryAuthorities: [{ fd: authority.fd, path: cwd }],
        backend: createMockBackend(),
      });
      expect(outcome).toMatchObject({ exitCode: 0, stdout: 'stable' });
    } finally {
      await authority.close();
    }
  });

  it('mode off still refuses execution without owned tree containment', async () => {
    const cwd = scratch('op-sandbox-');
    await expect(
      runInSandbox({
        argv: [process.execPath, '-e', 'process.stdout.write("never")'],
        cwd,
        policy: { mode: 'off' },
        readwritePaths: [cwd],
        readonlyPaths: [],
      }),
    ).rejects.toMatchObject({
      code: 'TREE_CONTAINMENT_UNAVAILABLE',
      message: expect.stringContaining('ambient execution is refused'),
    });
  });

  it('rejects writable native sandbox helpers', async () => {
    const directory = scratch('op-sandbox-helper-');
    const helper = join(directory, 'bwrap');
    await writeFile(helper, '#!/bin/sh\nexit 0\n');
    await chmod(helper, 0o777);
    expect(findTrustedSandboxHelper('bwrap', [directory])).toBeUndefined();
  });

  it('bounds backend output', async () => {
    const cwd = scratch('op-sandbox-output-');
    const outcome = await runInSandbox({
      argv: [process.execPath, '-e', 'process.stdout.write("x".repeat(4096))'],
      cwd,
      policy: {
        mode: 'fail-closed',
        maximumStdoutBytes: 64,
        maximumStderrBytes: 64,
        maximumOutputBytes: 96,
      },
      readwritePaths: [cwd],
      readonlyPaths: [],
      backend: createMockBackend(),
    });
    expect(outcome.exitCode).toBe(125);
    expect(outcome.outputLimitExceeded).toBe('stdout');
    expect(Buffer.byteLength(outcome.stdout)).toBeLessThanOrEqual(64);
  });

  it('kills the process tree when output exceeds policy', async () => {
    const cwd = scratch('op-sandbox-tree-');
    const marker = join(cwd, 'escaped');
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped'), 300)`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)`;
    const outcome = await runInSandbox({
      argv: [process.execPath, '-e', parent],
      cwd,
      policy: {
        mode: 'fail-closed',
        maximumStdoutBytes: 64,
        maximumStderrBytes: 64,
        maximumOutputBytes: 96,
      },
      readwritePaths: [cwd],
      readonlyPaths: [],
      backend: createMockBackend(),
    });
    expect(outcome.outputLimitExceeded).toBe('stdout');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses the legacy ambient host installer option', async () => {
    expect(() =>
      planSandboxSummary({ allowHostUnsandboxedInstall: true }),
    ).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
    await expect(
      runHostInstaller({
        argv: [process.execPath, '-e', 'process.stdout.write("never")'],
        ecosystem: 'deb',
        sandbox: { allowHostUnsandboxedInstall: true },
      }),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
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

  it('refuses stable directory authorities in MXC filesystem planning', () => {
    expect(() =>
      mxcFilesystemPaths({
        cwd: '/tmp',
        readwritePaths: ['/tmp'],
        readonlyPaths: [],
        directoryAuthorities: [{ fd: 3, path: '/tmp' }],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'UNAVAILABLE',
        message: expect.stringContaining('directory-handle'),
      }),
    );
  });

  it('refuses dangerous write grants unless allowed', () => {
    expect(() => assertGrantsNotDangerous(['/'], false)).toThrow(JailPathError);
    expect(() => assertGrantsNotDangerous(['/'], true)).not.toThrow();
  });

  it('refuses package-exec readonly binds of /', async () => {
    await expect(
      runInSandbox({
        argv: [process.execPath, '-e', 'process.exit(0)'],
        cwd: scratch('op-sandbox-ro-'),
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

  it('kills descendants after a contained timeout', async () => {
    const cwd = scratch('op-sandbox-timeout-');
    const marker = join(cwd, 'escaped');
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped'), 300)`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
    const started = Date.now();
    const outcome = await runInSandbox({
      argv: [process.execPath, '-e', parent],
      cwd,
      policy: { mode: 'fail-closed', timeoutMs: 100 },
      readwritePaths: [cwd],
      readonlyPaths: [],
      backend: createMockBackend(),
    });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(outcome.exitCode).not.toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('kills descendants after an external abort', async () => {
    const cwd = scratch('op-sandbox-abort-');
    const marker = join(cwd, 'escaped');
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped'), 300)`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
    const abort = new AbortController();
    const running = runInSandbox({
      argv: [process.execPath, '-e', parent],
      cwd,
      policy: { mode: 'fail-closed', timeoutMs: 30_000 },
      readwritePaths: [cwd],
      readonlyPaths: [],
      backend: createMockBackend(),
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 100);
    expect((await running).exitCode).toBe(124);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['abort', 'output'] as const)(
    'waits for MXC job termination after %s',
    async (reason) => {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn(() => setImmediate(() => child.emit('close', 1)));
      const abort = new AbortController();
      const running = collectMxcChild(
        child,
        {
          maximumStdoutBytes: 8,
          maximumStderrBytes: 8,
          maximumOutputBytes: 12,
        },
        abort.signal,
      );
      if (reason === 'abort') abort.abort();
      else child.stdout.write('x'.repeat(32));
      const result = await running;
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(result.exitCode).toBe(reason === 'abort' ? 124 : 125);
    },
  );

  it('mock package-exec is not enforced (honesty)', async () => {
    const cwd = scratch('op-sandbox-');
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

  it('builds deterministic host profiles and loss disclosures', () => {
    expect(probeNativeBackends()).toEqual(expect.any(Array));
    expect(sensitiveMaskDirectories()).toContain('/root/.ssh');
    expect(sensitiveMaskFiles()).toContain('/etc/shadow');
    expect(networkToolMaskFiles()).toContain('/usr/bin/curl');
    expect(isPathInside('/tmp/root', '/tmp/root/child')).toBe(true);
    expect(isPathInside('/tmp/root', '/tmp/other')).toBe(false);
    expect(
      buildSeatbeltProfile({
        readwritePaths: ['/tmp/write'],
        readonlyPaths: ['/tmp/read'],
        network: false,
        profile: 'package-exec',
      }),
    ).toContain('(deny network*)');
    const bwrap = buildBwrapArgv({
      bwrap: '/usr/bin/bwrap',
      command: ['/usr/bin/true'],
      cwd: '/tmp',
      readwritePaths: ['/tmp'],
      readonlyPaths: ['/etc'],
      network: false,
      profile: 'package-exec',
      environment: {},
      directoryAuthorities: [
        { path: '/tmp', childFd: 3 },
        { path: '/etc', childFd: 4 },
      ],
    });
    expect(bwrap).toContain('--unshare-pid');
    expect(bwrap).toContain('--die-with-parent');
    expect(bwrap.join(' ')).toContain('--bind-fd 3 /tmp');
    expect(bwrap.join(' ')).toContain('--ro-bind-fd 4 /etc');
    expect(() => sandboxPolicyFromInstallOptions({ mode: 'off' })).toThrow(
      /fail-closed/u,
    );
    expect(() =>
      sandboxPolicyFromInstallOptions({ mode: 'degrade-warn' }),
    ).toThrow(/fail-closed/u);
    expect(notSandboxedLoss('apt').code).toBe(
      SANDBOX_LOSS.SYSTEM_NOT_SANDBOXED,
    );
    expect(limitedContainmentLoss('apt').code).toBe(
      SANDBOX_LOSS.SYSTEM_LIMITED,
    );
  });
});

it('refuses MXC command-string expansion and ambiguous quoting', () => {
  for (const argument of [
    '$(touch owned)',
    '`touch owned`',
    '$HOME',
    '%USERPROFILE%',
    'line\nbreak',
    'double"quote',
    "single'quote",
    'trailing\\',
  ])
    expect(() => quoteCommandLine(['/bin/tool', argument])).toThrowError(
      expect.objectContaining({ code: 'POLICY_DENIED' }),
    );
});

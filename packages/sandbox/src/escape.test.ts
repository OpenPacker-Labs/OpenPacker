import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSafeJailPath,
  buildBwrapArgv,
  createNativeBackend,
  isDeniedCredential,
  JailPathError,
  normalizeJailPaths,
  packageExecRoRoots,
  runInSandbox,
  scrubEnvironment,
} from './index.js';

function hasBwrap(): boolean {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(':')) {
    try {
      accessSync(join(dir, 'bwrap'), constants.X_OK);
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

const nativeBackend = createNativeBackend();
const bwrapReady =
  process.platform === 'linux' &&
  hasBwrap() &&
  nativeBackend?.id === 'native-bwrap';

describe('jail path validation', () => {
  it('rejects traversal and NUL', () => {
    expect(() => assertSafeJailPath('../etc/passwd')).toThrow(JailPathError);
    expect(() => assertSafeJailPath('a\0b')).toThrow(JailPathError);
    expect(() => assertSafeJailPath('')).toThrow(JailPathError);
  });

  it('normalises grant paths', () => {
    const paths = normalizeJailPaths(['/tmp/a', '/tmp/a', '/tmp/b'], 'write');
    expect(paths).toEqual([resolve('/tmp/a'), resolve('/tmp/b')]);
  });

  it('rejects a package-local alias to the user home', () => {
    const root = mkdtempSync(join(tmpdir(), 'op-grant-link-'));
    const linked = join(root, 'package');
    symlinkSync(homedir(), linked, 'dir');
    try {
      expect(() => normalizeJailPaths([linked], 'write')).toThrow(
        /symbolic links/u,
      );
      expect(() => normalizeJailPaths([join(linked, 'new')], 'write')).toThrow(
        /symbolic links/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains the approved directory when its pathname is swapped', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    const root = mkdtempSync(join(tmpdir(), 'op-grant-swap-'));
    const granted = join(root, 'package');
    const moved = join(root, 'approved');
    mkdirSync(granted);
    writeFileSync(join(granted, 'proof'), 'stable');
    try {
      const outcome = await runInSandbox({
        argv: ['/usr/bin/true'],
        cwd: granted,
        policy: { mode: 'fail-closed' },
        readwritePaths: [granted],
        readonlyPaths: [],
        backend: {
          id: 'mock',
          async run(input) {
            renameSync(granted, moved);
            symlinkSync(homedir(), granted, 'dir');
            const authority = input.directoryAuthorities?.find(
              ({ path }) => path === granted,
            );
            expect(authority).toBeDefined();
            const fdRoot =
              process.platform === 'linux'
                ? `/proc/self/fd/${authority!.fd}`
                : `/dev/fd/${authority!.fd}`;
            expect(readFileSync(join(fdRoot, 'proof'), 'utf8')).toBe('stable');
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        },
      });
      expect(outcome.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a missing grant before a backend can make it appear', async () => {
    const root = mkdtempSync(join(tmpdir(), 'op-grant-missing-'));
    const missing = join(root, 'late');
    let backendRan = false;
    try {
      await expect(
        runInSandbox({
          argv: ['/usr/bin/true'],
          cwd: root,
          policy: { mode: 'fail-closed' },
          readwritePaths: [missing],
          readonlyPaths: [],
          backend: {
            id: 'mock',
            async run() {
              backendRan = true;
              mkdirSync(missing);
              return { exitCode: 0, stdout: '', stderr: '' };
            },
          },
        }),
      ).rejects.toMatchObject({
        code:
          process.platform === 'linux' || process.platform === 'darwin'
            ? 'ENOENT'
            : 'UNSAFE_JAIL_PATH',
      });
      expect(backendRan).toBe(false);
      expect(existsSync(missing)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('credential scrubbing (hardened)', () => {
  it('denies npm_config auth keys and CI cloud prefixes', () => {
    expect(
      isDeniedCredential('npm_config_//registry.npmjs.org/:_authToken'),
    ).toBe(true);
    expect(isDeniedCredential('GITHUB_TOKEN')).toBe(true);
  });

  it('uses minimal PATH by default', () => {
    const env = scrubEnvironment({
      parent: { PATH: '/evil/bin:/usr/bin', npm_package_name: 'x' },
      jailHome: '/tmp/jail',
      minimalPath: true,
      interpreter: process.execPath,
    });
    expect(env.PATH).not.toContain('/evil/bin');
    expect(env.PATH).toContain('/usr/bin');
    expect(env.npm_package_name).toBe('x');
  });
});

describe('bwrap argv profile', () => {
  it('package-exec uses minimal roots, not fat /', () => {
    const argv = buildBwrapArgv({
      bwrap: '/usr/bin/bwrap',
      command: [process.execPath, '-e', '1'],
      cwd: '/var/tmp/pkg',
      readwritePaths: ['/var/tmp/pkg'],
      readonlyPaths: [],
      network: false,
      profile: 'package-exec',
      environment: { LD_PRELOAD: '/jail/only.so', SAFE: 'yes' },
    });
    expect(argv).toContain('--unshare-net');
    expect(argv).toContain('--clearenv');
    expect(argv).toContain('--setenv');
    expect(argv).toContain('LD_PRELOAD');
    // Fat root should not appear for package-exec.
    const fat = argv.some(
      (a, i) => a === '--ro-bind' && argv[i + 1] === '/' && argv[i + 2] === '/',
    );
    expect(fat).toBe(false);
    expect(packageExecRoRoots().length).toBeGreaterThan(0);
  });

  it('host-install may use fat root', () => {
    const argv = buildBwrapArgv({
      bwrap: '/usr/bin/bwrap',
      command: ['/bin/true'],
      cwd: '/tmp',
      readwritePaths: ['/'],
      readonlyPaths: [],
      network: true,
      profile: 'host-install',
    });
    const fat = argv.some(
      (a, i) => a === '--ro-bind' && argv[i + 1] === '/' && argv[i + 2] === '/',
    );
    expect(fat).toBe(true);
    const lastRootBind = argv.reduce(
      (found, item, index) =>
        item === '--bind' && argv[index + 1] === '/' ? index : found,
      -1,
    );
    const lastMask = argv.reduce(
      (found, item, index) =>
        item === '--ro-bind' && argv[index + 1] === '/dev/null' ? index : found,
      -1,
    );
    if (lastMask !== -1) expect(lastMask).toBeGreaterThan(lastRootBind);
  });
});

describe.skipIf(!bwrapReady)('native bwrap package-exec suite', () => {
  const backend = nativeBackend!;

  it('denies reading arbitrary home files', async () => {
    const pkg = mkdtempSync(join(tmpdir(), 'op-escape-home-'));
    const secret = join(homedir(), `openpacker-audit-${Date.now()}`);
    writeFileSync(secret, 'TOPSECRET\n', { mode: 0o600 });
    try {
      const outcome = await runInSandbox({
        argv: [
          process.execPath,
          '-e',
          `try{require('fs').readFileSync(${JSON.stringify(secret)},'utf8');process.exit(0)}catch(e){process.exit(2)}`,
        ],
        cwd: pkg,
        policy: { mode: 'fail-closed', prefer: 'native' },
        profile: 'package-exec',
        readwritePaths: [pkg],
        readonlyPaths: [],
        backend,
      });
      expect(outcome.enforced).toBe(true);
      expect(outcome.exitCode).not.toBe(0);
    } finally {
      try {
        unlinkSync(secret);
      } catch {
        // ignore
      }
    }
  });

  it('denies project source writes when project is RO', async () => {
    const project = mkdtempSync(join(tmpdir(), 'op-escape-proj-'));
    const victim = join(project, 'src.js');
    writeFileSync(victim, 'good\n');
    const outcome = await runInSandbox({
      argv: [
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(victim)},'pwned')`,
      ],
      cwd: project,
      policy: { mode: 'fail-closed', prefer: 'native', projectWrite: false },
      profile: 'package-exec',
      readwritePaths: [],
      readonlyPaths: [project],
      backend,
    });
    expect(outcome.enforced).toBe(true);
    expect(outcome.exitCode).not.toBe(0);
    expect(readFileSync(victim, 'utf8')).toBe('good\n');
  });

  it('allows project source writes only when projectWrite is granted', async () => {
    const project = mkdtempSync(join(tmpdir(), 'op-escape-projw-'));
    const victim = join(project, 'src.js');
    writeFileSync(victim, 'good\n');
    const outcome = await runInSandbox({
      argv: [
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(victim)},'ok')`,
      ],
      cwd: project,
      policy: { mode: 'fail-closed', prefer: 'native', projectWrite: true },
      profile: 'package-exec',
      readwritePaths: [project],
      readonlyPaths: [],
      backend,
    });
    expect(outcome.exitCode).toBe(0);
    expect(readFileSync(victim, 'utf8')).toBe('ok');
  });

  it('allows package-local writes', async () => {
    const pkg = mkdtempSync(join(tmpdir(), 'op-escape-ok-'));
    const target = join(pkg, 'built.bin');
    const outcome = await runInSandbox({
      argv: [
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(target)},'ok')`,
      ],
      cwd: pkg,
      policy: { mode: 'fail-closed', prefer: 'native' },
      profile: 'package-exec',
      readwritePaths: [pkg],
      readonlyPaths: [],
      backend,
    });
    expect(outcome.exitCode).toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  it('denies outbound network by default', async () => {
    const pkg = mkdtempSync(join(tmpdir(), 'op-escape-net-'));
    const outcome = await runInSandbox({
      argv: [
        process.execPath,
        '-e',
        `require('net').connect(53,'1.1.1.1',()=>process.exit(0)).on('error',()=>process.exit(7))`,
      ],
      cwd: pkg,
      policy: { mode: 'fail-closed', prefer: 'native' },
      profile: 'package-exec',
      readwritePaths: [pkg],
      readonlyPaths: [],
      network: false,
      backend,
    });
    expect(outcome.exitCode).not.toBe(0);
  });

  it('marks host-install as containmentLimited and not enforced', async () => {
    const outcome = await runInSandbox({
      argv: [process.execPath, '-e', 'process.exit(0)'],
      cwd: process.cwd(),
      policy: { mode: 'fail-closed', prefer: 'native', legacyFatRoot: true },
      profile: 'host-install',
      readwritePaths: ['/'],
      readonlyPaths: [],
      backend,
    });
    expect(outcome.profile).toBe('host-install');
    expect(outcome.enforced).toBe(false);
    expect(outcome.containmentLimited).toBe(true);
  });
});

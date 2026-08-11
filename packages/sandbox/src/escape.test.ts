import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
    });
    expect(argv).toContain('--unshare-net');
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

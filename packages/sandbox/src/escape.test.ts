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
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSafeJailPath,
  buildBwrapArgv,
  isDeniedCredential,
  JailPathError,
  normalizeJailPaths,
  runInSandbox,
  scrubEnvironment,
} from './index.js';
import { createNativeBackend } from './backends/native.js';

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
    expect(isDeniedCredential('npm_config__auth')).toBe(true);
    expect(isDeniedCredential('GITHUB_ACTIONS')).toBe(true);
    expect(isDeniedCredential('CIRCLE_TOKEN')).toBe(true);
    expect(isDeniedCredential('CARGO_REGISTRY_TOKEN')).toBe(true);
  });

  it('does not allow arbitrary npm_config_* without a grant', () => {
    const env = scrubEnvironment({
      parent: {
        PATH: '/usr/bin',
        npm_config_registry: 'https://evil.example',
        npm_config_user_agent: 'npm/1',
        npm_config__authToken: 'leak',
      },
      jailHome: '/tmp/jail',
    });
    expect(env.npm_config_registry).toBeUndefined();
    expect(env.npm_config__authToken).toBeUndefined();
    expect(env.npm_config_user_agent).toBe('npm/1');
  });
});

describe('bwrap argv profile', () => {
  it('masks homes, unshares net, and re-binds package RW after masks', () => {
    const argv = buildBwrapArgv({
      bwrap: '/usr/bin/bwrap',
      command: ['/bin/true'],
      cwd: '/var/tmp/pkg',
      readwritePaths: ['/var/tmp/pkg'],
      readonlyPaths: [],
      network: false,
    });
    expect(argv).toContain('--unshare-net');
    expect(argv).toContain('--unshare-ipc');
    expect(argv).toContain('--tmpfs');
    // Package bind must appear after tmpfs masks so it wins.
    const lastTmpfs = argv.lastIndexOf('--tmpfs');
    const bindIdx = argv.indexOf('--bind');
    expect(bindIdx).toBeGreaterThan(lastTmpfs);
    expect(argv[bindIdx + 1]).toBe(resolve('/var/tmp/pkg'));
  });
});

describe.skipIf(!bwrapReady)('native bwrap escape suite', () => {
  // Narrowed for TypeScript: suite is skipped when nativeBackend is missing.
  const backend = nativeBackend!;

  it('refuses writes outside the package directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'op-escape-write-'));
    const pkg = join(root, 'pkg');
    mkdirSync(pkg);
    // /etc is RO in the jail; a successful write here would be a host escape.
    const outside = '/etc/openpacker-sandbox-escape-probe';

    const outcome = await runInSandbox({
      argv: [
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(outside)}, 'pwned')`,
      ],
      cwd: pkg,
      policy: { mode: 'fail-closed', prefer: 'native' },
      readwritePaths: [pkg],
      readonlyPaths: [],
      backend,
    });
    expect(outcome.enforced).toBe(true);
    expect(outcome.exitCode).not.toBe(0);
    expect(existsSync(outside)).toBe(false);
  });

  it('masks host credential directories from reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'op-escape-home-'));
    const pkg = join(root, 'pkg');
    mkdirSync(pkg);
    const home = process.env.HOME ?? '';
    if (!home) return;
    // .ssh is on the sensitive mask list.
    const sshDir = join(home, '.ssh');
    mkdirSync(sshDir, { recursive: true });
    const secret = join(sshDir, `openpacker-sandbox-probe-${Date.now()}`);
    writeFileSync(secret, 'credential-material\n', { mode: 0o600 });
    try {
      const outcome = await runInSandbox({
        argv: [
          process.execPath,
          '-e',
          `try { const t=require('fs').readFileSync(${JSON.stringify(secret)},'utf8'); process.stdout.write('LEAK:'+t); process.exit(0);} catch(e){ process.stdout.write('DENIED'); process.exit(2); }`,
        ],
        cwd: pkg,
        policy: { mode: 'fail-closed', prefer: 'native' },
        readwritePaths: [pkg],
        readonlyPaths: [],
        backend,
      });
      expect(outcome.enforced).toBe(true);
      expect(outcome.stdout).toContain('DENIED');
      expect(outcome.stdout).not.toContain('credential-material');
    } finally {
      try {
        unlinkSync(secret);
      } catch {
        // ignore
      }
    }
  });

  it('denies outbound network by default', async () => {
    const root = mkdtempSync(join(tmpdir(), 'op-escape-net-'));
    const pkg = join(root, 'pkg');
    mkdirSync(pkg);
    const outcome = await runInSandbox({
      argv: [
        process.execPath,
        '-e',
        `require('net').connect(53,'1.1.1.1',()=>process.exit(0)).on('error',()=>process.exit(7))`,
      ],
      cwd: pkg,
      policy: { mode: 'fail-closed', prefer: 'native' },
      readwritePaths: [pkg],
      readonlyPaths: [],
      network: false,
      backend,
    });
    expect(outcome.enforced).toBe(true);
    // Connection should fail inside unshared netns.
    expect(outcome.exitCode).not.toBe(0);
  });

  it('allows package-local writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'op-escape-ok-'));
    const pkg = join(root, 'pkg');
    mkdirSync(pkg);
    const target = join(pkg, 'built.bin');
    const outcome = await runInSandbox({
      argv: [
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(target)}, 'ok');`,
      ],
      cwd: pkg,
      policy: { mode: 'fail-closed', prefer: 'native' },
      readwritePaths: [pkg],
      readonlyPaths: [],
      backend,
    });
    expect(outcome.exitCode).toBe(0);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('ok');
  });
});

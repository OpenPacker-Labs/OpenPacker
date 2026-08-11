import assert from 'node:assert/strict';
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

function hasBwrap() {
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

test('sandbox env scrub drops credential-shaped keys', async () => {
  const { scrubEnvironment, isDeniedCredential } = await import(
    '@openpacker/sandbox'
  );
  assert.equal(isDeniedCredential('npm_config__authToken'), true);
  assert.equal(isDeniedCredential('AWS_SECRET_ACCESS_KEY'), true);
  assert.equal(isDeniedCredential('GITHUB_TOKEN'), true);
  const env = scrubEnvironment({
    parent: {
      PATH: '/evil:/usr/bin',
      NPM_TOKEN: 'x',
      AWS_SECRET_ACCESS_KEY: 'y',
      npm_config_registry: 'https://registry.npmjs.org',
      npm_config_user_agent: 'npm/10',
    },
    jailHome: '/tmp/jail-home',
    minimalPath: true,
  });
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.npm_config_registry, undefined);
  assert.equal(env.npm_config_user_agent, 'npm/10');
  assert.equal(env.HOME, '/tmp/jail-home');
  assert.ok(!env.PATH.includes('/evil'));
});

test('jail path grants reject traversal', async () => {
  const { assertSafeJailPath, JailPathError } = await import(
    '@openpacker/sandbox'
  );
  assert.throws(() => assertSafeJailPath('../secret'), JailPathError);
  assert.throws(() => assertSafeJailPath('a\0b'), JailPathError);
  assert.equal(assertSafeJailPath('/tmp/ok'), resolve('/tmp/ok'));
});

test(
  'package-exec denies home file reads (must-pass)',
  { skip: process.platform !== 'linux' || !hasBwrap() },
  async () => {
    const sandbox = await import('@openpacker/sandbox');
    const native = sandbox.createNativeBackend();
    assert.ok(native);
    const pkg = mkdtempSync(join(tmpdir(), 'sec-home-'));
    const secret = join(homedir(), `op-sec-${Date.now()}`);
    writeFileSync(secret, 'TOPSECRET\n');
    try {
      const outcome = await sandbox.runInSandbox({
        argv: [
          process.execPath,
          '-e',
          `try{require('fs').readFileSync(${JSON.stringify(secret)},'utf8');process.exit(0)}catch{process.exit(2)}`,
        ],
        cwd: pkg,
        policy: { mode: 'fail-closed', prefer: 'native' },
        profile: 'package-exec',
        readwritePaths: [pkg],
        readonlyPaths: [],
        backend: native,
      });
      assert.equal(outcome.enforced, true);
      assert.notEqual(outcome.exitCode, 0);
    } finally {
      try {
        unlinkSync(secret);
      } catch {
        // ignore
      }
    }
  },
);

test(
  'package-exec denies project source writes by default (must-pass)',
  { skip: process.platform !== 'linux' || !hasBwrap() },
  async () => {
    const sandbox = await import('@openpacker/sandbox');
    const native = sandbox.createNativeBackend();
    const project = mkdtempSync(join(tmpdir(), 'sec-proj-'));
    const victim = join(project, 'src.js');
    writeFileSync(victim, 'good\n');
    const outcome = await sandbox.runInSandbox({
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
      backend: native,
    });
    assert.equal(outcome.enforced, true);
    assert.notEqual(outcome.exitCode, 0);
    assert.equal(readFileSync(victim, 'utf8'), 'good\n');
  },
);

test(
  'native bwrap allows in-tree package writes',
  { skip: process.platform !== 'linux' || !hasBwrap() },
  async () => {
    const sandbox = await import('@openpacker/sandbox');
    const native = sandbox.createNativeBackend();
    const pkg = mkdtempSync(join(tmpdir(), 'sec-ok-'));
    const target = join(pkg, 'out.bin');
    const outcome = await sandbox.runInSandbox({
      argv: [
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(target)}, 'built')`,
      ],
      cwd: pkg,
      policy: { mode: 'fail-closed', prefer: 'native' },
      profile: 'package-exec',
      readwritePaths: [pkg],
      readonlyPaths: [],
      backend: native,
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(existsSync(target), true);
  },
);

test('production package-run paths go through @openpacker/sandbox', async () => {
  const { readFileSync: read } = await import('node:fs');
  const opmx = read(join(root, 'apps/opm/src/opmx.ts'), 'utf8');
  assert.match(opmx, /runSandboxedPackageProcess/);
  assert.doesNotMatch(opmx, /from 'node:child_process'/);

  const lifecycle = read(
    join(root, 'packages/opm-project/src/lifecycle.ts'),
    'utf8',
  );
  assert.match(lifecycle, /runInSandbox/);
  assert.match(lifecycle, /SANDBOX_UNAVAILABLE|sandbox was not enforced/);

  const bins = read(join(root, 'packages/opm-project/src/bins.ts'), 'utf8');
  assert.match(bins, /OPENPACKER_ALLOW_AMBIENT_SHIMS/);
  assert.match(bins, /opmx/);
});

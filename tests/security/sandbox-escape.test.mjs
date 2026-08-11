import assert from 'node:assert/strict';
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
      PATH: '/usr/bin',
      NPM_TOKEN: 'x',
      AWS_SECRET_ACCESS_KEY: 'y',
      npm_config_registry: 'https://registry.npmjs.org',
      npm_config_user_agent: 'npm/10',
    },
    jailHome: '/tmp/jail-home',
  });
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.npm_config_registry, undefined);
  assert.equal(env.npm_config_user_agent, 'npm/10');
  assert.equal(env.HOME, '/tmp/jail-home');
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
  'native bwrap blocks out-of-tree writes from package scripts',
  { skip: process.platform !== 'linux' || !hasBwrap() },
  async () => {
    const sandbox = await import('@openpacker/sandbox');
    const native = sandbox.createNativeBackend();
    assert.ok(native, 'native bwrap backend required');

    const base = mkdtempSync(join(tmpdir(), 'sec-escape-'));
    const pkg = join(base, 'pkg');
    mkdirSync(pkg);
    // /etc is RO inside the jail; writing here would be a host escape.
    const outside = '/etc/openpacker-sandbox-escape-probe';

    const outcome = await sandbox.runInSandbox({
      argv: [
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(outside)}, 'owned')`,
      ],
      cwd: pkg,
      policy: { mode: 'fail-closed', prefer: 'native' },
      readwritePaths: [pkg],
      readonlyPaths: [],
      backend: native,
    });

    assert.equal(outcome.enforced, true);
    assert.notEqual(outcome.exitCode, 0);
    assert.equal(existsSync(outside), false);
  },
);

test(
  'native bwrap allows in-tree package writes',
  { skip: process.platform !== 'linux' || !hasBwrap() },
  async () => {
    const sandbox = await import('@openpacker/sandbox');
    const native = sandbox.createNativeBackend();
    const base = mkdtempSync(join(tmpdir(), 'sec-ok-'));
    const pkg = join(base, 'pkg');
    mkdirSync(pkg);
    const target = join(pkg, 'out.bin');

    const outcome = await sandbox.runInSandbox({
      argv: [
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(target)}, 'built')`,
      ],
      cwd: pkg,
      policy: { mode: 'fail-closed', prefer: 'native' },
      readwritePaths: [pkg],
      readonlyPaths: [],
      backend: native,
    });

    assert.equal(outcome.exitCode, 0);
    assert.equal(existsSync(target), true);
    assert.equal(readFileSync(target, 'utf8'), 'built');
  },
);

test('production package-run paths go through @openpacker/sandbox', async () => {
  // opmx and lifecycle must import the funnel — not raw child_process spawn
  // for package execution. Shim generators may still embed spawn *inside*
  // sandboxed processes.
  const { readFileSync: read } = await import('node:fs');
  const opmx = read(join(root, 'apps/opm/src/opmx.ts'), 'utf8');
  assert.match(opmx, /runSandboxedPackageProcess/);
  assert.doesNotMatch(
    opmx,
    /from 'node:child_process'/,
    'opmx must not import child_process directly after sandbox wiring',
  );

  const lifecycle = read(
    join(root, 'packages/opm-project/src/lifecycle.ts'),
    'utf8',
  );
  assert.match(lifecycle, /runInSandbox/);
  assert.match(lifecycle, /SANDBOX_UNAVAILABLE|sandbox was not enforced/);
});

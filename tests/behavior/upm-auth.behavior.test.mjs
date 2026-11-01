/**
 * Behavior specifications for `opm auth`. Given/When/Then journeys over the
 * public CLI and library: origin → env-var names, never bearer material.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';

const { runOpm } = await import('@openpacker/cli/opm');
const { parseAuthConfig, readAuthConfig } = await import(
  '@openpacker/opm-project'
);

function capture() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (s) => ((out += s), true) },
      stderr: { write: (s) => ((err += s), true) },
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

async function withAuthConfig(run) {
  const root = await mkdtemp(join(tmpdir(), 'upm-auth-behavior-'));
  const previous = {
    OPM_AUTH_CONFIG: process.env.OPM_AUTH_CONFIG,
    OPM_HOST_FETCH_ORIGINS: process.env.OPM_HOST_FETCH_ORIGINS,
    OPM_HOST_FETCH_TOKEN_ENVS: process.env.OPM_HOST_FETCH_TOKEN_ENVS,
  };
  process.env.OPM_AUTH_CONFIG = join(root, 'auth.json');
  delete process.env.OPM_HOST_FETCH_ORIGINS;
  delete process.env.OPM_HOST_FETCH_TOKEN_ENVS;
  try {
    await run(process.env.OPM_AUTH_CONFIG);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test('Given no auth file, when list runs, then the map is empty', async () => {
  await withAuthConfig(async () => {
    const cap = capture();
    const code = await runOpm(['auth', 'list'], cap.io);
    assert.equal(code, 0);
    assert.match(cap.out, /no origins/);
  });
});

test('Given a private origin, when auth set names an env, then list prints the name and the file has no secret', async () => {
  await withAuthConfig(async (path) => {
    // Given an operator who wants https://npm.internal.example to use NPM_TOKEN
    const set = capture();

    // When they record the env-var name
    const code = await runOpm(
      [
        'auth',
        'set',
        '--origin',
        'https://npm.internal.example',
        '--token-env',
        'NPM_TOKEN',
      ],
      set.io,
    );

    // Then the CLI stores and lists the name, never a bearer.
    assert.equal(code, 0);
    const list = capture();
    assert.equal(await runOpm(['auth', 'list'], list.io), 0);
    assert.match(list.out, /https:\/\/npm\.internal\.example/);
    assert.match(list.out, /NPM_TOKEN/);
    const raw = await readFile(path, 'utf8');
    assert.doesNotMatch(raw, /Bearer /);
    assert.doesNotMatch(raw, /ghp_/);
    const parsed = parseAuthConfig(raw);
    assert.equal(
      parsed.origins['https://npm.internal.example']?.tokenEnv,
      'NPM_TOKEN',
    );
    const loaded = await readAuthConfig({ path });
    assert.deepEqual(loaded, parsed);
  });
});

test('Given a recorded origin, when auth unset runs, then the origin is gone', async () => {
  await withAuthConfig(async () => {
    const set = capture();
    assert.equal(
      await runOpm(
        [
          'auth',
          'set',
          '--origin',
          'https://npm.internal.example',
          '--token-env',
          'NPM_TOKEN',
        ],
        set.io,
      ),
      0,
    );
    const unset = capture();
    assert.equal(
      await runOpm(
        ['auth', 'unset', '--origin', 'https://npm.internal.example'],
        unset.io,
      ),
      0,
    );
    const list = capture();
    assert.equal(await runOpm(['auth', 'list'], list.io), 0);
    assert.match(list.out, /no origins/);
  });
});

test('Given a token value, when the operator passes --token, then the command refuses and writes nothing', async () => {
  await withAuthConfig(async (path) => {
    const cap = capture();
    const code = await runOpm(
      [
        'auth',
        'set',
        '--origin',
        'https://npm.internal.example',
        '--token',
        'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      ],
      cap.io,
    );
    assert.notEqual(code, 0);
    assert.match(cap.err, /--token/);
    await assert.rejects(() => readFile(path, 'utf8'), { code: 'ENOENT' });
  });
});

test('Given an HTTP origin, when auth set runs, then it is refused', async () => {
  await withAuthConfig(async () => {
    const cap = capture();
    const code = await runOpm(
      [
        'auth',
        'set',
        '--origin',
        'http://npm.internal.example',
        '--token-env',
        'NPM_TOKEN',
      ],
      cap.io,
    );
    assert.notEqual(code, 0);
  });
});

test('Given a successful set on POSIX, when the file is created, then its mode is 0600', async () => {
  if (process.platform === 'win32') return;
  await withAuthConfig(async (path) => {
    const cap = capture();
    assert.equal(
      await runOpm(
        [
          'auth',
          'set',
          '--origin',
          'https://npm.internal.example',
          '--token-env',
          'NPM_TOKEN',
        ],
        cap.io,
      ),
      0,
    );
    const st = await lstat(path);
    assert.equal(st.mode & 0o777, 0o600);
  });
});

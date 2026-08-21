import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runOpm } from '../src/opm.js';
import { applyAuthConfigForProcess } from '../src/commands/auth.js';

const temps: string[] = [];
const envKeys = [
  'OPM_AUTH_CONFIG',
  'XDG_CONFIG_HOME',
  'HOME',
  'OPM_HOST_FETCH_ORIGINS',
  'OPM_HOST_FETCH_TOKEN_ENVS',
  'NPM_TOKEN',
  'CARGO_TOKEN',
  'OPERATOR_TOKEN',
] as const;

const envSnapshot = new Map<string, string | undefined>();

beforeEach(async () => {
  for (const key of envKeys) {
    if (!envSnapshot.has(key)) envSnapshot.set(key, process.env[key]);
  }
  const root = await mkdtemp(join(tmpdir(), 'opm-auth-cli-'));
  temps.push(root);
  process.env.OPM_AUTH_CONFIG = join(root, 'auth.json');
  delete process.env.OPM_HOST_FETCH_ORIGINS;
  delete process.env.OPM_HOST_FETCH_TOKEN_ENVS;
  delete process.env.NPM_TOKEN;
});

afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  for (const [key, value] of envSnapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envSnapshot.clear();
});

function capture() {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write: (s: string) => ((out += s), true) },
      stderr: { write: (s: string) => ((err += s), true) },
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

describe('opm auth', () => {
  it('sets, lists, and unsets origin → env names without writing secrets', async () => {
    const set = capture();
    expect(
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
    ).toBe(0);
    expect(set.out).toMatch(/https:\/\/npm\.internal\.example/);
    expect(set.out).toMatch(/NPM_TOKEN/);
    expect(set.out).not.toMatch(/Bearer /);

    const list = capture();
    expect(await runOpm(['auth', 'list'], list.io)).toBe(0);
    expect(list.out).toMatch(/https:\/\/npm\.internal\.example/);
    expect(list.out).toMatch(/NPM_TOKEN/);
    expect(list.out).not.toMatch(/ghp_/);

    const raw = await readFile(process.env.OPM_AUTH_CONFIG!, 'utf8');
    expect(raw).toMatch(/"tokenEnv": "NPM_TOKEN"/);
    expect(raw).not.toMatch(/Bearer /);
    expect(raw).not.toMatch(/ghp_/);
    expect(raw).not.toMatch(/eyJ/);

    const unset = capture();
    expect(
      await runOpm(
        ['auth', 'unset', '--origin', 'https://npm.internal.example'],
        unset.io,
      ),
    ).toBe(0);
    const empty = capture();
    expect(await runOpm(['auth', 'list'], empty.io)).toBe(0);
    expect(empty.out).toMatch(/no origins/);
  });

  it('pins an origin without a token env name', async () => {
    const set = capture();
    expect(
      await runOpm(
        ['auth', 'set', '--origin', 'https://registry.internal.example'],
        set.io,
      ),
    ).toBe(0);
    expect(set.out).toMatch(/Pinned https:\/\/registry\.internal\.example/);
    expect(set.out).not.toMatch(/to env/);
    const list = capture();
    expect(await runOpm(['auth', 'list'], list.io)).toBe(0);
    expect(list.out).toMatch(/https:\/\/registry\.internal\.example\t\(pin\)/);
    const raw = await readFile(process.env.OPM_AUTH_CONFIG!, 'utf8');
    expect(raw).toMatch(/"https:\/\/registry\.internal\.example"/);
    expect(raw).not.toMatch(/tokenEnv/);
  });

  it('writes mode 0600 on POSIX', async () => {
    if (process.platform === 'win32') return;
    const cap = capture();
    expect(
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
    ).toBe(0);
    const st = await lstat(process.env.OPM_AUTH_CONFIG!);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('refuses --token', async () => {
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
    expect(code).not.toBe(0);
    expect(cap.err).toMatch(/--token/);
    expect(cap.err).toMatch(/--token-env/);
    await expect(
      readFile(process.env.OPM_AUTH_CONFIG!, 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses HTTP origins', async () => {
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
    expect(code).not.toBe(0);
    expect(cap.err).toMatch(/HTTPS|origin/i);
  });

  it('refuses a secret-shaped --token-env', async () => {
    const cap = capture();
    const code = await runOpm(
      [
        'auth',
        'set',
        '--origin',
        'https://npm.internal.example',
        '--token-env',
        'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      ],
      cap.io,
    );
    expect(code).not.toBe(0);
    expect(cap.err).toMatch(/secret|tokenEnv/i);
    await expect(
      readFile(process.env.OPM_AUTH_CONFIG!, 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prints an Auth (env names only) help section', async () => {
    const cap = capture();
    expect(await runOpm(['help'], cap.io)).toBe(0);
    expect(cap.out).toMatch(/Auth \(env names only\)/);
    expect(cap.out).toMatch(/opm auth set/);
    expect(cap.out).toMatch(/--token-env/);
    expect(cap.out).not.toMatch(/opm login/);
    expect(cap.out).not.toMatch(/--token <token>/);
  });

  it('returns usage for an unknown auth subcommand', async () => {
    const cap = capture();
    const code = await runOpm(['auth', 'login'], cap.io);
    expect(code).toBe(2);
    expect(cap.err).toMatch(/login|set \| list \| unset/i);
  });

  it('applyAuthConfigForProcess appends origin and env names without copying secrets', async () => {
    const cap = capture();
    expect(
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
    ).toBe(0);
    process.env.OPM_HOST_FETCH_ORIGINS = 'https://already.example';
    delete process.env.OPM_HOST_FETCH_TOKEN_ENVS;
    process.env.NPM_TOKEN = 'should-not-be-copied';
    await applyAuthConfigForProcess();
    expect(process.env.OPM_HOST_FETCH_ORIGINS).toBe(
      'https://already.example,https://npm.internal.example',
    );
    expect(process.env.OPM_HOST_FETCH_TOKEN_ENVS).toBe(',NPM_TOKEN');
    expect(process.env.NPM_TOKEN).toBe('should-not-be-copied');
  });

  it('applyAuthConfigForProcess does not override an operator-listed origin', async () => {
    const cap = capture();
    expect(
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
    ).toBe(0);
    process.env.OPM_HOST_FETCH_ORIGINS = 'https://npm.internal.example';
    process.env.OPM_HOST_FETCH_TOKEN_ENVS = 'OPERATOR_TOKEN';
    await applyAuthConfigForProcess();
    expect(process.env.OPM_HOST_FETCH_ORIGINS).toBe(
      'https://npm.internal.example',
    );
    expect(process.env.OPM_HOST_FETCH_TOKEN_ENVS).toBe('OPERATOR_TOKEN');
  });

  it('runOpm applies auth config names for the process of a command', async () => {
    const set = capture();
    expect(
      await runOpm(
        [
          'auth',
          'set',
          '--origin',
          'https://crates.internal.example',
          '--token-env',
          'CARGO_TOKEN',
        ],
        set.io,
      ),
    ).toBe(0);
    delete process.env.OPM_HOST_FETCH_ORIGINS;
    delete process.env.OPM_HOST_FETCH_TOKEN_ENVS;
    const help = capture();
    expect(await runOpm(['help'], help.io)).toBe(0);
    expect(process.env.OPM_HOST_FETCH_ORIGINS).toBe(
      'https://crates.internal.example',
    );
    expect(process.env.OPM_HOST_FETCH_TOKEN_ENVS).toBe('CARGO_TOKEN');
    expect(process.env.CARGO_TOKEN).toBeUndefined();
  });
});

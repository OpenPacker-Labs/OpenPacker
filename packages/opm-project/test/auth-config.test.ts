import { afterEach, describe, expect, it } from 'vitest';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpmError } from '../src/types.js';
import {
  applyAuthConfigToEnvNames,
  defaultAuthConfigPath,
  hostFetchTokenEnvNamesFromAuth,
  parseAuthConfig,
  readAuthConfig,
  removeAuthOrigin,
  tokenEnvNameForOrigin,
  upsertAuthOrigin,
  type AuthConfig,
} from '../src/auth-config.js';

const temps: string[] = [];
const envKeys = [
  'OPM_AUTH_CONFIG',
  'XDG_CONFIG_HOME',
  'HOME',
  'OPM_HOST_FETCH_ORIGINS',
  'OPM_HOST_FETCH_TOKEN_ENVS',
] as const;
const envSnapshot = new Map<string, string | undefined>();

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

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opm-auth-'));
  temps.push(dir);
  return dir;
}

function rememberEnv(key: string): void {
  if (!envSnapshot.has(key)) envSnapshot.set(key, process.env[key]);
}

function setEnv(key: string, value: string | undefined): void {
  rememberEnv(key);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function isolateEnv(): void {
  for (const key of envKeys) rememberEnv(key);
}

describe('defaultAuthConfigPath', () => {
  it('prefers OPM_AUTH_CONFIG when it is an absolute path', async () => {
    const root = await tempDir();
    const path = join(root, 'auth.json');
    expect(defaultAuthConfigPath({ OPM_AUTH_CONFIG: path })).toBe(path);
  });

  it('refuses a relative OPM_AUTH_CONFIG', () => {
    expect(() =>
      defaultAuthConfigPath({ OPM_AUTH_CONFIG: 'auth.json' }),
    ).toThrowError(OpmError);
    try {
      defaultAuthConfigPath({ OPM_AUTH_CONFIG: 'auth.json' });
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNSAFE_PATH' });
    }
  });

  it('uses XDG_CONFIG_HOME/openpacker/auth.json', () => {
    expect(defaultAuthConfigPath({ XDG_CONFIG_HOME: '/xdg-config' })).toBe(
      join('/xdg-config', 'openpacker', 'auth.json'),
    );
  });

  it('falls back to ~/.config/openpacker/auth.json', () => {
    expect(defaultAuthConfigPath({ HOME: '/home/op' })).toBe(
      join('/home/op', '.config', 'openpacker', 'auth.json'),
    );
  });

  it('refuses a relative XDG_CONFIG_HOME', () => {
    expect(() =>
      defaultAuthConfigPath({ XDG_CONFIG_HOME: 'relative' }),
    ).toThrowError(OpmError);
    try {
      defaultAuthConfigPath({ XDG_CONFIG_HOME: 'relative' });
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNSAFE_PATH' });
    }
  });
});

describe('parseAuthConfig', () => {
  it('parses version 1 origin → tokenEnv names', () => {
    const parsed = parseAuthConfig(`{
  "version": 1,
  "origins": {
    "https://npm.internal.example": { "tokenEnv": "NPM_TOKEN" }
  }
}
`);
    expect(parsed).toEqual({
      version: 1,
      origins: {
        'https://npm.internal.example': { tokenEnv: 'NPM_TOKEN' },
      },
    } satisfies AuthConfig);
  });

  it('parses a pin-only origin with no tokenEnv', () => {
    const parsed = parseAuthConfig(`{
  "version": 1,
  "origins": {
    "https://registry.internal.example": {}
  }
}
`);
    expect(parsed.origins['https://registry.internal.example']).toEqual({});
  });

  it('treats missing file-shaped empty object as invalid', () => {
    expect(() => parseAuthConfig('{}')).toThrowError(OpmError);
    try {
      parseAuthConfig('{}');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_SPEC' });
    }
  });

  it('refuses truncated JSON without leaking a parser exception', () => {
    expect(() => parseAuthConfig('{"version":1,"orig')).toThrowError(OpmError);
    try {
      parseAuthConfig('{"version":1,"orig');
    } catch (error) {
      expect(error).toBeInstanceOf(OpmError);
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      expect((error as OpmError).code).toBe('INVALID_SPEC');
    }
  });

  it('refuses HTTP origins', () => {
    expect(() =>
      parseAuthConfig(
        JSON.stringify({
          version: 1,
          origins: {
            'http://npm.internal.example': { tokenEnv: 'NPM_TOKEN' },
          },
        }),
      ),
    ).toThrowError(OpmError);
    try {
      parseAuthConfig(
        JSON.stringify({
          version: 1,
          origins: {
            'http://npm.internal.example': { tokenEnv: 'NPM_TOKEN' },
          },
        }),
      );
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNSAFE_PATH' });
    }
  });

  it('refuses userinfo in an origin and does not echo the secret', () => {
    const raw = JSON.stringify({
      version: 1,
      origins: {
        'https://user:super-secret@npm.internal.example': {
          tokenEnv: 'NPM_TOKEN',
        },
      },
    });
    expect(() => parseAuthConfig(raw)).toThrowError(OpmError);
    try {
      parseAuthConfig(raw);
    } catch (error) {
      expect(error).toBeInstanceOf(OpmError);
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      expect((error as OpmError).message).not.toMatch(/super-secret/);
    }
  });

  it('refuses secret-shaped tokenEnv values', () => {
    for (const tokenEnv of [
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aa.bb',
      'Bearer abcdef',
    ]) {
      expect(() =>
        parseAuthConfig(
          JSON.stringify({
            version: 1,
            origins: {
              'https://npm.internal.example': { tokenEnv },
            },
          }),
        ),
      ).toThrowError(OpmError);
      try {
        parseAuthConfig(
          JSON.stringify({
            version: 1,
            origins: {
              'https://npm.internal.example': { tokenEnv },
            },
          }),
        );
      } catch (error) {
        expect(error).toMatchObject({ code: 'UNSAFE_PATH' });
      }
    }
  });

  it('refuses extra secret-shaped fields on an origin entry', () => {
    expect(() =>
      parseAuthConfig(
        JSON.stringify({
          version: 1,
          origins: {
            'https://npm.internal.example': {
              tokenEnv: 'NPM_TOKEN',
              token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
            },
          },
        }),
      ),
    ).toThrowError(OpmError);
    try {
      parseAuthConfig(
        JSON.stringify({
          version: 1,
          origins: {
            'https://npm.internal.example': {
              tokenEnv: 'NPM_TOKEN',
              token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
            },
          },
        }),
      );
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNSAFE_PATH' });
    }
  });

  it('refuses a tokenEnv that is not an env-var name', () => {
    expect(() =>
      parseAuthConfig(
        JSON.stringify({
          version: 1,
          origins: {
            'https://npm.internal.example': { tokenEnv: 'npm-token' },
          },
        }),
      ),
    ).toThrowError(OpmError);
    try {
      parseAuthConfig(
        JSON.stringify({
          version: 1,
          origins: {
            'https://npm.internal.example': { tokenEnv: 'npm-token' },
          },
        }),
      );
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_SPEC' });
    }
  });
});

describe('readAuthConfig / upsertAuthOrigin / removeAuthOrigin', () => {
  it('returns an empty version-1 map when the file is missing', async () => {
    const root = await tempDir();
    const path = join(root, 'missing', 'auth.json');
    await expect(readAuthConfig({ path })).resolves.toEqual({
      version: 1,
      origins: {},
    });
  });

  it('round-trips origin → tokenEnv names and never writes bearer material', async () => {
    const root = await tempDir();
    const path = join(root, 'auth.json');
    const written = await upsertAuthOrigin({
      origin: 'https://npm.internal.example',
      tokenEnv: 'NPM_TOKEN',
      path,
    });
    expect(written).toEqual({
      version: 1,
      origins: {
        'https://npm.internal.example': { tokenEnv: 'NPM_TOKEN' },
      },
    });
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toMatch(/Bearer /);
    expect(raw).not.toMatch(/ghp_/);
    expect(raw).not.toMatch(/eyJ/);
    expect(JSON.parse(raw)).toEqual(written);
    await expect(readAuthConfig({ path })).resolves.toEqual(written);
  });

  it('replaces the tokenEnv for a duplicate origin', async () => {
    const root = await tempDir();
    const path = join(root, 'auth.json');
    await upsertAuthOrigin({
      origin: 'https://npm.internal.example',
      tokenEnv: 'OLD_TOKEN',
      path,
    });
    const updated = await upsertAuthOrigin({
      origin: 'https://npm.internal.example/',
      tokenEnv: 'NPM_TOKEN',
      path,
    });
    expect(updated.origins).toEqual({
      'https://npm.internal.example': { tokenEnv: 'NPM_TOKEN' },
    });
  });

  it('writes mode 0600 on POSIX', async () => {
    if (process.platform === 'win32') return;
    const root = await tempDir();
    const path = join(root, 'auth.json');
    await upsertAuthOrigin({
      origin: 'https://npm.internal.example',
      tokenEnv: 'NPM_TOKEN',
      path,
    });
    const st = await lstat(path);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('refuses to write a secret-shaped tokenEnv', async () => {
    const root = await tempDir();
    const path = join(root, 'auth.json');
    await expect(
      upsertAuthOrigin({
        origin: 'https://npm.internal.example',
        tokenEnv: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        path,
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses HTTP origins on write', async () => {
    const root = await tempDir();
    const path = join(root, 'auth.json');
    await expect(
      upsertAuthOrigin({
        origin: 'http://npm.internal.example',
        tokenEnv: 'NPM_TOKEN',
        path,
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
  });

  it('removes an origin and leaves other entries', async () => {
    const root = await tempDir();
    const path = join(root, 'auth.json');
    await upsertAuthOrigin({
      origin: 'https://npm.internal.example',
      tokenEnv: 'NPM_TOKEN',
      path,
    });
    await upsertAuthOrigin({
      origin: 'https://crates.internal.example',
      tokenEnv: 'CARGO_TOKEN',
      path,
    });
    const next = await removeAuthOrigin({
      origin: 'https://npm.internal.example',
      path,
    });
    expect(next.origins).toEqual({
      'https://crates.internal.example': { tokenEnv: 'CARGO_TOKEN' },
    });
  });

  it('remove of a missing origin is idempotent and does not create a file', async () => {
    const root = await tempDir();
    const path = join(root, 'auth.json');
    const next = await removeAuthOrigin({
      origin: 'https://npm.internal.example',
      path,
    });
    expect(next).toEqual({ version: 1, origins: {} });
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reads OPM_AUTH_CONFIG from env when path is omitted', async () => {
    isolateEnv();
    const root = await tempDir();
    const path = join(root, 'auth.json');
    setEnv('OPM_AUTH_CONFIG', path);
    await upsertAuthOrigin({
      origin: 'https://npm.internal.example',
      tokenEnv: 'NPM_TOKEN',
    });
    await expect(readAuthConfig()).resolves.toEqual({
      version: 1,
      origins: {
        'https://npm.internal.example': { tokenEnv: 'NPM_TOKEN' },
      },
    });
  });

  it('still 0600 after rewriting an existing world-readable file', async () => {
    if (process.platform === 'win32') return;
    const root = await tempDir();
    const path = join(root, 'auth.json');
    await writeFile(
      path,
      JSON.stringify({ version: 1, origins: {} }, null, 2),
      { mode: 0o644 },
    );
    await chmod(path, 0o644);
    await upsertAuthOrigin({
      origin: 'https://npm.internal.example',
      tokenEnv: 'NPM_TOKEN',
      path,
    });
    const st = await lstat(path);
    expect(st.mode & 0o777).toBe(0o600);
  });
});

describe('tokenEnvNameForOrigin', () => {
  const config: AuthConfig = {
    version: 1,
    origins: {
      'https://npm.internal.example': { tokenEnv: 'NPM_TOKEN' },
    },
  };

  it('returns the env name for a pinned origin', () => {
    expect(tokenEnvNameForOrigin('https://npm.internal.example', config)).toBe(
      'NPM_TOKEN',
    );
  });

  it('normalizes the lookup origin', () => {
    expect(tokenEnvNameForOrigin('https://npm.internal.example/', config)).toBe(
      'NPM_TOKEN',
    );
  });

  it('returns undefined when the origin is absent', () => {
    expect(
      tokenEnvNameForOrigin('https://other.internal.example', config),
    ).toBeUndefined();
  });
});

describe('applyAuthConfigToEnvNames', () => {
  const config: AuthConfig = {
    version: 1,
    origins: {
      'https://npm.internal.example': { tokenEnv: 'NPM_TOKEN' },
      'https://crates.internal.example': { tokenEnv: 'CARGO_TOKEN' },
    },
  };

  it('serializes auth origins and env names as parallel host-fetch lists', () => {
    const applied = applyAuthConfigToEnvNames({ config });
    expect(applied.origins).toEqual([
      'https://npm.internal.example',
      'https://crates.internal.example',
    ]);
    expect(applied.tokenEnvs).toEqual(['NPM_TOKEN', 'CARGO_TOKEN']);
    expect(hostFetchTokenEnvNamesFromAuth(config)).toEqual([
      'NPM_TOKEN',
      'CARGO_TOKEN',
    ]);
  });

  it('appends only origins not already present and does not override operator token names', () => {
    const applied = applyAuthConfigToEnvNames({
      config,
      origins: ['https://npm.internal.example'],
      tokenEnvs: ['OPERATOR_TOKEN'],
    });
    expect(applied.origins).toEqual([
      'https://npm.internal.example',
      'https://crates.internal.example',
    ]);
    expect(applied.tokenEnvs).toEqual(['OPERATOR_TOKEN', 'CARGO_TOKEN']);
  });

  it('pads empty token slots when the operator listed origins without TOKEN_ENVS', () => {
    const applied = applyAuthConfigToEnvNames({
      config,
      origins: ['https://already.example'],
    });
    expect(applied.origins).toEqual([
      'https://already.example',
      'https://npm.internal.example',
      'https://crates.internal.example',
    ]);
    expect(applied.tokenEnvs).toEqual(['', 'NPM_TOKEN', 'CARGO_TOKEN']);
  });

  it('is a no-op when every auth origin is already in the operator list', () => {
    const applied = applyAuthConfigToEnvNames({
      config,
      origins: [
        'https://npm.internal.example',
        'https://crates.internal.example',
      ],
      tokenEnvs: ['A', 'B'],
    });
    expect(applied).toEqual({
      origins: [
        'https://npm.internal.example',
        'https://crates.internal.example',
      ],
      tokenEnvs: ['A', 'B'],
      changed: false,
    });
  });
});

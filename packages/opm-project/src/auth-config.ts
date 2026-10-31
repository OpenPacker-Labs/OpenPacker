/**
 * User-level origin → token-env-name map (ADR 0041).
 *
 * The file stores names only. Bearer material never lands here; operators
 * mint tokens outside opm and point this map at the env var that holds them.
 */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { normalizePinnedOrigin, ProviderError } from '@openpacker/adapter-core';
import { parseCanonicalJson } from '@openpacker/canonical';
import { openChild, removeChild, renameChild } from './paths.js';
import { openJudgedRoot } from './shared-store-root.js';
import { OpmError } from './types.js';

export interface AuthConfig {
  version: 1;
  origins: Record<string, { tokenEnv?: string }>;
}

const TOKEN_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const TOKEN_LIKELY_SECRET =
  /^(?:Bearer\s+|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|eyJ)/iu;
const SECRET_KEYS = new Set([
  'token',
  'secret',
  'password',
  'bearer',
  'authorization',
  'refresh',
  'credential',
]);
const MAX_AUTH_CONFIG_BYTES = 64 * 1024;

export function defaultAuthConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = env.OPM_AUTH_CONFIG?.trim();
  if (explicit) {
    if (!isAbsolute(explicit))
      throw new OpmError(
        'UNSAFE_PATH',
        `OPM_AUTH_CONFIG must be an absolute path, got "${explicit}"`,
      );
    return explicit;
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    if (!isAbsolute(xdg))
      throw new OpmError(
        'UNSAFE_PATH',
        `XDG_CONFIG_HOME must be an absolute path, got "${xdg}"`,
      );
    return join(xdg, 'openpacker', 'auth.json');
  }
  const home = env.HOME?.trim() || homedir();
  return join(home, '.config', 'openpacker', 'auth.json');
}

export function parseAuthConfig(raw: string): AuthConfig {
  if (Buffer.byteLength(raw, 'utf8') > MAX_AUTH_CONFIG_BYTES)
    throw new OpmError('UNSAFE_PATH', 'Auth config exceeds 64KiB');
  let value: unknown;
  try {
    value = parseCanonicalJson(raw);
  } catch (error) {
    throw new OpmError(
      'INVALID_SPEC',
      `Auth config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertNoSecrets(value, 'auth');
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new OpmError('INVALID_SPEC', 'Auth config must be a JSON object');
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter(
    (key) => key !== 'version' && key !== 'origins',
  );
  if (extra.length > 0) {
    if (extra.some((key) => SECRET_KEYS.has(key.toLowerCase())))
      throw new OpmError('UNSAFE_PATH', 'Auth config must not store secrets');
    throw new OpmError(
      'INVALID_SPEC',
      `Unknown auth config field: ${extra[0]}`,
    );
  }
  if (record.version !== 1)
    throw new OpmError('INVALID_SPEC', 'Auth config version must be 1');
  if (
    record.origins === null ||
    typeof record.origins !== 'object' ||
    Array.isArray(record.origins)
  )
    throw new OpmError('INVALID_SPEC', 'Auth config origins must be an object');
  const origins: Record<string, { tokenEnv?: string }> = {};
  for (const [key, entry] of Object.entries(
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    record.origins as Record<string, unknown>,
  )) {
    const origin = pinnedOrigin(key);
    if (origins[origin] !== undefined)
      throw new OpmError(
        'INVALID_SPEC',
        `Auth config lists duplicate origin ${origin}`,
      );
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
      throw new OpmError(
        'INVALID_SPEC',
        `Auth config origin ${origin} must be an object`,
      );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const fields = entry as Record<string, unknown>;
    const extraFields = Object.keys(fields).filter(
      (name) => name !== 'tokenEnv',
    );
    if (extraFields.length > 0) {
      if (extraFields.some((name) => SECRET_KEYS.has(name.toLowerCase())))
        throw new OpmError(
          'UNSAFE_PATH',
          'Auth config must not store token values',
        );
      throw new OpmError(
        'INVALID_SPEC',
        `Unknown field ${extraFields[0]} on auth origin ${origin}`,
      );
    }
    if (fields.tokenEnv === undefined) {
      origins[origin] = {};
      continue;
    }
    if (typeof fields.tokenEnv !== 'string')
      throw new OpmError(
        'INVALID_SPEC',
        `Auth config origin ${origin} tokenEnv must be a string`,
      );
    if (fields.tokenEnv === '') {
      origins[origin] = {};
      continue;
    }
    assertTokenEnvName(fields.tokenEnv);
    origins[origin] = { tokenEnv: fields.tokenEnv };
  }
  return { version: 1, origins };
}

export async function readAuthConfig(
  input: {
    path?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<AuthConfig> {
  const path = input.path ?? defaultAuthConfigPath(input.env ?? process.env);
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { version: 1, origins: {} };
    throw error;
  }
  if (!info.isFile())
    throw new OpmError('UNSAFE_PATH', `Auth config is not a file: ${path}`);
  if (info.size > MAX_AUTH_CONFIG_BYTES)
    throw new OpmError('UNSAFE_PATH', 'Auth config exceeds 64KiB');
  return parseAuthConfig(await readFile(path, 'utf8'));
}

export async function upsertAuthOrigin(input: {
  origin: string;
  tokenEnv?: string;
  path?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AuthConfig> {
  if (input.tokenEnv !== undefined && input.tokenEnv !== '')
    assertTokenEnvName(input.tokenEnv);
  const origin = pinnedOrigin(input.origin);
  const path = input.path ?? defaultAuthConfigPath(input.env ?? process.env);
  const current = await readAuthConfig({ path });
  const next: AuthConfig = {
    version: 1,
    origins: {
      ...current.origins,
      [origin]:
        input.tokenEnv === undefined || input.tokenEnv === ''
          ? {}
          : { tokenEnv: input.tokenEnv },
    },
  };
  await writeAuthConfig(path, next);
  return next;
}

export async function removeAuthOrigin(input: {
  origin: string;
  path?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<AuthConfig> {
  const origin = pinnedOrigin(input.origin);
  const path = input.path ?? defaultAuthConfigPath(input.env ?? process.env);
  const current = await readAuthConfig({ path });
  if (current.origins[origin] === undefined) return current;
  const { [origin]: _removed, ...origins } = current.origins;
  const next: AuthConfig = { version: 1, origins };
  await writeAuthConfig(path, next);
  return next;
}

export function tokenEnvNameForOrigin(
  origin: string,
  config: AuthConfig,
): string | undefined {
  return config.origins[pinnedOrigin(origin)]?.tokenEnv;
}

export function hostFetchTokenEnvNamesFromAuth(config: AuthConfig): string[] {
  return Object.values(config.origins).map((entry) => entry.tokenEnv ?? '');
}

/**
 * Merge auth-config origins into operator host-fetch lists.
 *
 * Existing operator origins keep their token-env names. Auth entries are
 * appended only when the origin is not already present. Never copies secrets.
 */
export function applyAuthConfigToEnvNames(input: {
  config: AuthConfig;
  origins?: readonly string[];
  tokenEnvs?: readonly string[];
}) {
  const existingOrigins = (input.origins ?? []).map(pinnedOrigin);
  const seen = new Set<string>();
  for (const origin of existingOrigins) {
    if (seen.has(origin))
      throw new OpmError(
        'INVALID_SPEC',
        `OPM_HOST_FETCH_ORIGINS lists duplicate origin ${origin}`,
      );
    seen.add(origin);
  }
  const tokenPresent = input.tokenEnvs !== undefined;
  if (tokenPresent && input.tokenEnvs!.length !== existingOrigins.length)
    throw new OpmError(
      'INVALID_SPEC',
      `OPM_HOST_FETCH_TOKEN_ENVS has ${input.tokenEnvs!.length} entries but OPM_HOST_FETCH_ORIGINS has ${existingOrigins.length}`,
    );
  const extra: { origin: string; tokenEnv: string }[] = [];
  for (const [origin, entry] of Object.entries(input.config.origins)) {
    if (seen.has(origin)) continue;
    extra.push({ origin, tokenEnv: entry.tokenEnv ?? '' });
  }
  if (extra.length === 0)
    return {
      origins: existingOrigins,
      tokenEnvs: tokenPresent
        ? [...input.tokenEnvs!]
        : existingOrigins.map(() => ''),
      changed: false,
    };
  return {
    origins: [...existingOrigins, ...extra.map((entry) => entry.origin)],
    tokenEnvs: [
      ...(tokenPresent ? [...input.tokenEnvs!] : existingOrigins.map(() => '')),
      ...extra.map((entry) => entry.tokenEnv),
    ],
    changed: true,
  };
}

function pinnedOrigin(value: string): string {
  try {
    return normalizePinnedOrigin(value);
  } catch (error) {
    if (error instanceof ProviderError)
      throw new OpmError('UNSAFE_PATH', error.message);
    throw error;
  }
}

function looksLikeSecret(value: string): boolean {
  const trimmed = value.trim();
  if (TOKEN_LIKELY_SECRET.test(trimmed)) return true;
  return trimmed.length >= 32 && !TOKEN_ENV_NAME.test(trimmed);
}

function assertTokenEnvName(value: string): void {
  if (looksLikeSecret(value))
    throw new OpmError(
      'UNSAFE_PATH',
      'tokenEnv looks like a secret value; pass an environment variable name',
    );
  if (!TOKEN_ENV_NAME.test(value))
    throw new OpmError('INVALID_SPEC', 'tokenEnv must match [A-Z_][A-Z0-9_]*');
}

function assertNoSecrets(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (looksLikeSecret(value))
      throw new OpmError(
        'UNSAFE_PATH',
        `Auth config ${path} looks like a secret; names only`,
      );
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries())
      assertNoSecrets(item, `${path}[${index}]`);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEYS.has(key.toLowerCase()))
        throw new OpmError(
          'UNSAFE_PATH',
          'Auth config must not store token values',
        );
      assertNoSecrets(child, `${path}.${key}`);
    }
  }
}

function serializeAuthConfig(config: AuthConfig): string {
  const origins: Record<string, { tokenEnv?: string }> = {};
  for (const key of Object.keys(config.origins).sort()) {
    const entry = config.origins[key];
    if (entry === undefined) continue;
    origins[key] =
      entry.tokenEnv === undefined || entry.tokenEnv === ''
        ? {}
        : { tokenEnv: entry.tokenEnv };
  }
  return `${JSON.stringify({ version: 1, origins }, null, 2)}\n`;
}

async function writeAuthConfig(
  path: string,
  config: AuthConfig,
): Promise<void> {
  // The directory is made mode 0700 where missing, judged this user's alone
  // and taken as opm's configuration root (ADR 0034), the links on the way to
  // it judged as a base's are: none in the project the command runs in, none
  // another user put in a sticky directory. The file is written and renamed
  // through its handle.
  const name = basename(path);
  const parent = await openJudgedRoot(dirname(path), {
    create: true,
    lastMayBeLink: true,
    forbidden: 0o022,
    chooser: 'config root',
    what: 'Registry auth configuration directory',
  });
  try {
    const temporary = `.${name}.${randomUUID()}.tmp`;
    const file = await openChild(
      parent,
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(serializeAuthConfig(config));
      if (process.platform !== 'win32') await file.chmod(0o600);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await renameChild(parent, temporary, name);
    } catch (error) {
      await removeChild(parent, temporary, { force: true }).catch(
        () => undefined,
      );
      throw error;
    }
  } finally {
    await parent.close();
  }
}

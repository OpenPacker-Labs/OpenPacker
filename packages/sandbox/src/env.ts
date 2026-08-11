import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Env keys that may pass into a jail without an explicit grant. */
const ALLOWLIST_PREFIXES = [
  'npm_config_',
  'npm_package_',
  'npm_lifecycle_',
] as const;

const ALLOWLIST_EXACT = new Set([
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TMP',
  'TEMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'INIT_CWD',
  'NODE_ENV',
  'npm_lifecycle_event',
  'npm_package_name',
  'npm_package_version',
]);

/**
 * Credential-shaped names never inherit unless an exact grant lists them.
 * Patterns cover common CI and cloud secrets.
 */
const DENY_EXACT = new Set([
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'AUBE_AUTH_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENPACKER_TOKEN',
]);

const DENY_PREFIXES = [
  'AWS_',
  'AZURE_',
  'GOOGLE_',
  'GCP_',
  'NPX_',
  'DOCKER_',
] as const;

const DENY_SUBSTRING = [
  '_TOKEN',
  '_SECRET',
  '_PASSWORD',
  '_API_KEY',
  'APIKEY',
] as const;

export function isDeniedCredential(name: string): boolean {
  if (DENY_EXACT.has(name)) return true;
  if (DENY_PREFIXES.some((p) => name.startsWith(p))) return true;
  const upper = name.toUpperCase();
  return DENY_SUBSTRING.some((s) => upper.includes(s));
}

export function isAllowlistedEnv(name: string): boolean {
  if (ALLOWLIST_EXACT.has(name)) return true;
  return ALLOWLIST_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Build a scrubbed environment for jail execution.
 *
 * Parent process env is the source for allowlisted keys; `extra` overlays;
 * `grantEnv` names may be copied from the parent even if credential-shaped
 * (reviewed package grant).
 */
export function scrubEnvironment(input: {
  parent?: NodeJS.ProcessEnv;
  extra?: Readonly<Record<string, string>>;
  grantEnv?: readonly string[];
  jailHome: string;
}): Record<string, string> {
  const parent = input.parent ?? process.env;
  const granted = new Set(input.grantEnv ?? []);
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (granted.has(key)) {
      out[key] = value;
      continue;
    }
    if (isDeniedCredential(key)) continue;
    if (isAllowlistedEnv(key)) out[key] = value;
  }

  if (input.extra) {
    for (const [key, value] of Object.entries(input.extra)) {
      if (isDeniedCredential(key) && !granted.has(key)) continue;
      out[key] = value;
    }
  }

  out.HOME = input.jailHome;
  out.USERPROFILE = input.jailHome;
  // Avoid leaking the real temp as a second home-like surface without grant.
  out.TMPDIR = join(input.jailHome, 'tmp');
  out.TEMP = out.TMPDIR;
  out.TMP = out.TMPDIR;
  return out;
}

export function defaultJailHomeRoot(): string {
  return join(tmpdir(), 'openpacker-sandbox');
}

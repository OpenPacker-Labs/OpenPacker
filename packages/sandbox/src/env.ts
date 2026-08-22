import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Env keys that may pass into a jail without an explicit grant. */
const ALLOWLIST_PREFIXES = ['npm_package_', 'npm_lifecycle_'] as const;

const NPM_CONFIG_SAFE = new Set([
  'npm_config_user_agent',
  'npm_config_cache',
  'npm_config_prefix',
  'npm_config_global',
  'npm_config_node_gyp',
  'npm_config_arch',
  'npm_config_platform',
  'npm_config_target_arch',
  'npm_config_target_platform',
  'npm_config_runtime',
  'npm_config_nodedir',
  'npm_config_disturl',
  'npm_config_python',
  'npm_config_msvs_version',
  'npm_config_build_from_source',
  'npm_config_unsafe_perm',
  'npm_config_loglevel',
]);

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

const DENY_EXACT = new Set([
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'AUBE_AUTH_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'OPENPACKER_TOKEN',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'DOCKER_AUTH_CONFIG',
  'KUBECONFIG',
  'PGPASSWORD',
  'MYSQL_PWD',
  'COMPOSER_AUTH',
  'BUN_AUTH_TOKEN',
  'PYPI_TOKEN',
  'TWINE_PASSWORD',
  'CARGO_REGISTRY_TOKEN',
]);

const DENY_PREFIXES = [
  'AWS_',
  'AZURE_',
  'GOOGLE_',
  'GCP_',
  'NPX_',
  'DOCKER_',
  'GITHUB_',
  'GH_',
  'GITLAB_',
  'CIRCLE_',
  'TRAVIS_',
  'NETLIFY_',
  'VERCEL_',
  'HEROKU_',
  'CF_',
  'VAULT_',
  'CONSUL_',
  'DIGITALOCEAN_',
  'LINODE_',
  'TF_VAR_',
  'OP_',
  'OPM_HOST_FETCH_',
] as const;

const DENY_SUBSTRING = [
  '_TOKEN',
  '_SECRET',
  '_PASSWORD',
  '_PASSWD',
  '_API_KEY',
  'APIKEY',
  '_AUTH',
  '_CREDENTIAL',
  '_PRIVATE_KEY',
  'PRIVATEKEY',
] as const;

export function isDeniedCredential(name: string): boolean {
  if (DENY_EXACT.has(name)) return true;
  if (DENY_PREFIXES.some((p) => name.startsWith(p))) return true;
  const upper = name.toUpperCase();
  if (
    name.startsWith('npm_config_') &&
    /auth|token|password|secret|_pass/i.test(name)
  )
    return true;
  return DENY_SUBSTRING.some((s) => upper.includes(s));
}

export function isAllowlistedEnv(name: string): boolean {
  if (ALLOWLIST_EXACT.has(name)) return true;
  if (NPM_CONFIG_SAFE.has(name)) return true;
  if (name.startsWith('npm_config_')) return false;
  return ALLOWLIST_PREFIXES.some((p) => name.startsWith(p));
}

/** Minimal PATH for package-exec (audit H1). */
export function minimalPathValue(interpreter?: string): string {
  const parts = ['/usr/bin', '/bin'];
  if (interpreter && interpreter.includes('/')) {
    parts.unshift(dirname(interpreter));
  }
  return [...new Set(parts)].join(':');
}

/**
 * Build a scrubbed environment for jail execution.
 */
export function scrubEnvironment(input: {
  parent?: NodeJS.ProcessEnv;
  extra?: Readonly<Record<string, string>>;
  grantEnv?: readonly string[];
  jailHome: string;
  /** When true (default for package-exec), replace PATH with a minimal set. */
  minimalPath?: boolean;
  /** Argv[0] used to include interpreter dir on PATH. */
  interpreter?: string;
}) {
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
  out.TMPDIR = join(input.jailHome, 'tmp');
  out.TEMP = out.TMPDIR;
  out.TMP = out.TMPDIR;

  if (input.minimalPath !== false && !granted.has('PATH')) {
    out.PATH = minimalPathValue(input.interpreter);
  }

  return out;
}

export function defaultJailHomeRoot(): string {
  return join(tmpdir(), 'openpacker-sandbox');
}

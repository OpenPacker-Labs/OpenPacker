/**
 * `opm auth` — origin → token-env-name user config (ADR 0041).
 *
 * Subcommands store names only. There is no --token, login, or device flow.
 */
import {
  applyAuthConfigToEnvNames,
  OpmError,
  readAuthConfig,
  removeAuthOrigin,
  upsertAuthOrigin,
} from '@openpacker/opm-project';
import { out } from '@openpacker/canonical';

export interface AuthCliIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

interface AuthArgs {
  positionals: string[];
  options: Map<string, string | true>;
}

const EXIT = {
  success: 0,
  usage: 2,
} as const;

const AUTH_USAGE = `Auth (env names only):
  opm auth set --origin <https-origin> [--token-env <NAME>]
  opm auth list
  opm auth unset --origin <https-origin>
Pin an origin without --token-env. Mint tokens outside opm; --token-env records a name, never a value.
`;

/**
 * Append auth-config origins and token-env *names* onto the process host-fetch
 * lists for this command only. Never writes process.env[tokenEnv].
 */
export async function applyAuthConfigForProcess(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = await readAuthConfig({ env });
  if (Object.keys(config.origins).length === 0) return;
  const origins = splitOrigins(env.OPM_HOST_FETCH_ORIGINS);
  const tokenEnvs = splitTokenEnvs(env.OPM_HOST_FETCH_TOKEN_ENVS);
  const applied = applyAuthConfigToEnvNames({
    config,
    origins,
    ...(tokenEnvs !== undefined && { tokenEnvs }),
  });
  if (!applied.changed) return;
  env.OPM_HOST_FETCH_ORIGINS = applied.origins.join(',');
  env.OPM_HOST_FETCH_TOKEN_ENVS = applied.tokenEnvs.join(',');
}

export async function runAuthCommand(
  args: AuthArgs,
  io: AuthCliIo,
): Promise<number> {
  if (args.options.has('token'))
    throw new OpmError(
      'UNSAFE_PATH',
      'opm auth does not accept --token. Name an environment variable with --token-env; mint the token outside opm.',
    );
  const sub = args.positionals[0];
  if (sub === 'set') return runSet(args, io);
  if (sub === 'list') return runList(io);
  if (sub === 'unset') return runUnset(args, io);
  io.stderr.write(
    `Unknown auth subcommand: ${sub ?? '(none)'}. Use set | list | unset.\n\n${AUTH_USAGE}`,
  );
  return EXIT.usage;
}

async function runSet(args: AuthArgs, io: AuthCliIo): Promise<number> {
  const origin = option(args, 'origin');
  const tokenEnv = option(args, 'token-env');
  if (origin === undefined) {
    io.stderr.write(
      `opm auth set requires --origin <https-origin>\n\n${AUTH_USAGE}`,
    );
    return EXIT.usage;
  }
  await upsertAuthOrigin({
    origin,
    ...(!(tokenEnv === undefined) && { tokenEnv }),
  });
  out(
    io,
    tokenEnv === undefined
      ? `Pinned ${origin}\n`
      : `Pinned ${origin} to env ${tokenEnv}\n`,
  );
  return EXIT.success;
}

async function runList(io: AuthCliIo): Promise<number> {
  const config = await readAuthConfig();
  const origins = Object.keys(config.origins).sort();
  if (origins.length === 0) {
    out(io, '(no origins)\n');
    return EXIT.success;
  }
  for (const origin of origins) {
    const entry = config.origins[origin];
    if (entry === undefined) continue;
    out(io, `${origin}\t${entry.tokenEnv ?? '(pin)'}\n`);
  }
  return EXIT.success;
}

async function runUnset(args: AuthArgs, io: AuthCliIo): Promise<number> {
  const origin = option(args, 'origin');
  if (origin === undefined) {
    io.stderr.write(
      `opm auth unset requires --origin <https-origin>\n\n${AUTH_USAGE}`,
    );
    return EXIT.usage;
  }
  await removeAuthOrigin({ origin });
  out(io, `Removed ${origin}\n`);
  return EXIT.success;
}

function option(args: AuthArgs, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

function splitOrigins(raw: string | undefined): string[] {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return [];
  const origins: string[] = [];
  for (const part of trimmed.split(',')) {
    const value = part.trim();
    if (value === '') continue;
    origins.push(value);
  }
  return origins;
}

function splitTokenEnvs(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw.split(',').map((part) => part.trim());
}

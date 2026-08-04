#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  OpmError,
  addPackage,
  activateGeneration,
  collectGarbage,
  environmentScript,
  environmentVariables,
  initProject,
  installProject,
  listGenerations,
  listInstalled,
  projectPaths,
  readEnvironmentState,
  removePackage,
  requireOpmRoot,
  rollbackTarget,
  switchGeneration,
  syncProject,
  uninstallProject,
  whyPackage,
  type Generation,
} from '@openpacker/opm-project';

export const EXIT_CODES = {
  success: 0,
  usage: 2,
  invalidInput: 3,
  notFound: 4,
  unsatisfiable: 5,
  policyDenied: 6,
  verificationFailed: 7,
  unavailable: 8,
  internal: 9,
} as const;

export interface CliIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

interface Parsed {
  command: string;
  positionals: string[];
  options: Map<string, string | true>;
}

const COMMANDS = new Set([
  'init',
  'add',
  'remove',
  'install',
  'uninstall',
  'sync',
  'update',
  'list',
  'why',
  'generations',
  'rollback',
  'gc',
  'shell',
  'help',
]);

export async function runOpm(
  argv = process.argv.slice(2),
  io: CliIo = process,
  cwd = process.cwd(),
): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (
      args.command === 'help' ||
      args.options.has('help') ||
      args.command === ''
    ) {
      io.stdout.write(help());
      return EXIT_CODES.success;
    }
    if (!COMMANDS.has(args.command)) {
      throw usage(`Unknown command: ${args.command}`);
    }

    switch (args.command) {
      case 'init': {
        const root = option(args, 'path') ?? cwd;
        const name = option(args, 'name');
        const result = await initProject({
          root,
          ...(name !== undefined ? { name } : {}),
          force: args.options.has('force'),
        });
        io.stdout.write(
          result.created
            ? `Initialized opm project at ${result.manifestPath}\n`
            : `opm project already exists at ${result.manifestPath}\n`,
        );
        io.stdout.write(`Next: opm add <pkg> --ecosystem npm && opm install\n`);
        return EXIT_CODES.success;
      }
      case 'add': {
        const root = await requireOpmRoot(cwd);
        const spec = args.positionals[0];
        if (!spec) throw usage('opm add requires a package spec');
        const ecosystem = option(args, 'ecosystem') ?? option(args, 'e');
        const source = option(args, 'source');
        const alias = option(args, 'alias');
        const result = await addPackage({
          root,
          spec,
          ...(ecosystem !== undefined ? { ecosystem } : {}),
          ...(source !== undefined ? { source } : {}),
          ...(alias !== undefined ? { alias } : {}),
          offline: args.options.has('offline'),
        });
        io.stdout.write(
          `Added ${result.alias} → ${result.lock.packages[result.alias]?.purl ?? result.alias}\n`,
        );
        io.stdout.write(`Installed into ${projectPaths(root).store}\n`);
        return EXIT_CODES.success;
      }
      case 'remove': {
        const root = await requireOpmRoot(cwd);
        const alias = args.positionals[0];
        if (!alias) throw usage('opm remove requires a package alias');
        await removePackage({
          root,
          alias,
          offline: args.options.has('offline'),
        });
        io.stdout.write(`Removed ${alias} from manifest, lock, and install\n`);
        return EXIT_CODES.success;
      }
      case 'install': {
        const root = await requireOpmRoot(cwd);
        const result = await installProject({
          root,
          offline: args.options.has('offline'),
        });
        const count = Object.keys(result.state.packages).length;
        io.stdout.write(
          `Installed ${count} package(s) into ${projectPaths(root).opmDir}\n`,
        );
        io.stdout.write(
          `Bins: ${projectPaths(root).bin}  (export PATH="$PWD/.opm/bin:$PATH")\n`,
        );
        return EXIT_CODES.success;
      }
      case 'uninstall': {
        const root = await requireOpmRoot(cwd);
        const alias = args.positionals[0];
        await uninstallProject({
          root,
          ...(alias !== undefined ? { alias } : {}),
        });
        io.stdout.write(
          alias
            ? `Uninstalled ${alias} (left in manifest/lock unless you opm remove)\n`
            : `Uninstalled all project packages from .opm/\n`,
        );
        return EXIT_CODES.success;
      }
      case 'sync':
      case 'update': {
        const root = await requireOpmRoot(cwd);
        // update = sync for v1 (re-resolve from manifest)
        const result = await syncProject({
          root,
          offline: args.options.has('offline'),
        });
        const count = Object.keys(result.lock.packages).length;
        io.stdout.write(
          `Synced ${count} package(s); lock and .opm/ store updated\n`,
        );
        return EXIT_CODES.success;
      }
      case 'list': {
        const root = await requireOpmRoot(cwd);
        const rows = await listInstalled(root);
        if (rows.length === 0) {
          io.stdout.write('(no packages)\n');
          return EXIT_CODES.success;
        }
        for (const row of rows) {
          const digest =
            row.digest.length > 15 ? `${row.digest.slice(0, 15)}…` : row.digest;
          const status = row.installed ? 'installed' : 'not-installed';
          const bins =
            row.bins.length > 0 ? ` bins=[${row.bins.join(',')}]` : '';
          io.stdout.write(
            `${row.alias}\t${row.purl}\t${digest}\t${status}${bins}\n`,
          );
        }
        return EXIT_CODES.success;
      }
      case 'why': {
        const root = await requireOpmRoot(cwd);
        const alias = args.positionals[0];
        if (!alias) throw usage('opm why requires a package alias');
        io.stdout.write(`${await whyPackage(root, alias)}\n`);
        return EXIT_CODES.success;
      }
      case 'generations': {
        const root = await requireOpmRoot(cwd);
        const state = await readEnvironmentState(root);
        const generations = await listGenerations(root);
        if (generations.length === 0) {
          io.stdout.write('No generations yet. Run: opm install\n');
          return EXIT_CODES.success;
        }
        for (const generation of generations) {
          const current =
            generation.generationDigest === state?.currentGenerationDigest;
          io.stdout.write(
            `${current ? '*' : ' '} ${generation.sequence}\t${generation.createdAt}\t${generation.members.length} package(s)\n`,
          );
        }
        return EXIT_CODES.success;
      }
      case 'rollback': {
        const root = await requireOpmRoot(cwd);
        const to = option(args, 'to');
        const target = to
          ? await switchGeneration({ root, target: Number(to) })
          : await rollbackToPrevious(root);
        await reinstallGeneration(root, target);
        io.stdout.write(`Rolled back to generation ${target.sequence}\n`);
        return EXIT_CODES.success;
      }
      case 'gc': {
        const root = await requireOpmRoot(cwd);
        const keepValue = option(args, 'keep');
        const result = await collectGarbage({
          root,
          ...(keepValue === undefined ? {} : { keep: Number(keepValue) }),
          dryRun: args.options.has('dry-run'),
        });
        const verb = args.options.has('dry-run') ? 'Would remove' : 'Removed';
        io.stdout.write(
          `${verb} ${result.removed.length} store path(s); retained ${result.retained.length} generation(s)\n`,
        );
        for (const path of result.removed) io.stdout.write(`  ${path}\n`);
        return EXIT_CODES.success;
      }
      case 'shell': {
        const root = await requireOpmRoot(cwd);
        if (args.options.has('json')) {
          const environment = await environmentVariables({ root });
          io.stdout.write(`${JSON.stringify(environment, null, 2)}\n`);
          return EXIT_CODES.success;
        }
        // Printing assignments keeps this composable: `eval "$(opm shell)"`
        // works without opm needing to spawn or manage a shell.
        io.stdout.write(await environmentScript({ root }));
        return EXIT_CODES.success;
      }
      default:
        throw usage(`Unhandled command ${args.command}`);
    }
  } catch (error) {
    return handleError(error, io);
  }
}

/** Roll back one step, which is the common case. */
async function rollbackToPrevious(root: string): Promise<Generation> {
  const target = await rollbackTarget(root);
  if (!target)
    throw new OpmError(
      'NOT_FOUND',
      'There is no earlier generation to roll back to',
    );
  return switchGeneration({ root, target: target.generationDigest });
}

/**
 * Rebuild the derived view for a generation. The record is the source of
 * truth, so switching is a pointer move plus an idempotent regeneration.
 */
async function reinstallGeneration(
  root: string,
  generation: Generation,
): Promise<void> {
  await activateGeneration({ root, generation });
}

function handleError(error: unknown, io: CliIo): number {
  if (error instanceof UsageError) {
    io.stderr.write(`${error.message}\n`);
    return EXIT_CODES.usage;
  }
  if (error instanceof OpmError) {
    io.stderr.write(`opm: ${error.message}\n`);
    switch (error.code) {
      case 'NOT_FOUND':
      case 'NO_PROJECT':
        return EXIT_CODES.notFound;
      case 'AMBIGUOUS_SPEC':
      case 'INVALID_SPEC':
      case 'INVALID_MANIFEST':
      case 'INVALID_LOCK':
      case 'INVALID_CATALOG':
        return EXIT_CODES.invalidInput;
      case 'UNRESOLVABLE':
        return EXIT_CODES.unsatisfiable;
      case 'DIGEST_MISMATCH':
      case 'SIZE_MISMATCH':
      case 'UNSAFE_PATH':
      case 'UNSAFE_BIN':
      case 'INVALID_DIGEST':
        return EXIT_CODES.verificationFailed;
      case 'OFFLINE':
      case 'FETCH_FAILED':
      case 'UNAVAILABLE':
        return EXIT_CODES.unavailable;
      case 'ECOSYSTEM_DENIED':
      case 'POLICY':
        return EXIT_CODES.policyDenied;
      default:
        return EXIT_CODES.internal;
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  io.stderr.write(`opm: internal error: ${message}\n`);
  return EXIT_CODES.internal;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function usage(message: string): UsageError {
  return new UsageError(`${message}\n\n${help()}`);
}

function parseArgs(argv: string[]): Parsed {
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  let command = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        options.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (
          next !== undefined &&
          !next.startsWith('-') &&
          !isBooleanFlag(key)
        ) {
          options.set(key, next);
          i += 1;
        } else {
          options.set(key, true);
        }
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      const long = shortToLong(key);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-') && !isBooleanFlag(long)) {
        options.set(long, next);
        i += 1;
      } else {
        options.set(long, true);
      }
      continue;
    }
    if (command === '') command = arg;
    else positionals.push(arg);
  }
  return { command, positionals, options };
}

function shortToLong(short: string): string {
  switch (short) {
    case 'e':
      return 'ecosystem';
    case 'h':
      return 'help';
    default:
      return short;
  }
}

function isBooleanFlag(key: string): boolean {
  return (
    key === 'help' || key === 'force' || key === 'offline' || key === 'json'
  );
}

function option(args: Parsed, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

function help(): string {
  return `opm — Open Package Manager

Usage:
  opm init [--name <name>] [--path <dir>]
  opm add <spec> [--ecosystem|-e <eco>] [--source <file|url>] [--alias <name>] [--offline]
  opm remove <alias>
  opm install [--offline]
  opm uninstall [alias]
  opm sync [--offline]
  opm update [--offline]
  opm list
  opm why <alias>

Specs:
  pkg:npm/@scope/name@1.2.3
  lodash@4.17.21 --ecosystem npm
  demo-tool --ecosystem npm --source ./vendor/demo-tool.tgz

Project files:
  opm.toml          requirements (edit or use opm add/remove)
  opm.lock.json     exact pins (generated)
  .opm/store        content-addressed installs
  .opm/bin          executable shims (use with opmx or PATH)

Execute installed bins with: opmx <bin|package> [args...]

Aliases: opkg, opkgm → opm
Protocol/control plane: openpacker (advanced)
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runOpm();
}

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  OpmError,
  projectPaths,
  readProjectState,
  requireOpmRoot,
  resolveExecutable,
  fetchTool,
  selectToolBin,
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

export async function runOpmx(
  argv = process.argv.slice(2),
  io: CliIo = process,
  cwd = process.cwd(),
): Promise<number> {
  try {
    if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
      io.stdout.write(help());
      return argv.length === 0 ? EXIT_CODES.usage : EXIT_CODES.success;
    }

    const { packageAlias, binName, positionals, passthrough } = parse(argv);

    // A PURL means "run this tool", not "run something this project
    // installed" — the npx/uvx/pipx-run shape. It deliberately does not need a
    // project, since the whole point is not having to make one.
    const requested = packageAlias ?? positionals[0];
    if (requested !== undefined && requested.startsWith('pkg:')) {
      const tool = await fetchTool({ purl: requested });
      const bin = selectToolBin(tool, binName);
      const target = join(
        tool.storePath,
        ...bin.path.split('/').filter(Boolean),
      );
      // Say which version actually ran. An unpinned ephemeral run resolves to
      // whatever is newest, so it is a different thing tomorrow.
      io.stderr.write(
        `opmx: ${tool.exactPurl}${tool.cached ? ' (cached)' : ''}\n`,
      );
      return await spawnTool(target, passthrough, io, cwd);
    }

    const root = await requireOpmRoot(cwd);
    const paths = projectPaths(root);
    const state = await readProjectState(paths.projectState);
    if (!state || Object.keys(state.packages).length === 0) {
      throw new OpmError(
        'NOT_FOUND',
        'No packages installed. Run: opm install  or  opm sync',
      );
    }

    const projectStateBins = Object.values(state.packages).flatMap((pkg) =>
      pkg.bins.map((b) => ({
        name: b.name,
        packageAlias: pkg.alias,
        shim: b.shim,
        target:
          b.target ?? join(pkg.storePath, ...b.path.split('/').filter(Boolean)),
      })),
    );

    const resolved = await resolveExecutable({
      binDir: paths.bin,
      projectStateBins,
      ...(packageAlias !== undefined ? { packageAlias } : {}),
      ...(binName !== undefined ? { binName } : {}),
      ...(positionals[0] !== undefined ? { positional: positionals[0] } : {}),
    });

    return await spawnTool(resolved.target, passthrough, io, cwd);
  } catch (error) {
    if (error instanceof OpmError) {
      io.stderr.write(`opmx: ${error.message}\n`);
      if (error.code === 'NOT_FOUND' || error.code === 'NO_PROJECT')
        return EXIT_CODES.notFound;
      if (error.code === 'USAGE') return EXIT_CODES.usage;
      return EXIT_CODES.internal;
    }
    io.stderr.write(
      `opmx: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_CODES.internal;
  }
}

/**
 * Run a resolved executable and forward its exit status.
 *
 * Shared by both paths so an ephemeral tool behaves exactly like an installed
 * one: same stdio, same signal handling, same exit code.
 */
async function spawnTool(
  target: string,
  args: readonly string[],
  io: CliIo,
  cwd: string,
): Promise<number> {
  const useInherit = io.stdout === process.stdout;
  return new Promise<number>((resolvePromise) => {
    const child = spawn(process.execPath, [target, ...args], {
      stdio: useInherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: process.env,
      cwd,
    });
    if (!useInherit) {
      child.stdout?.on('data', (chunk: Buffer | string) => {
        io.stdout.write(String(chunk));
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        io.stderr.write(String(chunk));
      });
    }
    child.on('error', (error) => {
      io.stderr.write(`opmx: ${error.message}\n`);
      resolvePromise(EXIT_CODES.internal);
    });
    child.on('exit', (code, signal) => {
      if (signal) {
        resolvePromise(1);
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

function parse(argv: string[]): {
  packageAlias?: string;
  binName?: string;
  positionals: string[];
  passthrough: string[];
} {
  let packageAlias: string | undefined;
  let binName: string | undefined;
  const positionals: string[] = [];
  const passthrough: string[] = [];
  let i = 0;
  let seenSelector = false;
  while (i < argv.length) {
    const arg = argv[i] ?? '';
    if (arg === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '--package' || arg === '-p') {
      packageAlias = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg.startsWith('--package=')) {
      packageAlias = arg.slice('--package='.length);
      i += 1;
      continue;
    }
    if (arg === '--bin' || arg === '-c' || arg === '-b') {
      binName = argv[i + 1];
      i += 2;
      continue;
    }
    if (arg.startsWith('--bin=')) {
      binName = arg.slice('--bin='.length);
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      i += 1;
      continue;
    }
    if (!seenSelector && !arg.startsWith('-')) {
      positionals.push(arg);
      seenSelector = true;
      i += 1;
      // remaining args after selector are passthrough
      passthrough.push(...argv.slice(i));
      break;
    }
    passthrough.push(arg);
    i += 1;
  }
  return {
    ...(packageAlias !== undefined ? { packageAlias } : {}),
    ...(binName !== undefined ? { binName } : {}),
    positionals,
    passthrough,
  };
}

function help(): string {
  return `opmx — execute a package binary

From this project's install (needs opm.toml and a prior opm install/sync):
  opmx <package-or-bin> [args...]
  opmx --package <alias> [--bin <name>] -- [args...]
  opmx -p demo-tool -c demo-tool -- --version

Straight from a registry, without installing — the npx/uvx/pipx-run shape.
No project required:
  opmx pkg:npm/json@11.0.0 -- --version
  opmx pkg:npm/json                     # newest published version
  opmx pkg:npm/some-tool --bin other    # when a package ships several

Tools are cached content-addressed, so a repeat run downloads nothing. The
resolved version is printed to stderr, because an unpinned run is a different
thing tomorrow. Cache location: OPM_TOOL_CACHE, else XDG_CACHE_HOME, else
~/.cache/openpacker/x.
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runOpmx();
}

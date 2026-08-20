#!/usr/bin/env node
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { registerPlugin } from '@openpacker/plugin-host';
import {
  OpmError,
  activateGeneration,
  projectPaths,
  readEnvironmentState,
  readGeneration,
  requireOpmRoot,
  resolveExecutable,
  fetchTool,
  selectToolBin,
  runSandboxedPackageProcess,
  readManifestFile,
} from '@openpacker/opm-project';
import type { PolicyInput } from '@openpacker/contracts';

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

    const { packageAlias, binName, positionals, passthrough, ...flags } =
      parse(argv);

    // Process entry registers adapters; core never imports ecosystems by name.
    // opmx is its own process entry, so an ephemeral `pkg:` run needs the
    // default registry here just as `opm` installs it for its commands.
    const adapterRegistry = configureDefaultAdapters();

    // `--plugin <name>` makes an already-installed delegated adapter plugin
    // answer before the run resolves the tool (ADR 0039). The flag never
    // acquires: an uninstalled name is PLUGIN_NOT_INSTALLED.
    const registeredPlugins = [];
    if (flags.plugins.length > 0) {
      const environment = grantedEnvironment(flags.allowEnv);
      for (const name of flags.plugins)
        registeredPlugins.push(
          await registerPlugin(name, {
            registry: adapterRegistry,
            allowEnvironment: flags.allowEnv,
            environment,
          }),
        );
    }

    // A PURL means "run this tool", not "run something this project
    // installed" — the npx/uvx/pipx-run shape. It deliberately does not need a
    // project, since the whole point is not having to make one. With
    // --plugin, a bare tool name means the plugin's purl type; that is only
    // unambiguous when the named plugins declare exactly one.
    let requested = packageAlias ?? positionals[0];
    if (
      requested !== undefined &&
      !requested.startsWith('pkg:') &&
      registeredPlugins.length > 0
    ) {
      const types = [
        ...new Set(registeredPlugins.flatMap((plugin) => plugin.purlTypes)),
      ];
      if (types.length !== 1)
        throw new OpmError(
          'USAGE',
          `Cannot tell which purl type "${requested}" belongs to: the named ` +
            `plugins serve ${types.join(', ') || 'none'}. ` +
            `Pass a full purl, e.g. pkg:<type>/${requested}.`,
        );
      requested = `pkg:${types[0]}/${requested}`;
    }
    if (requested !== undefined && requested.startsWith('pkg:')) {
      const tool = await fetchTool({
        purl: requested,
        ...(flags.offline ? { offline: true } : {}),
      });
      const bin = selectToolBin(tool, binName);
      // Say which version actually ran. An unpinned ephemeral run resolves to
      // whatever is newest, so it is a different thing tomorrow.
      io.stderr.write(
        `opmx: ${tool.exactPurl}${tool.cached ? ' (cached)' : ''}\n`,
      );
      return await spawnDeclared(
        bin,
        tool.storePath,
        passthrough,
        io,
        cwd,
        tool.runtimePaths,
        tool.exactPurl,
      );
    }

    const root = await requireOpmRoot(cwd);
    const paths = projectPaths(root);
    let projectPolicy: PolicyInput | undefined;
    try {
      projectPolicy = (await readManifestFile(paths.manifest)).policy;
    } catch {
      projectPolicy = undefined;
    }
    const environment = await readEnvironmentState(root);
    if (!environment)
      throw new OpmError(
        'INVALID_STATE',
        'No verified environment generation is active; run: opm install',
      );
    const generation = await readGeneration(
      root,
      environment.currentGenerationDigest,
    );
    const state = await activateGeneration({ root, generation });
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

    const pkgId = resolved.packageAlias
      ? state.packages[resolved.packageAlias]?.purl
      : undefined;
    return await spawnTool(resolved.target, passthrough, io, cwd, {
      projectRoot: root,
      storePaths: Object.values(state.packages).map((p) => p.storePath),
      ...(pkgId === undefined ? {} : { packageId: pkgId }),
      ...(projectPolicy === undefined ? {} : { policy: projectPolicy }),
    });
  } catch (error) {
    io.stderr.write(
      `opmx: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return exitForError(error);
  }
}

/**
 * Exit status for a failure, by error code.
 *
 * Plugin operations surface ProviderError, which is not an OpmError; both
 * carry a string `code`, and both map here instead of collapsing into a
 * generic internal error.
 */
function exitForError(error: unknown): number {
  let code: string | undefined;
  if (error instanceof OpmError) code = error.code;
  else if (error instanceof Error && 'code' in error) {
    const candidate = (error as { code: unknown }).code;
    if (typeof candidate === 'string') code = candidate;
  }
  switch (code) {
    case 'NOT_FOUND':
    case 'NO_PROJECT':
    case 'PLUGIN_NOT_INSTALLED':
      return EXIT_CODES.notFound;
    case 'USAGE':
      return EXIT_CODES.usage;
    case 'SANDBOX_UNAVAILABLE':
    case 'POLICY_DENIED':
      return EXIT_CODES.policyDenied;
    case 'OFFLINE':
    case 'PLUGIN_ERROR':
    case 'PLUGIN_FAILED':
      return EXIT_CODES.unavailable;
    case 'DIGEST_MISMATCH':
    case 'PLUGIN_DIGEST_MISMATCH':
    case 'INVALID_DIGEST':
      return EXIT_CODES.verificationFailed;
    default:
      return EXIT_CODES.internal;
  }
}

/**
 * Run an entry point with whatever interpreter its ecosystem needs.
 *
 * npm ships a script Node executes; a Python console script is a module and a
 * callable, with no file to point at. Dispatching here is what lets one runner
 * serve both rather than only finding npm packages runnable.
 */
async function spawnDeclared(
  bin: { path: string; interpreter?: string; entry?: string; name: string },
  storePath: string,
  args: readonly string[],
  io: CliIo,
  cwd: string,
  runtimePaths: readonly string[] = [storePath],
  packageId?: string,
  policy?: PolicyInput,
): Promise<number> {
  const sandboxCtx = {
    storePaths: runtimePaths.length > 0 ? runtimePaths : [storePath],
    ...(packageId === undefined ? {} : { packageId }),
    ...(policy === undefined ? {} : { policy }),
  };
  if (bin.interpreter === 'python') {
    const [moduleName, callable] = (bin.entry ?? '').split(':');
    if (!moduleName || !callable)
      throw new OpmError(
        'NOT_FOUND',
        `${bin.name} declares an unusable entry point: ${bin.entry ?? '(none)'}`,
      );
    // Every store root in the runtime closure goes on sys.path so transitive
    // dependencies resolved into the tool cache are importable.
    const roots = runtimePaths.length > 0 ? runtimePaths : [storePath];
    const inserts = roots
      .map((root) => `sys.path.insert(0, ${JSON.stringify(root)})`)
      .join('\n');
    const program =
      'import sys\n' +
      `${inserts}\n` +
      `from ${moduleName} import ${callable} as _entry\n` +
      'sys.exit(_entry())\n';
    return spawnProcess(
      pythonExecutable(),
      ['-c', program, ...args],
      io,
      cwd,
      sandboxCtx,
      `${bin.name} needs a Python interpreter on PATH`,
    );
  }
  if (bin.interpreter === 'dotnet') {
    // A .NET tool is a managed assembly; `dotnet` is the runner its own
    // manifest names.
    const assembly = join(storePath, ...bin.path.split('/').filter(Boolean));
    return spawnProcess(
      process.env.OPM_DOTNET?.trim() || 'dotnet',
      [assembly, ...args],
      io,
      cwd,
      sandboxCtx,
      `${bin.name} needs the .NET runtime on PATH`,
    );
  }
  const target = join(storePath, ...bin.path.split('/').filter(Boolean));
  return spawnTool(target, args, io, cwd, sandboxCtx);
}

/** The Python to run console scripts with. */
function pythonExecutable(): string {
  return process.env.OPM_PYTHON?.trim() || 'python3';
}

/**
 * Run a resolved executable and forward its exit status.
 *
 * Shared by both paths so an ephemeral tool behaves exactly like an installed
 * one: same stdio, same signal handling, same exit code. Execution goes
 * through the project sandbox funnel (ADR 0036).
 */
async function spawnTool(
  target: string,
  args: readonly string[],
  io: CliIo,
  cwd: string,
  sandbox?: {
    projectRoot?: string;
    storePaths?: readonly string[];
    packageId?: string;
    policy?: PolicyInput;
  },
): Promise<number> {
  return spawnProcess(process.execPath, [target, ...args], io, cwd, sandbox);
}

async function spawnProcess(
  command: string,
  argv: readonly string[],
  io: CliIo,
  cwd: string,
  sandbox?: {
    projectRoot?: string;
    storePaths?: readonly string[];
    packageId?: string;
    policy?: PolicyInput;
  },
  missingHint?: string,
): Promise<number> {
  try {
    const outcome = await runSandboxedPackageProcess({
      argv: [command, ...argv],
      cwd,
      ...(sandbox?.projectRoot === undefined
        ? {}
        : { projectRoot: sandbox.projectRoot }),
      ...(sandbox?.storePaths === undefined
        ? {}
        : { storePaths: sandbox.storePaths }),
      ...(sandbox?.packageId === undefined
        ? {}
        : { packageId: sandbox.packageId }),
      ...(sandbox?.policy === undefined ? {} : { policy: sandbox.policy }),
    });
    if (outcome.stdout) io.stdout.write(outcome.stdout);
    if (outcome.stderr) io.stderr.write(outcome.stderr);
    if (
      outcome.exitCode !== 0 &&
      outcome.backend === 'none' &&
      !outcome.enforced
    ) {
      // fail-closed already threw SANDBOX_UNAVAILABLE for required mode;
      // degraded path still returns exit codes.
    }
    return outcome.exitCode;
  } catch (error) {
    if (error instanceof OpmError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const missing =
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT';
    io.stderr.write(
      `opmx: ${missing && missingHint ? `${missingHint} (${command} not found)` : message}\n`,
    );
    return missing && missingHint
      ? EXIT_CODES.unavailable
      : EXIT_CODES.internal;
  }
}

export const parseForTest = (argv: string[]) => parse(argv);

/**
 * Values for `--allow-env` names, read from the operator's own environment at
 * the moment of consent — mirroring `opm pack --allow-env`: a name is granted
 * explicitly, its value is never written anywhere opm controls.
 */
function grantedEnvironment(
  names: readonly string[],
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {};
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
      throw new OpmError('USAGE', `Invalid --allow-env name: ${name}`);
    const value = process.env[name];
    if (value === undefined)
      throw new OpmError(
        'USAGE',
        `--allow-env ${name}: the variable is not set in this environment`,
      );
    environment[name] = value;
  }
  return environment;
}

function parse(argv: string[]): {
  packageAlias?: string;
  binName?: string;
  positionals: string[];
  passthrough: string[];
  plugins: string[];
  allowEnv: string[];
  offline: boolean;
} {
  let packageAlias: string | undefined;
  let binName: string | undefined;
  const positionals: string[] = [];
  const passthrough: string[] = [];
  const plugins: string[] = [];
  const allowEnv: string[] = [];
  let offline = false;
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
    if (arg === '--plugin') {
      const name = argv[i + 1];
      if (name === undefined || name.startsWith('--'))
        throw new OpmError('USAGE', 'opmx --plugin requires a plugin name');
      plugins.push(name);
      i += 2;
      continue;
    }
    if (arg.startsWith('--plugin=')) {
      const name = arg.slice('--plugin='.length);
      if (name === '')
        throw new OpmError('USAGE', 'opmx --plugin requires a plugin name');
      plugins.push(name);
      i += 1;
      continue;
    }
    if (arg === '--allow-env') {
      const name = argv[i + 1];
      if (name === undefined || name.startsWith('--'))
        throw new OpmError(
          'USAGE',
          'opmx --allow-env requires an environment variable name',
        );
      allowEnv.push(name);
      i += 2;
      continue;
    }
    if (arg.startsWith('--allow-env=')) {
      allowEnv.push(arg.slice('--allow-env='.length));
      i += 1;
      continue;
    }
    if (arg === '--offline') {
      offline = true;
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
      // Everything after the selector belongs to the tool. A `--` sitting
      // immediately there is the separator itself and must not be forwarded:
      // `opmx tool -- -t x` was handing the tool a literal "--", which any
      // argument parser reads as end-of-options and then fails on the flags
      // that follow.
      if (argv[i] === '--') i += 1;
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
    plugins,
    allowEnv,
    offline,
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

Third-party purl types come from delegated adapter plugins (opm plugin add).
--plugin names an installed plugin to register for this run; it never
installs one:
  opmx --plugin acme pkg:acme/some-tool
  opmx --plugin acme some-tool    # when the plugin serves one purl type
A plugin's declared environment stays unforwarded unless each name is granted
with --allow-env NAME (repeatable). --offline refuses an ephemeral resolve.

Tools are cached content-addressed, so a repeat run downloads nothing. The
resolved version is printed to stderr, because an unpinned run is a different
thing tomorrow. Cache location: OPM_TOOL_CACHE, else XDG_CACHE_HOME, else
~/.cache/openpacker/x.
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runOpmx();
}

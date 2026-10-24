#!/usr/bin/env node
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { registerPlugin } from '@openpacker/plugin-host';
import {
  OpmError,
  activateGeneration,
  enableDefaultSharedStore,
  projectPaths,
  readEnvironmentState,
  readGeneration,
  requireOpmRoot,
  resolveExecutable,
  fetchTool,
  selectToolBin,
  readManifestFile,
  parsePackageSpec,
} from '@openpacker/opm-project';
import type { PolicyInput } from '@openpacker/contracts';
import { out } from '@openpacker/canonical';
import { formatFailure, parseFailure, report } from './error-report.js';
import { grantedEnvironment, help, parse } from './opmx-args.js';
import { holdingSignals } from './opmx-signals.js';
import {
  EXIT_CODES,
  runTool,
  spawnDeclared,
  spawnTool,
  type CliIo,
} from './opmx-spawn.js';

export { EXIT_CODES, type CliIo } from './opmx-spawn.js';

export async function runOpmx(
  argv = process.argv.slice(2),
  io: CliIo = process,
  cwd = process.cwd(),
): Promise<number> {
  try {
    if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
      out(io, help());
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
    // `packslip:jdx/hk` is a spelling of a PURL, like any other.
    if (requested?.startsWith('packslip:'))
      requested = parsePackageSpec(requested).purl;
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
        ...(flags.offline && { offline: true }),
      });
      const bin = selectToolBin(tool, binName);
      // Say which version actually ran. An unpinned ephemeral run resolves to
      // whatever is newest, so it is a different thing tomorrow.
      io.stderr.write(
        report('opmx: ', `${tool.exactPurl}${tool.cached ? ' (cached)' : ''}`),
      );
      // An npm script runs from a node_modules of its closure, bound whole.
      return await holdingSignals((signal) =>
        runTool(tool, bin, passthrough, io, cwd, signal),
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
      ...(packageAlias !== undefined && { packageAlias }),
      ...(binName !== undefined && { binName }),
      ...(positionals[0] !== undefined && { positional: positionals[0] }),
    });

    const pkgId = resolved.packageAlias
      ? state.packages[resolved.packageAlias]?.purl
      : undefined;
    // Dispatch on the bin's declared interpreter, exactly as an ephemeral
    // run does: a native or Python or .NET bin is not a Node script, and
    // running it through process.execPath is a deferred crash, not a run.
    const owner =
      resolved.packageAlias === undefined
        ? undefined
        : state.packages[resolved.packageAlias];
    const declared = owner?.bins.find((bin) => bin.name === resolved.name);
    const sandbox = {
      projectRoot: root,
      ...(!(pkgId === undefined) && { packageId: pkgId }),
      ...(!(projectPolicy === undefined) && { policy: projectPolicy }),
    };
    const storePaths = Object.values(state.packages).map(
      (pkg) => pkg.storePath,
    );
    if (owner !== undefined && declared !== undefined) {
      const bin = {
        name: declared.name,
        path: declared.path,
        ...(!(declared.interpreter === undefined) && {
          interpreter: declared.interpreter,
        }),
        ...(!(declared.entry === undefined) && { entry: declared.entry }),
      };
      return await holdingSignals((signal) =>
        spawnDeclared(bin, owner.storePath, passthrough, io, cwd, {
          ...sandbox,
          runtimePaths: storePaths,
          signal,
        }),
      );
    }
    return await holdingSignals((signal) =>
      spawnTool(resolved.target, passthrough, io, cwd, {
        ...sandbox,
        storePaths,
        signal,
      }),
    );
  } catch (error) {
    io.stderr.write(formatFailure(parseFailure(error), { tool: 'opmx' }));
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
export function exitForError(error: unknown): number {
  let code: string | undefined;
  if (error instanceof OpmError) code = error.code;
  else if (error instanceof Error && 'code' in error) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const candidate = (error as { code: unknown }).code;
    if (typeof candidate === 'string') code = candidate;
  }
  switch (code) {
    case 'NOT_FOUND':
    case 'NO_PROJECT':
    case 'PLUGIN_NOT_INSTALLED':
    case 'VERSION_NOT_FOUND':
      return EXIT_CODES.notFound;
    case 'USAGE':
      return EXIT_CODES.usage;
    case 'INVALID_PACKSLIP_INPUT':
      return EXIT_CODES.invalidInput;
    case 'HOST_INCOMPATIBLE':
      return EXIT_CODES.unsatisfiable;
    case 'SANDBOX_UNAVAILABLE':
    case 'POLICY_DENIED':
    // A signer that changed is a decision for a person, not a failure.
    case 'TRUST_CHANGE_REQUIRES_APPROVAL':
    case 'ARTIFACT_TOO_LARGE':
      return EXIT_CODES.policyDenied;
    case 'OFFLINE':
    case 'PLUGIN_ERROR':
    case 'PLUGIN_FAILED':
    case 'UPSTREAM_UNAVAILABLE':
      return EXIT_CODES.unavailable;
    case 'DIGEST_MISMATCH':
    case 'SIZE_MISMATCH':
    case 'PLUGIN_DIGEST_MISMATCH':
    case 'INVALID_DIGEST':
    // The same classes of failure as `opm`: a signature or signer that does not hold.
    case 'SIGNATURE_VERIFICATION_FAILED':
    case 'INVALID_PACKSLIP_METADATA':
      return EXIT_CODES.verificationFailed;
    default:
      return EXIT_CODES.internal;
  }
}

export const parseForTest = (argv: string[]) => parse(argv);

/** The `opmx` process: the user-level package store `opm` uses, then the run. */
export async function runOpmxFromProcess(): Promise<number> {
  enableDefaultSharedStore();
  return await runOpmx();
}

// The `opmx` bin is `opmx-main.js`. This is false when the file is started
// through a link, so it serves only `node dist/opmx.js` by its own path.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runOpmxFromProcess();
}

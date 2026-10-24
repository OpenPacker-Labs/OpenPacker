#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { out, outJson, outRaw, plainLine } from '@openpacker/canonical';
import {
  registerInstalledPlugins,
  verifyPluginBindings,
} from '@openpacker/plugin-host';
import {
  addPlugin,
  listPlugins,
  parsePluginSpec,
  removePlugin,
} from '@openpacker/plugin-store';
import {
  OpmError,
  addPackage,
  configurePackProviders,
  enableDefaultSharedStore,
  ecosystemFromPurl,
  environmentScript,
  environmentVariables,
  findOpmRoot,
  importNativeProject,
  initProject,
  installProject,
  listGenerations,
  listInstalled,
  buildPackageManifest,
  hostSandboxFromPolicy,
  installSystemPackage,
  listRegistryVersions,
  packProject,
  readLockfile,
  readManifestFile,
  listSystemInstallers,
  parsePackageSpec,
  stripPurlVersion,
  planSystemInstall,
  projectPaths,
  projectStep,
  readEnvironmentState,
  removePackage,
  registryEcosystems,
  requireAdapterRegistry,
  requireOpmRoot,
  resolveGraph,
  resolveRegistryArtifact,
  solveGraph,
  searchRegistry,
  syncProject,
  uninstallProject,
  updateProject,
  whyPackage,
  type AdapterModule,
  type AdapterRegistry,
} from '@openpacker/opm-project';
import { asksForHelp } from './commands/run-args.js';
import { cliStep, runRecoverCommand } from './commands/recover.js';
import { COMMANDS } from './commands/command-names.js';
import { routeRun, unknownCommandHint } from './commands/run-route.js';
import { RunError } from './commands/run-error.js';
import { helpText } from './commands/help-text.js';
import { EXIT_CODES, opmErrorExit, providerErrorExit } from './exit-codes.js';
import { formatFailure, parseFailure, report } from './error-report.js';
import { importHeading, importLine, listLine } from './stdout-lines.js';

export { EXIT_CODES } from './exit-codes.js';

export interface CliIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

interface Parsed {
  command: string;
  positionals: string[];
  options: Map<string, string | true>;
  optionValues: Map<string, string[]>;
  /** Raw tokens before the command name. */
  head: string[];
  /** Raw tokens after the command name, `--` and all (`run` and `exec`). */
  rest: string[];
}

/** Reported as the producer of any manifest opm writes. */
const OPM_VERSION = '0.1.0';

/** Seams a caller of {@link runOpm} may replace; the process entry passes none. */
export interface RunOpmOptions {
  /** Network used by `plugin add`; production resolves and pins real addresses. */
  fetch?: typeof fetch;
  /** Adapters registered beside the bundled ones, as a bound plugin is. */
  adapters?: readonly AdapterModule[];
}

export async function runOpm(
  argv = process.argv.slice(2),
  io: CliIo = process,
  cwd = process.cwd(),
  options: RunOpmOptions = {},
): Promise<number> {
  // pnpm and npm put workspace options before the command, and a script's name
  // where a command goes (ADR 0053); say which `run` or `exec` that means first.
  try {
    const routed = await routeRun(argv, cwd);
    if (routed !== undefined) {
      const { runProjectCommand } = await import('./commands/run.js');
      return await runProjectCommand(
        routed.command,
        [],
        routed.rest,
        io,
        cwd,
        undefined,
        routed.fallbackExec,
      );
    }
  } catch (error) {
    return handleError(error, io);
  }
  const args = parseArgs(argv);
  // `run` and `exec` start the person's own code and read no registry, so they
  // load no adapter or plugin (ADR 0047): a broken plugin store cannot print
  // into a script's stderr, and a script that calls opm 80 times pays no startup.
  if (
    (args.command === 'run' || args.command === 'exec') &&
    !asksForHelp(args.command, args.rest)
  ) {
    try {
      const { runProjectCommand } = await import('./commands/run.js');
      return await runProjectCommand(
        args.command,
        args.head,
        args.rest,
        io,
        cwd,
      );
    } catch (error) {
      return handleError(error, io);
    }
  }
  try {
    // Process entry registers adapters; core never imports ecosystems by name.
    const adapterRegistry = configureDefaultAdapters(options.adapters);
    // Delegated adapter plugins (ADR 0039) register after the first-party
    // set: a plugin never displaces a bundled adapter (conflicts are
    // refused), and a tampered or broken plugin is reported and skipped —
    // it fails closed, it never takes the CLI down with it.
    try {
      const pluginRegistration = await registerInstalledPlugins({
        registry: adapterRegistry,
      });
      for (const refused of pluginRegistration.refused)
        io.stderr.write(
          report(
            'opm: ',
            `plugin ${refused.name} was not loaded: ${refused.message}`,
          ),
        );
    } catch (error) {
      // A store-level failure (corrupt index, unsafe root) leaves every
      // plugin unregistered; their purl types stay unsupported, which is
      // the fail-closed answer, and `opm plugin` can still repair the store.
      io.stderr.write(
        report(
          'opm: ',
          `plugin store unavailable (${error instanceof Error ? error.message : String(error)}); continuing without plugins`,
        ),
      );
    }
    const { applyAuthConfigForProcess } = await import('./commands/auth.js');
    await applyAuthConfigForProcess();
    if (
      args.command === 'help' ||
      args.options.has('help') ||
      args.command === ''
    ) {
      out(io, helpText());
      return EXIT_CODES.success;
    }
    if (!COMMANDS.has(args.command)) {
      const hint = unknownCommandHint(args.command);
      throw usage(
        `Unknown command: ${args.command}${hint === undefined ? '' : `. ${hint}`}`,
      );
    }

    const step = cliStep(io, args.options);
    // A command's work on its project is one step (`project-step.ts`): bound
    // plugins are verified once what a killed step left is put back, and the
    // library calls inside it neither lock nor recover again.
    const inStep = <T>(root: string, work: () => Promise<T>) =>
      projectStep(root, step, async () => {
        await registerBoundPlugins(root, adapterRegistry);
        return work();
      });
    switch (args.command) {
      case 'init': {
        const root = option(args, 'path') ?? cwd;
        const name = option(args, 'name');
        const result = await initProject({
          root,
          ...(name !== undefined && { name }),
          force: args.options.has('force'),
          step,
        });
        out(
          io,
          result.created
            ? `Initialized opm project at ${result.manifestPath}\n`
            : `opm project already exists at ${result.manifestPath}\n`,
        );
        out(io, `Next: opm add <pkg> --ecosystem npm && opm install\n`);
        return EXIT_CODES.success;
      }
      case 'import': {
        if (!args.options.has('native'))
          throw usage('opm import requires --native');
        const root = option(args, 'path') ?? cwd;
        const result = await importNativeProject({
          root,
          force: args.options.has('force'),
          step,
        });
        out(io, importHeading(result.imported.length, result.manifestPath));
        for (const item of result.imported) out(io, importLine(item));
        out(
          io,
          'opm.toml is authoritative; later sync does not re-read native manifests.\n',
        );
        return EXIT_CODES.success;
      }
      case 'add': {
        const spec = args.positionals[0];
        if (!spec) throw usage('opm add requires a package spec');
        const ecosystemOpt = option(args, 'ecosystem') ?? option(args, 'e');
        const source = option(args, 'source');
        const alias = option(args, 'alias');
        // Host/profile install is capability-driven and does not need a project.
        if (!source) {
          const parsed = parsePackageSpec(spec, {
            ...(ecosystemOpt !== undefined && { ecosystem: ecosystemOpt }),
          });
          const ecosystem = parsed.ecosystem ?? ecosystemFromPurl(parsed.purl);
          if (await requireAdapterRegistry().prefersHostInstall(ecosystem)) {
            const exact = parsed.purl.startsWith('pkg:')
              ? parsed.version !== undefined
                ? `${parsed.purl.split('@')[0]}@${parsed.version}`
                : parsed.purl.includes('@')
                  ? parsed.purl
                  : parsed.version
                    ? `${parsed.purl}@${parsed.version}`
                    : parsed.purl
              : `pkg:${ecosystem}/${parsed.alias}${parsed.version ? `@${parsed.version}` : ''}`;
            // await keeps a rejection inside runOpm's handler.
            return await runHostInstall(exact, args, io, cwd);
          }
        }
        const root = (await findOpmRoot(cwd)) ?? (await requireOpmRoot(cwd));
        const offline = offlineOverride(args);
        // A project that binds plugins resolves through them; the binding is
        // verified before any registry read it could influence.
        const result = await inStep(root, () =>
          addPackage({
            allowElevation: args.options.has('allow-elevation'),
            dryRun: args.options.has('dry-run'),
            root,
            spec,
            ...(ecosystemOpt !== undefined && { ecosystem: ecosystemOpt }),
            ...(source !== undefined && { source }),
            ...(alias !== undefined && { alias }),
            ...(!(offline === undefined) && { offline }),
          }),
        );
        if (result.hostInstall) {
          return writeHostInstallResult(result.hostInstall, args, io);
        }
        const installName = result.lock.packages[result.alias]?.installName;
        out(
          io,
          `Added ${result.alias} → ${result.lock.packages[result.alias]?.purl ?? result.alias}` +
            (installName === undefined
              ? ''
              : ` (installed as ${installName})`) +
            '\n',
        );
        writeNativeProjection(result.native, io);
        out(io, `Installed into ${projectPaths(root).store}\n`);
        return EXIT_CODES.success;
      }
      case 'remove': {
        const root = await requireOpmRoot(cwd);
        const alias = args.positionals[0];
        if (!alias) throw usage('opm remove requires a package alias');
        const offline = offlineOverride(args);
        // remove rewrites the manifest and lock; bound plugins are verified first.
        const removed = await inStep(root, () =>
          removePackage({
            root,
            alias,
            ...(!(offline === undefined) && { offline }),
          }),
        );
        out(io, `Removed ${removed.alias} from manifest, lock, and install\n`);
        return EXIT_CODES.success;
      }
      case 'ci': {
        const { runCiCommand } = await import('./commands/ci.js');
        return await runCiCommand(args, io, cwd, { ...options, step });
      }
      case 'install': {
        // `--frozen` is `opm ci`: install exactly what the lock says.
        if (args.options.has('frozen')) {
          const { runCiCommand } = await import('./commands/ci.js');
          return await runCiCommand(args, io, cwd, { ...options, step });
        }
        const root = await requireOpmRoot(cwd);
        const offline = offlineOverride(args);
        const result = await inStep(root, () =>
          installProject({
            root,
            ...(!(offline === undefined) && { offline }),
          }),
        );
        const count = Object.keys(result.state.packages).length;
        out(
          io,
          `Installed ${count} package(s) into ${projectPaths(root).opmDir}\n`,
        );
        writeNativeProjection(result.native, io);
        out(
          io,
          `Bins: ${projectPaths(root).bin}  (export PATH="$PWD/.opm/bin:$PATH")\n`,
        );
        return EXIT_CODES.success;
      }
      case 'uninstall': {
        const root = await requireOpmRoot(cwd);
        const alias = args.positionals[0];
        await inStep(root, () =>
          uninstallProject({ root, ...(alias !== undefined && { alias }) }),
        );
        out(
          io,
          alias
            ? `Uninstalled ${alias} (left in manifest/lock unless you opm remove)\n`
            : `Uninstalled all project packages from .opm/\n`,
        );
        return EXIT_CODES.success;
      }
      case 'sync': {
        const root = await requireOpmRoot(cwd);
        const offline = offlineOverride(args);
        const result = await inStep(root, () =>
          syncProject({ root, ...(!(offline === undefined) && { offline }) }),
        );
        const count = Object.keys(result.lock.packages).length;
        out(io, `Synced ${count} package(s); lock and .opm/ store updated\n`);
        writeNativeProjection(result.native, io);
        return EXIT_CODES.success;
      }
      case 'update': {
        const root = await requireOpmRoot(cwd);
        const offline = offlineOverride(args);
        const result = await inStep(root, () =>
          updateProject({
            root,
            ...(args.positionals.length > 0 && { aliases: args.positionals }),
            latest: args.options.has('latest'),
            ...(!(offline === undefined) && { offline }),
          }),
        );
        out(
          io,
          result.updated.length === 0
            ? 'Already up to date\n'
            : `Updated ${result.updated.length} package(s): ${result.updated.join(', ')}\n`,
        );
        writeNativeProjection(result.native, io);
        return EXIT_CODES.success;
      }
      case 'publish': {
        const { runPublishCommand } = await import('./commands/publish.js');
        return await runPublishCommand(args, io, cwd);
      }
      case 'yank': {
        const { runYankCommand } = await import('./commands/yank.js');
        return await runYankCommand(args, io, cwd);
      }
      case 'packslip': {
        const { runPackslipCommand } = await import('./commands/packslip.js');
        return await runPackslipCommand(args, io, cwd);
      }
      case 'list': {
        const root = await requireOpmRoot(cwd);
        const rows = await listInstalled(root);
        if (rows.length === 0) {
          out(io, '(no packages)\n');
          return EXIT_CODES.success;
        }
        for (const row of rows) out(io, listLine(row));
        return EXIT_CODES.success;
      }
      case 'why': {
        const root = await requireOpmRoot(cwd);
        const alias = args.positionals[0];
        if (!alias) throw usage('opm why requires a package alias');
        out(io, `${await whyPackage(root, alias)}\n`);
        return EXIT_CODES.success;
      }
      // Browsing does not need a project: looking up what a registry has is
      // useful before you have decided to depend on it.
      case 'search': {
        const query = args.positionals[0];
        if (!query) throw usage('opm search requires a query or PURL');
        const ecosystem = registryEcosystem(args, query);
        const found = await searchRegistry(ecosystem, query, {
          offline: args.options.has('offline'),
        });
        if (found.length === 0) {
          out(io, '(no matches)\n');
          return EXIT_CODES.success;
        }
        for (const item of found) out(io, `${plainLine(item.canonicalPurl)}\n`);
        return EXIT_CODES.success;
      }
      case 'versions': {
        const target = args.positionals[0];
        if (!target) throw usage('opm versions requires a package or PURL');
        const ecosystem = registryEcosystem(args, target);
        // The registry is asked about the package, whatever version was typed.
        const versions = await listRegistryVersions(
          ecosystem,
          stripPurlVersion(browseTarget(target)),
          { offline: args.options.has('offline') },
        );
        if (versions.length === 0) {
          out(io, '(no published versions)\n');
          return EXIT_CODES.success;
        }
        // Newest last, the order the registry reports. Prereleases are listed;
        // `opm add` with no version takes `latest` (`default-release.ts`).
        for (const version of versions) out(io, `${plainLine(version)}\n`);
        return EXIT_CODES.success;
      }
      case 'resolve': {
        const target = browseTarget(args.positionals[0] ?? '');
        if (!target) throw usage('opm resolve requires a package or PURL');
        // resolve works without a project, but inside one its bindings are
        // part of the resolution authority and are verified first.
        const projectRoot = await findOpmRoot(cwd);
        if (projectRoot !== undefined)
          await registerBoundPlugins(projectRoot, adapterRegistry);
        const range = option(args, 'range');
        const graph = await resolveGraph({
          roots: [{ purl: target, ...(!(range === undefined) && { range }) }],
          ...(!(option(args, 'candidates') === undefined) && {
            bounds: {
              candidatesPerPackage: Number(option(args, 'candidates')),
            },
          }),
        });
        if (graph.truncated.length > 0)
          io.stderr.write(
            `opm: candidate sets were bounded for ${graph.truncated.length} package(s); ` +
              `a solve over a truncated universe can report unsatisfiable for a solvable problem\n`,
          );
        for (const item of graph.unresolved)
          io.stderr.write(
            report(
              'opm: ',
              `${plainLine(item.purl)}: ${plainLine(item.reason)}`,
            ),
          );
        const solved = await solveGraph({
          graph,
          rootRequirements: [{ purl: target }],
        });
        out(
          io,
          `${solved.selected.length} package(s), proof ${solved.proofValid ? 'checked' : 'INVALID'}\n`,
        );
        for (const instance of solved.selected)
          out(io, `  ${instance.identity.exactPurl}\n`);
        return EXIT_CODES.success;
      }
      case 'info': {
        const target = args.positionals[0];
        if (!target) throw usage('opm info requires an exact PURL');
        const ecosystem = registryEcosystem(args, target);
        const artifact = await resolveRegistryArtifact(ecosystem, target, {
          offline: args.options.has('offline'),
        });
        out(
          io,
          `${plainLine(artifact.exactPurl)}\n` +
            `  version   ${plainLine(artifact.version)}\n` +
            `  digest    ${plainLine(artifact.digest)}\n` +
            `  size      ${artifact.size} bytes\n` +
            `  mediaType ${plainLine(artifact.mediaType)}\n` +
            `  source    ${plainLine(artifact.uri)}\n`,
        );
        return EXIT_CODES.success;
      }
      // Host installers change the machine through a native tool. They are
      // deliberately not the project store path: apt/nix/winget run vendor
      // scripts and are not covered by generation rollback.
      case 'manifest': {
        const root = await requireOpmRoot(cwd);
        const paths = projectPaths(root);
        const projectManifest = await readManifestFile(paths.manifest);
        const lock = (await readLockfile(paths.lock)) ?? {
          schemaVersion: 1 as const,
          generatedBy: 'opm' as const,
          packages: {},
        };
        const built = await buildPackageManifest({
          root,
          manifest: projectManifest,
          lock,
          producedAt: new Date().toISOString(),
          producer: { id: 'org.openpacker.opm', version: OPM_VERSION },
          ...(!(option(args, 'name') === undefined) && {
            name: option(args, 'name')!,
          }),
          ...(!(option(args, 'package-version') === undefined) && {
            version: option(args, 'package-version')!,
          }),
        });
        const destination = option(args, 'output');
        if (destination) {
          await writeFile(destination, built.bytes);
          out(io, `${destination}\n`);
          out(
            io,
            `  sha256:${built.digest.value}  ${built.bytes.byteLength} bytes\n`,
          );
        } else {
          outJson(io, new TextDecoder().decode(built.bytes));
        }
        for (const loss of built.manifest.semanticLoss ?? [])
          io.stderr.write(
            report(
              'opm: ',
              `${plainLine(loss.code)}: ${plainLine(loss.omittedMeaning ?? '')}`,
            ),
          );
        return EXIT_CODES.success;
      }
      case 'pack': {
        const root = await requireOpmRoot(cwd);
        const projectManifest = await readManifestFile(
          projectPaths(root).manifest,
        );
        const ecosystem =
          option(args, 'ecosystem') ?? option(args, 'e') ?? args.positionals[0];
        if (!ecosystem)
          throw usage(
            'opm pack requires an ecosystem: opm pack npm | opm pack nuget',
          );
        const packageVersion = option(args, 'package-version');
        if (!packageVersion)
          throw usage(
            'opm pack requires --package-version; target versions are never guessed',
          );
        const output = option(args, 'output');
        const providerRequested = args.options.has('provider');
        const provider = option(args, 'provider');
        if (providerRequested && (!provider || provider.trim() === ''))
          throw usage('opm pack --provider requires a provider id');
        const strategy =
          args.options.has('delegate') || providerRequested
            ? 'delegate'
            : 'standard';
        const configured =
          strategy === 'delegate'
            ? await configurePackProviders({
                root,
                manifest: projectManifest,
                environment: explicitlyGrantedEnvironment(args),
              })
            : undefined;
        const result = await packProject({
          root,
          ecosystem,
          strategy,
          name: option(args, 'name') ?? projectManifest.project.name,
          version: packageVersion,
          ...(!(output === undefined) && { outputDirectory: output }),
          ...(!(provider === undefined) && { provider }),
          ...(!(configured === undefined) && {
            authorizedEnvironment: configured.authorizedEnvironment,
          }),
          allowBuild: args.options.has('allow-build'),
          allowNetwork: args.options.has('allow-network'),
          offline: offlineOverride(args) ?? projectManifest.options.offline,
          dryRun: args.options.has('dry-run'),
          nativeMetadata: {
            ...(!(option(args, 'os') === undefined) && {
              'dev.openpacker.oci.os': option(args, 'os')!,
            }),
            ...(!(option(args, 'arch') === undefined) && {
              'dev.openpacker.oci.architecture': option(args, 'arch')!,
            }),
          },
        });
        if (!result.performed) {
          const commands =
            result.commands ?? (result.command ? [result.command] : []);
          if (commands.length === 0) out(io, `standard ${ecosystem}\n`);
          for (const command of commands) out(io, `${command.join(' ')}\n`);
          for (const command of result.cleanupCommands ?? [])
            out(io, `cleanup: ${command.join(' ')}\n`);
          return EXIT_CODES.success;
        }
        if (result.exitCode !== 0)
          throw new OpmError(
            'PACK_FAILED',
            result.stderr || `Pack exited ${result.exitCode}`,
          );
        for (const artifact of result.artifacts) {
          out(io, `${artifact.path}\n`);
          out(
            io,
            `  ${artifact.digest}  ${artifact.size} bytes  ${artifact.nativeRole}\n`,
          );
        }
        for (const loss of result.semanticLoss)
          io.stderr.write(
            report(
              'opm: ',
              `${plainLine(loss.code)}: ${plainLine(loss.omittedMeaning ?? '')}`,
            ),
          );
        return EXIT_CODES.success;
      }
      case 'system': {
        // await keeps subcommand errors inside runOpm's handler.
        return await runSystemCommand(args, io, cwd);
      }
      case 'plugin': {
        // await keeps subcommand errors inside runOpm's handler.
        return await runPluginCommand(args, io, options);
      }
      case 'auth': {
        const { runAuthCommand } = await import('./commands/auth.js');
        return await runAuthCommand(args, io);
      }
      case 'recover':
        return await runRecoverCommand(args, io, cwd, step);
      case 'generations': {
        const root = await requireOpmRoot(cwd);
        const state = await readEnvironmentState(root);
        const generations = await listGenerations(root);
        if (generations.length === 0) {
          out(io, 'No generations yet. Run: opm install\n');
          return EXIT_CODES.success;
        }
        for (const generation of generations) {
          const current =
            generation.generationDigest === state?.currentGenerationDigest;
          out(
            io,
            `${current ? '*' : ' '} ${generation.sequence}\t${generation.createdAt}\t${generation.members.length} package(s)\n`,
          );
        }
        return EXIT_CODES.success;
      }
      case 'rollback': {
        const { runRollbackCommand } = await import(
          './commands/generations.js'
        );
        return await runRollbackCommand(
          args,
          io,
          await requireOpmRoot(cwd),
          step,
        );
      }
      case 'gc': {
        const { runGcCommand, runSharedGcCommand } = await import(
          './commands/generations.js'
        );
        // The shared store belongs to the user, not to a project, so this
        // needs no project and never runs as part of a project's own gc.
        if (args.options.has('shared'))
          return await runSharedGcCommand(args, io);
        return await runGcCommand(args, io, await requireOpmRoot(cwd), step);
      }
      case 'shell': {
        const root = await requireOpmRoot(cwd);
        if (args.options.has('json')) {
          const environment = await environmentVariables({ root });
          outJson(io, JSON.stringify(environment, null, 2));
          return EXIT_CODES.success;
        }
        // Printing assignments keeps this composable: `eval "$(opm shell)"`
        // works without opm needing to spawn or manage a shell.
        out(io, await environmentScript({ root }));
        return EXIT_CODES.success;
      }
      default:
        throw usage(`Unhandled command ${args.command}`);
    }
  } catch (error) {
    return handleError(error, io);
  }
}

/** Report a failure and choose the exit code that tells a script what kind it was. */
export function handleError(error: unknown, io: CliIo): number {
  if (error instanceof UsageError) {
    io.stderr.write(report('', error.message));
    io.stderr.write(`\n${helpText()}\n`);
    return EXIT_CODES.usage;
  }
  if (error instanceof RunError) {
    io.stderr.write(report('opm: ', error.message));
    switch (error.code) {
      case 'USAGE':
        return EXIT_CODES.usage;
      case 'NOT_FOUND':
        return EXIT_CODES.notFound;
      case 'INVALID_MANIFEST':
      case 'UNSAFE_PATH':
        return EXIT_CODES.invalidInput;
      case 'UNAVAILABLE':
        return EXIT_CODES.unavailable;
    }
  }
  if (error instanceof OpmError) {
    io.stderr.write(report('opm: ', error.message));
    return opmErrorExit(error.code);
  }
  // Delegated plugin operations surface ProviderError, which is not an
  // OpmError but carries the same string codes; map them instead of reporting
  // a generic internal error.
  if (error instanceof Error && 'code' in error) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') {
      io.stderr.write(report('opm: ', error.message));
      return providerErrorExit(code);
    }
  }
  io.stderr.write(
    formatFailure(parseFailure(error), { tool: 'opm', internalError: true }),
  );
  return EXIT_CODES.internal;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function usage(message: string): UsageError {
  return new UsageError(message);
}

function parseArgs(argv: string[]): Parsed {
  const options = new Map<string, string | true>();
  const optionValues = new Map<string, string[]>();
  const positionals: string[] = [];
  const setOption = (key: string, value: string | true) => {
    options.set(key, value);
    if (typeof value === 'string')
      optionValues.set(key, [...(optionValues.get(key) ?? []), value]);
  };
  let command = '';
  let commandIndex = -1;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        setOption(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (
          next !== undefined &&
          !next.startsWith('-') &&
          !isBooleanFlag(key)
        ) {
          setOption(key, next);
          i += 1;
        } else {
          setOption(key, true);
        }
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      const long = shortToLong(key);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-') && !isBooleanFlag(long)) {
        setOption(long, next);
        i += 1;
      } else {
        setOption(long, true);
      }
      continue;
    }
    if (command === '') {
      command = arg;
      commandIndex = i;
    } else positionals.push(arg);
  }
  return {
    command,
    positionals,
    options,
    optionValues,
    head: commandIndex === -1 ? [...argv] : argv.slice(0, commandIndex),
    rest: commandIndex === -1 ? [] : argv.slice(commandIndex + 1),
  };
}

function shortToLong(short: string): string {
  switch (short) {
    case 'e':
      return 'ecosystem';
    case 'h':
      return 'help';
    case 'w':
      return 'workspace';
    default:
      return short;
  }
}

function isBooleanFlag(key: string): boolean {
  return (
    key === 'help' ||
    key === 'force' ||
    key === 'offline' ||
    key === 'online' ||
    key === 'json' ||
    key === 'dry-run' ||
    key === 'delegate' ||
    key === 'allow-build' ||
    key === 'allow-network' ||
    key === 'allow-elevation' ||
    key === 'latest' ||
    key === 'if-present' ||
    key === 'native' ||
    key === 'shared' ||
    key === 'production' ||
    key === 'frozen' ||
    key === 'workspaces' ||
    key === 'no-workspaces' ||
    key === 'include-workspace-root' ||
    key === 'write'
  );
}

/**
 * Delegated adapter plugin management (ADR 0039). Plugins live in the
 * user-level store (`OPM_PLUGIN_HOME` / XDG), never in a project.
 *
 * Subcommands: add | remove | list
 */
async function runPluginCommand(
  args: Parsed,
  io: CliIo,
  options: RunOpmOptions,
): Promise<number> {
  const sub = args.positionals[0];
  if (sub === 'add') {
    const spec = args.positionals[1];
    if (!spec) throw usage('opm plugin add requires a plugin name');
    const { name, version } = parsePluginSpec(spec);
    const offline = offlineOverride(args);
    const installed = await addPlugin({
      name,
      ...(!(version === undefined) && { version }),
      ...(!(offline === undefined) && { offline }),
      ...(!(options.fetch === undefined) && { fetch: options.fetch }),
    });
    out(
      io,
      installed.alreadyInstalled
        ? `Plugin ${installed.name} is already installed at ${installed.exactPurl}\n`
        : `Installed plugin ${installed.exactPurl}\n`,
    );
    out(
      io,
      `  id:     ${installed.id}\n` +
        `  digest: ${installed.storeDigest}\n` +
        `  store:  ${installed.storePath}\n`,
    );
    return EXIT_CODES.success;
  }
  if (sub === 'remove') {
    const name = args.positionals[1];
    if (!name) throw usage('opm plugin remove requires a plugin name');
    const removed = await removePlugin(name);
    out(io, `Removed plugin ${removed.name} (${removed.exactPurl})\n`);
    return EXIT_CODES.success;
  }
  if (sub === 'list') {
    const plugins = await listPlugins();
    if (plugins.length === 0) {
      out(io, '(no plugins installed)\n');
      return EXIT_CODES.success;
    }
    for (const plugin of plugins) {
      const missing = plugin.present ? '' : '  (store entry missing)';
      out(
        io,
        `${plugin.name}\t${plugin.exactPurl}\t${plugin.storeDigest}\t${plugin.installedAt}${missing}\n`,
      );
    }
    return EXIT_CODES.success;
  }
  throw usage(
    `Unknown plugin subcommand: ${sub ?? '(none)'}. Use add | remove | list.`,
  );
}

/**
 * Compat alias for capability-driven host install. Prefer `opm add pkg:…`.
 *
 * Subcommands: available | plan | install
 */
async function runSystemCommand(
  args: Parsed,
  io: CliIo,
  cwd: string,
): Promise<number> {
  const sub = args.positionals[0] ?? 'available';
  if (sub === 'available' || sub === 'list') {
    const installers = await listSystemInstallers();
    for (const entry of installers) {
      const status = entry.availability.available
        ? `available${entry.availability.tool?.version ? ` (${entry.availability.tool.name} ${entry.availability.tool.version})` : ''}`
        : `unavailable: ${entry.availability.reason ?? 'unknown'}`;
      out(
        io,
        `${plainLine(`${entry.id}  ${entry.purlTypes.join(',')}  ${status}`)}\n`,
      );
    }
    return EXIT_CODES.success;
  }
  if (sub === 'plan' || sub === 'install') {
    const purl = args.positionals[1];
    if (!purl) throw usage(`opm system ${sub} requires a PURL`);
    if (sub === 'plan') args.options.set('dry-run', true);
    return await runHostInstall(purl, args, io, cwd);
  }
  throw usage(
    `Unknown system subcommand: ${sub}. Use available | plan | install.`,
  );
}

/**
 * Report the ecosystem project files opm maintained, and anything it could not
 * promise about them. Silence here would hide edits to files the user tracks
 * in version control.
 */
function writeNativeProjection(
  native:
    | {
        projections: readonly {
          ecosystem: string;
          written: readonly string[];
          skipped?: readonly { path: string; reason: string }[];
          semanticLoss: readonly {
            code: string;
            representedMeaning?: string;
          }[];
        }[];
      }
    | undefined,
  io: CliIo,
): void {
  if (!native) return;
  for (const projection of native.projections) {
    for (const path of projection.written) out(io, `  updated ${path}\n`);
    for (const entry of projection.skipped ?? [])
      io.stderr.write(
        report(
          'opm: ',
          `skipped ${plainLine(entry.path)}: ${plainLine(entry.reason)}`,
        ),
      );
    for (const loss of projection.semanticLoss)
      io.stderr.write(
        report(
          'opm: ',
          `${plainLine(loss.code)}${loss.representedMeaning ? `: ${plainLine(loss.representedMeaning)}` : ''}`,
        ),
      );
  }
}

async function runHostInstall(
  purl: string,
  args: Parsed,
  io: CliIo,
  cwd = process.cwd(),
): Promise<number> {
  let sandbox = hostSandboxFromPolicy();
  let committedOffline = false;
  const root = await findOpmRoot(cwd);
  if (root) {
    try {
      const manifest = await readManifestFile(projectPaths(root).manifest);
      sandbox = hostSandboxFromPolicy(manifest.policy);
      committedOffline = manifest.options.offline;
    } catch {
      sandbox = hostSandboxFromPolicy();
    }
  }
  const offline = offlineOverride(args) ?? committedOffline;
  const options = {
    offline,
    dryRun: args.options.has('dry-run'),
    allowElevation: args.options.has('allow-elevation'),
    sandbox,
  };
  if (options.dryRun) {
    const plan = await planSystemInstall(purl, options);
    return writeHostInstallResult({ plan }, args, io);
  }
  const outcome = await installSystemPackage(purl, options);
  return writeHostInstallResult({ plan: outcome, outcome }, args, io);
}

function writeHostInstallResult(
  result: {
    plan: Awaited<ReturnType<typeof planSystemInstall>>;
    outcome?: Awaited<ReturnType<typeof installSystemPackage>>;
  },
  args: Parsed,
  io: CliIo,
): number {
  const { plan, outcome } = result;
  out(io, `${plainLine(plan.command.join(' '))}\n`);
  for (const loss of plan.semanticLoss)
    io.stderr.write(
      report(
        'opm: ',
        `${plainLine(loss.code)}: ${plainLine(String(loss.representedMeaning))}`,
      ),
    );
  if (plan.requiresElevation && !args.options.has('allow-elevation'))
    io.stderr.write(
      'opm: host install needs elevation; pass --allow-elevation to consent\n',
    );
  if (!outcome) return EXIT_CODES.success;
  if (outcome.stdout) outRaw(io, outcome.stdout);
  if (outcome.stderr) io.stderr.write(outcome.stderr);
  if (outcome.exitCode !== 0) {
    io.stderr.write(`opm: host install exited ${outcome.exitCode}\n`);
    return EXIT_CODES.internal;
  }
  out(
    io,
    `Host-installed ${plainLine(outcome.exactPurl)}${outcome.installedVersion ? ` @ ${plainLine(outcome.installedVersion)}` : ''}\n`,
  );
  return EXIT_CODES.success;
}

function option(args: Parsed, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

function offlineOverride(args: Parsed): boolean | undefined {
  const offline = args.options.has('offline');
  const online = args.options.has('online');
  if (offline && online) throw usage('Pass only one of --offline or --online');
  return offline ? true : online ? false : undefined;
}

/**
 * Verify and register the project's `[plugins.<id>]` bindings (ADR 0039)
 * before a project operation resolves anything.
 *
 * A binding is a pin, never an acquisition: an uninstalled plugin or a store
 * digest that differs from the bound one fails closed
 * (PLUGIN_NOT_INSTALLED / PLUGIN_DIGEST_MISMATCH).
 */
async function registerBoundPlugins(
  root: string,
  registry: AdapterRegistry,
): Promise<void> {
  const manifest = await readManifestFile(projectPaths(root).manifest);
  if (
    manifest.plugins === undefined ||
    Object.keys(manifest.plugins).length === 0
  )
    return;
  await verifyPluginBindings(manifest.plugins, { registry });
}

function explicitlyGrantedEnvironment(args: Parsed) {
  const names = args.optionValues.get('allow-env') ?? [];
  if (args.options.has('allow-env') && names.length === 0)
    throw usage('opm pack --allow-env requires an environment variable name');
  const environment: Record<string, string> = {};
  for (const name of names) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
      throw usage(`Invalid --allow-env name: ${name}`);
    const value = process.env[name];
    if (value === undefined)
      throw usage(`Environment variable ${name} is not set`);
    environment[name] = value;
  }
  return environment;
}

/**
 * Which registry a browse command should read.
 *
 * A PURL names its own ecosystem, so `opm versions pkg:cargo/serde` needs no
 * flag. A bare name is ambiguous across registries and stays fail-closed, the
 * same way `opm add lodash` does — guessing npm because it is popular is how
 * you install the wrong package.
 */
/**
 * `packslip:jdx/hk` is shorthand for a PURL, and the browse commands speak
 * PURLs: the registry must be asked about `pkg:packslip/github.com/jdx/hk`.
 */
export function browseTarget(target: string): string {
  return target.startsWith('packslip:')
    ? parsePackageSpec(target, { ecosystem: 'packslip' }).purl
    : target;
}

function registryEcosystem(args: Parsed, target: string): string {
  const explicit = option(args, 'ecosystem') ?? option(args, 'e');
  if (explicit) return explicit;
  if (target.startsWith('pkg:')) {
    const type = target.slice(4).split('/')[0]?.toLowerCase();
    if (type) return type;
  }
  if (target.startsWith('packslip:')) return 'packslip';
  const ecosystems = registryEcosystems().join('|') || 'npm|cargo|…';
  throw usage(
    `Cannot tell which registry "${target}" belongs to. ` +
      `Pass a PURL (pkg:npm/${target}) or --ecosystem <${ecosystems}>.`,
  );
}

/**
 * `runOpm` as the process entry runs it: packages are kept once per machine
 * (OPM_STORE_HOME=off opts out, an absolute path relocates it) and projects
 * link to them. `main.ts` calls this for every command it does not answer
 * itself.
 */
export async function runOpmFromProcess(): Promise<number> {
  enableDefaultSharedStore();
  return await runOpm();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runOpmFromProcess();
}

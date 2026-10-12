#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import { plainLine } from '@openpacker/canonical';
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
  collectGarbage,
  collectSharedStore,
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
  readEnvironmentState,
  removePackage,
  registryEcosystems,
  requireAdapterRegistry,
  requireOpmRoot,
  resolveGraph,
  resolveRegistryArtifact,
  solveGraph,
  rollbackTarget,
  searchRegistry,
  switchGeneration,
  syncProject,
  uninstallProject,
  updateProject,
  whyPackage,
  type AdapterRegistry,
  type Generation,
} from '@openpacker/opm-project';
import { asksForHelp } from './commands/run-args.js';
import { RunError } from './commands/run-error.js';
import { RUN_HELP } from './commands/run-help.js';
import { formatFailure, parseFailure, report } from './error-report.js';
import { importHeading, importLine, listLine } from './stdout-lines.js';

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
  optionValues: Map<string, string[]>;
  /** Raw tokens before the command name. */
  head: string[];
  /** Raw tokens after the command name, `--` and all (`run` and `exec`). */
  rest: string[];
}

/** Reported as the producer of any manifest opm writes. */
const OPM_VERSION = '0.1.0';

const COMMANDS = new Set([
  'init',
  'import',
  'add',
  'remove',
  'install',
  'ci',
  'uninstall',
  'sync',
  'update',
  'run',
  'exec',
  'list',
  'why',
  'search',
  'versions',
  'info',
  'resolve',
  'manifest',
  'pack',
  'publish',
  'yank',
  'packslip',
  'plugin',
  'auth',
  'system',
  'generations',
  'rollback',
  'gc',
  'shell',
  'help',
]);

/** Seams a caller of {@link runOpm} may replace; the process entry passes none. */
export interface RunOpmOptions {
  /** Network used by `plugin add`; production resolves and pins real addresses. */
  fetch?: typeof fetch;
}

export async function runOpm(
  argv = process.argv.slice(2),
  io: CliIo = process,
  cwd = process.cwd(),
  options: RunOpmOptions = {},
): Promise<number> {
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
    const adapterRegistry = configureDefaultAdapters();
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
          ...(name !== undefined && { name }),
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
      case 'import': {
        if (!args.options.has('native'))
          throw usage('opm import requires --native');
        const root = option(args, 'path') ?? cwd;
        const result = await importNativeProject({
          root,
          force: args.options.has('force'),
        });
        io.stdout.write(
          importHeading(result.imported.length, result.manifestPath),
        );
        for (const item of result.imported) io.stdout.write(importLine(item));
        io.stdout.write(
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
        // A project that binds plugins resolves through them; verify the
        // binding before any registry read it could influence.
        await registerBoundPlugins(root, adapterRegistry);
        const result = await addPackage({
          allowElevation: args.options.has('allow-elevation'),
          dryRun: args.options.has('dry-run'),
          root,
          spec,
          ...(ecosystemOpt !== undefined && { ecosystem: ecosystemOpt }),
          ...(source !== undefined && { source }),
          ...(alias !== undefined && { alias }),
          ...(!(offline === undefined) && { offline }),
        });
        if (result.hostInstall) {
          return writeHostInstallResult(result.hostInstall, args, io);
        }
        io.stdout.write(
          `Added ${result.alias} → ${result.lock.packages[result.alias]?.purl ?? result.alias}\n`,
        );
        writeNativeProjection(result.native, io);
        io.stdout.write(`Installed into ${projectPaths(root).store}\n`);
        return EXIT_CODES.success;
      }
      case 'remove': {
        const root = await requireOpmRoot(cwd);
        const alias = args.positionals[0];
        if (!alias) throw usage('opm remove requires a package alias');
        const offline = offlineOverride(args);
        // remove rewrites the manifest and lock; verify bound plugins first.
        await registerBoundPlugins(root, adapterRegistry);
        await removePackage({
          root,
          alias,
          ...(!(offline === undefined) && { offline }),
        });
        io.stdout.write(`Removed ${alias} from manifest, lock, and install\n`);
        return EXIT_CODES.success;
      }
      case 'ci': {
        const { runCiCommand } = await import('./commands/ci.js');
        return await runCiCommand(args, io, cwd, options);
      }
      case 'install': {
        // `--frozen` is `opm ci`: install exactly what the lock says.
        if (args.options.has('frozen')) {
          const { runCiCommand } = await import('./commands/ci.js');
          return await runCiCommand(args, io, cwd, options);
        }
        const root = await requireOpmRoot(cwd);
        const offline = offlineOverride(args);
        await registerBoundPlugins(root, adapterRegistry);
        const result = await installProject({
          root,
          ...(!(offline === undefined) && { offline }),
        });
        const count = Object.keys(result.state.packages).length;
        io.stdout.write(
          `Installed ${count} package(s) into ${projectPaths(root).opmDir}\n`,
        );
        writeNativeProjection(result.native, io);
        io.stdout.write(
          `Bins: ${projectPaths(root).bin}  (export PATH="$PWD/.opm/bin:$PATH")\n`,
        );
        return EXIT_CODES.success;
      }
      case 'uninstall': {
        const root = await requireOpmRoot(cwd);
        const alias = args.positionals[0];
        await registerBoundPlugins(root, adapterRegistry);
        await uninstallProject({
          root,
          ...(alias !== undefined && { alias }),
        });
        io.stdout.write(
          alias
            ? `Uninstalled ${alias} (left in manifest/lock unless you opm remove)\n`
            : `Uninstalled all project packages from .opm/\n`,
        );
        return EXIT_CODES.success;
      }
      case 'sync': {
        const root = await requireOpmRoot(cwd);
        const offline = offlineOverride(args);
        await registerBoundPlugins(root, adapterRegistry);
        const result = await syncProject({
          root,
          ...(!(offline === undefined) && { offline }),
        });
        const count = Object.keys(result.lock.packages).length;
        io.stdout.write(
          `Synced ${count} package(s); lock and .opm/ store updated\n`,
        );
        writeNativeProjection(result.native, io);
        return EXIT_CODES.success;
      }
      case 'update': {
        const root = await requireOpmRoot(cwd);
        const offline = offlineOverride(args);
        await registerBoundPlugins(root, adapterRegistry);
        const result = await updateProject({
          root,
          ...(args.positionals.length > 0 && { aliases: args.positionals }),
          latest: args.options.has('latest'),
          ...(!(offline === undefined) && { offline }),
        });
        io.stdout.write(
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
          io.stdout.write('(no packages)\n');
          return EXIT_CODES.success;
        }
        for (const row of rows) io.stdout.write(listLine(row));
        return EXIT_CODES.success;
      }
      case 'why': {
        const root = await requireOpmRoot(cwd);
        const alias = args.positionals[0];
        if (!alias) throw usage('opm why requires a package alias');
        io.stdout.write(`${await whyPackage(root, alias)}\n`);
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
          io.stdout.write('(no matches)\n');
          return EXIT_CODES.success;
        }
        for (const item of found) io.stdout.write(`${item.canonicalPurl}\n`);
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
          io.stdout.write('(no published versions)\n');
          return EXIT_CODES.success;
        }
        // Newest last, matching the order the registry reports and the one
        // `opm add` picks from when no version is given.
        for (const version of versions) io.stdout.write(`${version}\n`);
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
        io.stdout.write(
          `${solved.selected.length} package(s), proof ${solved.proofValid ? 'checked' : 'INVALID'}\n`,
        );
        for (const instance of solved.selected)
          io.stdout.write(`  ${instance.identity.exactPurl}\n`);
        return EXIT_CODES.success;
      }
      case 'info': {
        const target = args.positionals[0];
        if (!target) throw usage('opm info requires an exact PURL');
        const ecosystem = registryEcosystem(args, target);
        const artifact = await resolveRegistryArtifact(ecosystem, target, {
          offline: args.options.has('offline'),
        });
        io.stdout.write(
          `${artifact.exactPurl}\n` +
            `  version   ${artifact.version}\n` +
            `  digest    ${artifact.digest}\n` +
            `  size      ${artifact.size} bytes\n` +
            `  mediaType ${artifact.mediaType}\n` +
            `  source    ${artifact.uri}\n`,
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
          io.stdout.write(`${destination}\n`);
          io.stdout.write(
            `  sha256:${built.digest.value}  ${built.bytes.byteLength} bytes\n`,
          );
        } else {
          io.stdout.write(`${new TextDecoder().decode(built.bytes)}\n`);
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
          if (commands.length === 0) io.stdout.write(`standard ${ecosystem}\n`);
          for (const command of commands)
            io.stdout.write(`${command.join(' ')}\n`);
          for (const command of result.cleanupCommands ?? [])
            io.stdout.write(`cleanup: ${command.join(' ')}\n`);
          return EXIT_CODES.success;
        }
        if (result.exitCode !== 0)
          throw new OpmError(
            'PACK_FAILED',
            result.stderr || `Pack exited ${result.exitCode}`,
          );
        for (const artifact of result.artifacts) {
          io.stdout.write(`${artifact.path}\n`);
          io.stdout.write(
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
        io.stdout.write(`Rolled back to generation ${target.sequence}\n`);
        return EXIT_CODES.success;
      }
      case 'gc': {
        // The shared store belongs to the user, not to a project, so this
        // needs no project and never runs as part of a project's own gc.
        if (args.options.has('shared')) {
          const result = await collectSharedStore({
            dryRun: args.options.has('dry-run'),
          });
          if (result.root === undefined) {
            io.stdout.write(
              'No shared store is in use (OPM_STORE_HOME is off or this host has none)\n',
            );
            return EXIT_CODES.success;
          }
          const verb = args.options.has('dry-run') ? 'Would remove' : 'Removed';
          io.stdout.write(
            `${verb} ${result.removed.length} unreferenced entr${result.removed.length === 1 ? 'y' : 'ies'} from ${result.root}; ` +
              `${result.referenced} still used by a project, ${result.tooNew} too new to judge\n`,
          );
          for (const path of result.removed) io.stdout.write(`  ${path}\n`);
          return EXIT_CODES.success;
        }
        const root = await requireOpmRoot(cwd);
        const keepValue = option(args, 'keep');
        const result = await collectGarbage({
          root,
          ...(!(keepValue === undefined) && { keep: Number(keepValue) }),
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

/** Report a failure and choose the exit code that tells a script what kind it was. */
export function handleError(error: unknown, io: CliIo): number {
  if (error instanceof UsageError) {
    io.stderr.write(report('', error.message));
    io.stderr.write(`\n${help()}\n`);
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
    switch (error.code) {
      case 'NOT_FOUND':
      case 'NO_PROJECT':
      case 'PLUGIN_NOT_INSTALLED':
        return EXIT_CODES.notFound;
      case 'AMBIGUOUS_SPEC':
      case 'INVALID_SPEC':
      case 'INVALID_MANIFEST':
      case 'INVALID_LOCK':
      case 'UNSUPPORTED_LOCK':
      case 'INVALID_CATALOG':
      case 'INVALID_PLUGIN_SPEC':
      case 'INVALID_PLUGIN_MANIFEST':
      case 'INVALID_PLUGIN_ARTIFACT':
      case 'PLUGIN_ALREADY_INSTALLED':
      case 'PLUGIN_ID_CONFLICT':
        return EXIT_CODES.invalidInput;
      case 'UNRESOLVABLE':
        return EXIT_CODES.unsatisfiable;
      case 'DIGEST_MISMATCH':
      case 'PLUGIN_DIGEST_MISMATCH':
      case 'SIZE_MISMATCH':
      case 'UNSAFE_PATH':
      case 'UNSAFE_BIN':
      case 'UNSAFE_SOURCE':
      case 'SIZE_LIMIT':
      case 'INVALID_DIGEST':
        return EXIT_CODES.verificationFailed;
      case 'OFFLINE':
      case 'FETCH_FAILED':
      case 'UNAVAILABLE':
      case 'PLUGIN_ERROR':
      case 'PLUGIN_FAILED':
      case 'PLUGIN_REGISTRY_UNCONFIGURED':
        return EXIT_CODES.unavailable;
      case 'ECOSYSTEM_DENIED':
      case 'POLICY':
      case 'POLICY_DENIED':
      case 'POLICY_INDETERMINATE':
        return EXIT_CODES.policyDenied;
      default:
        return EXIT_CODES.internal;
    }
  }
  // Delegated plugin operations surface ProviderError, which is not an
  // OpmError but carries the same string codes; map them instead of reporting
  // a generic internal error.
  if (error instanceof Error && 'code' in error) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') {
      io.stderr.write(report('opm: ', error.message));
      switch (code) {
        case 'OFFLINE':
        case 'UPSTREAM_UNAVAILABLE':
        case 'UPSTREAM_RESPONSE_TOO_LARGE':
        case 'INVALID_PROVIDER_RESPONSE':
        case 'PLUGIN_ERROR':
        case 'PLUGIN_FAILED':
          return EXIT_CODES.unavailable;
        case 'PACKAGE_NOT_FOUND':
        case 'ARTIFACT_NOT_FOUND':
        case 'VERSION_NOT_FOUND':
        case 'PLUGIN_NOT_INSTALLED':
          return EXIT_CODES.notFound;
        case 'DIGEST_MISMATCH':
        case 'SIZE_MISMATCH':
        // A signed release whose signature, signer, or signed document does
        // not hold is a verification failure, the same as bytes that do not
        // hash. (`INVALID_PROVIDER_METADATA` stays what it was: another
        // registry's malformed response is not evidence of tampering.)
        case 'SIGNATURE_VERIFICATION_FAILED':
        case 'INVALID_PACKSLIP_METADATA':
          return EXIT_CODES.verificationFailed;
        case 'INVALID_PURL':
        case 'UNSUPPORTED_OPERATION':
        case 'INVALID_PACKSLIP_INPUT':
          return EXIT_CODES.invalidInput;
        case 'UNRESOLVABLE':
        // Nothing wrong with the release, but nothing in it fits this machine.
        case 'HOST_INCOMPATIBLE':
          return EXIT_CODES.unsatisfiable;
        // A signer that changed is a decision for a person, not a failure; an
        // archive over the limit is a limit opm sets.
        case 'TRUST_CHANGE_REQUIRES_APPROVAL':
        case 'ARTIFACT_TOO_LARGE':
          return EXIT_CODES.policyDenied;
        default:
          return EXIT_CODES.internal;
      }
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
    io.stdout.write(
      installed.alreadyInstalled
        ? `Plugin ${installed.name} is already installed at ${installed.exactPurl}\n`
        : `Installed plugin ${installed.exactPurl}\n`,
    );
    io.stdout.write(
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
    io.stdout.write(`Removed plugin ${removed.name} (${removed.exactPurl})\n`);
    return EXIT_CODES.success;
  }
  if (sub === 'list') {
    const plugins = await listPlugins();
    if (plugins.length === 0) {
      io.stdout.write('(no plugins installed)\n');
      return EXIT_CODES.success;
    }
    for (const plugin of plugins) {
      const missing = plugin.present ? '' : '  (store entry missing)';
      io.stdout.write(
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
      io.stdout.write(`${entry.id}  ${entry.purlTypes.join(',')}  ${status}\n`);
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
    for (const path of projection.written)
      io.stdout.write(`  updated ${path}\n`);
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
  io.stdout.write(`${plan.command.join(' ')}\n`);
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
  if (outcome.stdout) io.stdout.write(outcome.stdout);
  if (outcome.stderr) io.stderr.write(outcome.stderr);
  if (outcome.exitCode !== 0) {
    io.stderr.write(`opm: host install exited ${outcome.exitCode}\n`);
    return EXIT_CODES.internal;
  }
  io.stdout.write(
    `Host-installed ${outcome.exactPurl}${outcome.installedVersion ? ` @ ${outcome.installedVersion}` : ''}\n`,
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

function help(): string {
  return `opm — Open Package Manager

Usage:
  opm init [--name <name>] [--path <dir>]
  opm import --native [--path <dir>] [--force]
  opm add <spec> [--ecosystem|-e <eco>] [--source <file|url>] [--alias <name>] [--offline|--online]
  opm remove <alias>
  opm install [--offline|--online]
  opm ci [--path <dir>] [--production] [--omit <dev|optional|peer>] [--offline|--online]
                                      install exactly what package-lock.json says;
                                      resolves nothing, runs no install script
                                      (opm install --frozen is the same)
  opm uninstall [alias]
  opm sync [--offline|--online]
  opm update [alias...] [--latest] [--offline|--online]
  opm list
  opm why <alias>
  opm gc [--keep <n>] [--dry-run]     remove store paths no retained generation uses
  opm gc --shared [--dry-run]         remove entries of the user-level package store
                                      that no project links to

${RUN_HELP}

Signed vendor releases (packslip — https://packslip.dev):
  opm add packslip:github.com/jdx/hk[@version]    (or packslip:jdx/hk)
  opm packslip verify <spec>                      who signed it; installs nothing
  opm packslip pin <spec> [--write]               hold a keyless project to its signer
  opm packslip approve <proposal-id>              accept one reported signer change
  Trust lives in opm.toml, never in the lock:
    [adapters.packslip.trust."github.com/jdx/hk"]  pin = ["ps1_…"]  (keyless)
    [adapters.packslip.trust."example.com/tool"]   public_key = "RW…"  (key-signed)
  A changed signer stops the resolve and prints a proposal id; nothing is
  accepted until a person approves exactly that change.
  OPM_PACKSLIP_GITHUB_TOKEN_ENV names the variable holding a GitHub token;
  OPM_PACKSLIP_TRUSTED_ROOT points at a Sigstore trusted_root.json.

Browse registries (no project needed):
  opm search <query|purl> [--ecosystem|-e <eco>]
  opm versions <purl> [--ecosystem|-e <eco>]
  opm info <exact-purl> [--ecosystem|-e <eco>]

Resolve a full dependency graph (transitive, proof-checked):
  opm resolve pkg:npm/chalk --range '^4.1.0'
  opm resolve pkg:npm/chalk --candidates 8

Pack a project:
  opm pack npm --package-version <version>
  opm pack <npm|cargo|pypi|nuget|maven|golang|oci|nix|deb|winget|chocolatey> --package-version <version>
  opm pack <purl-type> --package-version <version> --provider <id> --dry-run
  Standard packing is the default. OCI targets require explicit --os and --arch.
  Delegated providers come from [pack.providers.<id>] in opm.toml.
  Provider builds require --allow-build; network additionally requires --allow-network.
  Provider environment is empty unless each name is granted with --allow-env NAME.

Publish to a PREX registry (not npmjs, PyPI, or crates.io):
  opm publish --from <dir> --registry <url>
  opm publish --pack <ecosystem> --package-version <v> --registry <url>
  opm yank <exact-purl> --registry <url> --reason <text>
  OPM_PREX_REGISTRY is the default registry URL. --offline is refused.

Host/profile installers use the same verbs when the registry advertises
install (capability discovery). Examples:
  opm add pkg:nix/hello
  opm add pkg:deb/curl --allow-elevation --dry-run
  opm system available   # alias: list install-capable adapters

Delegated adapter plugins (user-level, never installed by default):
  opm plugin add <name>[@version]     install from the plugin registry
  opm plugin list                     show installed plugins and their pins
  opm plugin remove <name>            remove a plugin and its store entry
  opmx --plugin <name> <tool>         ephemeral-run a plugin-served purl type
  [plugins.<id>] store_digest = "sha256:…" in opm.toml pins an installed
  plugin for this project; optional artifact_origins lists extra HTTPS
  origins the host may fetch this plugin's artifacts from (union with
  OPM_HOST_FETCH_ORIGINS). Optional artifact_origin_token_envs lists
  env-var names (never values) parallel to those origins;
  OPM_HOST_FETCH_TOKEN_ENVS is the process-wide parallel list for
  OPM_HOST_FETCH_ORIGINS. Optional artifact_origin_extra_header_names and
  artifact_origin_extra_header_envs name one extra header per origin
  (for example X-JFrog-Art-Api); OPM_HOST_FETCH_HEADER_NAMES and
  OPM_HOST_FETCH_HEADER_ENVS are the process-wide parallel lists.
  OPM_HOST_FETCH_BEARER is not a grant unless that
  name is listed. The binding never acquires, and project commands fail
  closed when the installed entry digests differently.
  The plugin registry is selected with OPM_REGISTRY_OPM_PLUGIN; the store
  lives at OPM_PLUGIN_HOME or $XDG_DATA_HOME/openpacker/plugins.
  Installed plugins register as adapters at startup; a plugin that fails
  verification is reported on stderr and skipped (its ecosystem stays
  unsupported rather than answering untrusted).

Auth (env names only):
  opm auth set --origin <https-origin> [--token-env <NAME>]
  opm auth list
  opm auth unset --origin <https-origin>
  Remembers which environment variable holds a bearer for a pinned HTTPS origin.
  The file stores names only — never token values. Mint tokens outside opm
  (cloud CLI, gh, vault). No login command, device flow, or --token flag.
  Config: OPM_AUTH_CONFIG or $XDG_CONFIG_HOME/openpacker/auth.json (mode 0600).

Registries (catalog, from adapter discovery): ${registryEcosystems().join(', ') || '(none configured)'}
Host/profile install uses the same verbs when Registry Definition advertises install.

  Override one with OPM_REGISTRY_<ECOSYSTEM>, e.g.
  OPM_REGISTRY_NPM=https://npm.internal.example
  --offline refuses every registry read.

Specs:
  pkg:npm/@scope/name@1.2.3
  lodash@4.17.21 --ecosystem npm
  demo-tool --ecosystem npm --source ./vendor/demo-tool.tgz

opm import --native reads adapter readRequirements (package.json,
Cargo.toml, pyproject.toml, ...) into opm.toml once. Native files stay
non-authoritative: later sync does not re-import them.

An add with no --source and no catalog entry resolves against the ecosystem's
registry and verifies the download against the digest the registry published.

Project files:
  opm.toml          requirements (edit or use opm add/remove)
  opm.lock.json     exact pins (generated)
  .opm/store        content-addressed installs (hard links into the shared store)
  .opm/bin          executable shims (use with opmx or PATH)

Shared package store (one copy of each package per machine, linked into every
project): $XDG_CACHE_HOME/openpacker/store, else ~/.cache/openpacker/store.
OPM_STORE_HOME=/abs/path relocates it; OPM_STORE_HOME=off keeps each project
self-contained. It is used only on the project's own filesystem, where links
are possible. Free what no project uses with: opm gc --shared

Execute installed bins with: opmx <bin|package> [args...]
  Ephemeral: opmx pkg:nuget/dotnet-cowsay@1.3.0
  Ephemeral: opmx pkg:pypi/cowsay

Aliases: opkg, opkgm → opm
Protocol/control plane: openpacker (advanced)
`;
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

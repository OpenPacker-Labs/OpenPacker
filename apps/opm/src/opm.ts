#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { configureDefaultAdapters } from '@openpacker/adapters-default';
import {
  OpmError,
  addPackage,
  activateGeneration,
  collectGarbage,
  ecosystemFromPurl,
  environmentScript,
  environmentVariables,
  findOpmRoot,
  initProject,
  installProject,
  listGenerations,
  listInstalled,
  buildPackageManifest,
  hostSandboxFromPolicy,
  installSystemPackage,
  listRegistryVersions,
  packNativeProject,
  packDelegatedProject,
  readLockfile,
  readManifestFile,
  listSystemInstallers,
  parsePackageSpec,
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

/** Reported as the producer of any manifest opm writes. */
const OPM_VERSION = '0.1.0';

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
  'search',
  'versions',
  'info',
  'resolve',
  'manifest',
  'pack',
  'system',
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
    // Process entry registers adapters; core never imports ecosystems by name.
    configureDefaultAdapters();
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
        const spec = args.positionals[0];
        if (!spec) throw usage('opm add requires a package spec');
        const ecosystemOpt = option(args, 'ecosystem') ?? option(args, 'e');
        const source = option(args, 'source');
        const alias = option(args, 'alias');
        // Host/profile install is capability-driven and does not need a project.
        if (!source) {
          const parsed = parsePackageSpec(spec, {
            ...(ecosystemOpt !== undefined ? { ecosystem: ecosystemOpt } : {}),
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
            return runHostInstall(exact, args, io, cwd);
          }
        }
        const root = (await findOpmRoot(cwd)) ?? (await requireOpmRoot(cwd));
        const result = await addPackage({
          allowElevation: args.options.has('allow-elevation'),
          dryRun: args.options.has('dry-run'),
          root,
          spec,
          ...(ecosystemOpt !== undefined ? { ecosystem: ecosystemOpt } : {}),
          ...(source !== undefined ? { source } : {}),
          ...(alias !== undefined ? { alias } : {}),
          offline: args.options.has('offline'),
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
        writeNativeProjection(result.native, io);
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
        writeNativeProjection(result.native, io);
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
        const versions = await listRegistryVersions(ecosystem, target, {
          offline: args.options.has('offline'),
        });
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
        const target = args.positionals[0];
        if (!target) throw usage('opm resolve requires a package or PURL');
        const range = option(args, 'range');
        const graph = await resolveGraph({
          roots: [{ purl: target, ...(range === undefined ? {} : { range }) }],
          ...(option(args, 'candidates') === undefined
            ? {}
            : {
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
          io.stderr.write(`opm: ${item.purl}: ${item.reason}\n`);
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
          ...(option(args, 'name') === undefined
            ? {}
            : { name: option(args, 'name')! }),
          ...(option(args, 'package-version') === undefined
            ? {}
            : { version: option(args, 'package-version')! }),
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
          io.stderr.write(`opm: ${loss.code}: ${loss.omittedMeaning ?? ''}\n`);
        return EXIT_CODES.success;
      }
      case 'pack': {
        const root = await requireOpmRoot(cwd);
        const ecosystem =
          option(args, 'ecosystem') ?? option(args, 'e') ?? args.positionals[0];
        if (!ecosystem)
          throw usage(
            'opm pack requires an ecosystem: opm pack npm | opm pack nuget',
          );
        const output = option(args, 'output');
        if (args.options.has('delegate')) {
          const result = await packDelegatedProject({
            root,
            ecosystem,
            ...(output === undefined ? {} : { outputDirectory: output }),
            ...(option(args, 'tool') === undefined
              ? {}
              : { tool: option(args, 'tool')! }),
            allowBuild: args.options.has('allow-build'),
            allowNetwork: args.options.has('allow-network'),
            offline: args.options.has('offline'),
            dryRun: args.options.has('dry-run'),
          });
          if (!result.performed) {
            io.stdout.write(
              `${result.command?.join(' ') ?? 'standard pack'}\n`,
            );
            return EXIT_CODES.success;
          }
          if (result.exitCode !== 0)
            throw new OpmError(
              'PACK_FAILED',
              result.stderr || `Native pack exited ${result.exitCode}`,
            );
          for (const artifact of result.artifacts) {
            io.stdout.write(`${artifact.path}\n`);
            io.stdout.write(
              `  ${artifact.digest}  ${artifact.size} bytes  ${artifact.nativeRole}\n`,
            );
          }
          for (const loss of result.semanticLoss)
            io.stderr.write(
              `opm: ${loss.code}: ${loss.omittedMeaning ?? ''}\n`,
            );
          return EXIT_CODES.success;
        }
        const artifact = await packNativeProject({
          root,
          ecosystem,
          ...(output === undefined ? {} : { outputDirectory: output }),
        });
        io.stdout.write(`${artifact.path}\n`);
        io.stdout.write(`  ${artifact.digest}  ${artifact.size} bytes\n`);
        for (const loss of artifact.semanticLoss)
          io.stderr.write(`opm: ${loss.code}: ${loss.omittedMeaning ?? ''}\n`);
        return EXIT_CODES.success;
      }
      case 'system': {
        return runSystemCommand(args, io, cwd);
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
    key === 'help' ||
    key === 'force' ||
    key === 'offline' ||
    key === 'json' ||
    key === 'dry-run' ||
    key === 'delegate' ||
    key === 'allow-build' ||
    key === 'allow-network' ||
    key === 'allow-elevation'
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
    return runHostInstall(purl, args, io, cwd);
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
  report:
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
  if (!report) return;
  for (const projection of report.projections) {
    for (const path of projection.written)
      io.stdout.write(`  updated ${path}\n`);
    for (const entry of projection.skipped ?? [])
      io.stderr.write(`opm: skipped ${entry.path}: ${entry.reason}\n`);
    for (const loss of projection.semanticLoss)
      io.stderr.write(
        `opm: ${loss.code}${loss.representedMeaning ? `: ${loss.representedMeaning}` : ''}\n`,
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
  const root = await findOpmRoot(cwd);
  if (root) {
    try {
      const manifest = await readManifestFile(projectPaths(root).manifest);
      sandbox = hostSandboxFromPolicy(manifest.policy);
    } catch {
      sandbox = hostSandboxFromPolicy();
    }
  }
  const options = {
    offline: args.options.has('offline'),
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
    io.stderr.write(`opm: ${loss.code}: ${loss.representedMeaning}\n`);
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

/**
 * Which registry a browse command should read.
 *
 * A PURL names its own ecosystem, so `opm versions pkg:cargo/serde` needs no
 * flag. A bare name is ambiguous across registries and stays fail-closed, the
 * same way `opm add lodash` does — guessing npm because it is popular is how
 * you install the wrong package.
 */
function registryEcosystem(args: Parsed, target: string): string {
  const explicit = option(args, 'ecosystem') ?? option(args, 'e');
  if (explicit) return explicit;
  if (target.startsWith('pkg:')) {
    const type = target.slice(4).split('/')[0]?.toLowerCase();
    if (type) return type;
  }
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
  opm add <spec> [--ecosystem|-e <eco>] [--source <file|url>] [--alias <name>] [--offline]
  opm remove <alias>
  opm install [--offline]
  opm uninstall [alias]
  opm sync [--offline]
  opm update [--offline]
  opm list
  opm why <alias>

Browse registries (no project needed):
  opm search <query|purl> [--ecosystem|-e <eco>]
  opm versions <purl> [--ecosystem|-e <eco>]
  opm info <exact-purl> [--ecosystem|-e <eco>]

Resolve a full dependency graph (transitive, proof-checked):
  opm resolve pkg:npm/chalk --range '^4.1.0'
  opm resolve pkg:npm/chalk --candidates 8

Pack a project:
  opm pack npm
  opm pack npm --delegate --dry-run
  Delegated scripts/builds require --allow-build; network additionally requires --allow-network.

Host/profile installers use the same verbs when the registry advertises
install (capability discovery). Examples:
  opm add pkg:nix/hello
  opm add pkg:deb/curl --allow-elevation --dry-run
  opm system available   # alias: list install-capable adapters

Registries (catalog, from adapter discovery): ${registryEcosystems().join(', ') || '(none configured)'}
Host/profile install uses the same verbs when Registry Definition advertises install.

  Override one with OPM_REGISTRY_<ECOSYSTEM>, e.g.
  OPM_REGISTRY_NPM=https://npm.internal.example
  --offline refuses every registry read.

Specs:
  pkg:npm/@scope/name@1.2.3
  lodash@4.17.21 --ecosystem npm
  demo-tool --ecosystem npm --source ./vendor/demo-tool.tgz

An add with no --source and no catalog entry resolves against the ecosystem's
registry and verifies the download against the digest the registry published.

Project files:
  opm.toml          requirements (edit or use opm add/remove)
  opm.lock.json     exact pins (generated)
  .opm/store        content-addressed installs
  .opm/bin          executable shims (use with opmx or PATH)

Execute installed bins with: opmx <bin|package> [args...]
  Ephemeral: opmx pkg:nuget/dotnet-cowsay@1.3.0
  Ephemeral: opmx pkg:pypi/cowsay

Aliases: opkg, opkgm → opm
Protocol/control plane: openpacker (advanced)
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runOpm();
}

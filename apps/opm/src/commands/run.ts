/**
 * `opm run` and `opm exec`: the project's own scripts and `.bin` executables,
 * started with the person's authority (ADR 0047).
 *
 * Neither command loads an adapter or a plugin, reads a registry, installs
 * anything, runs a dependency's lifecycle script, or goes through the
 * sandbox. What they start is the person's code in the person's package.json,
 * or an executable `opm sync` laid out in `node_modules/.bin`.
 */
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BinProviderReport } from '@openpacker/opm-project';
import { RunError } from './run-error.js';
import {
  parseExecRequest,
  parseRunRequest,
  type ExecRequest,
  type RunRequest,
} from './run-args.js';
import {
  firstWord,
  isBatchFile,
  planBin,
  planScript,
} from './run-command-line.js';
import {
  exitStatus,
  processHost,
  runChild,
  type ChildHost,
  type ChildIo,
  type ChildOutcome,
} from './run-child.js';
import {
  binDirectories,
  binNameProblem,
  findProjectRoot,
  resolveBin,
  scriptEnvironment,
  type BinProbe,
} from './run-paths.js';

/** The process the commands run in; tests replace parts of it. */
export interface RunContext {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  host: ChildHost;
  probe?: ((file: string) => Promise<BinProbe>) | undefined;
}

export function processContext(): RunContext {
  return { env: process.env, platform: process.platform, host: processHost };
}

interface PackageFile {
  name: string | undefined;
  version: string | undefined;
  /** Own entries of `scripts`, in file order. */
  scripts: Map<string, unknown>;
}

const MAX_PACKAGE_JSON_BYTES = 4 * 1024 * 1024;

/**
 * `plainLine`, for text a project's files chose: one line, with no escape or
 * control character, nothing cut. Loaded when a message needs it, because
 * starting a script imports nothing but Node and this directory (ADR 0047,
 * `run-load.test.ts`); listing scripts and explaining a failure are the rare
 * paths.
 */
async function plain(): Promise<(text: string) => string> {
  return (await import('@openpacker/canonical')).plainLine;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

async function readPackageFile(root: string): Promise<PackageFile | undefined> {
  const file = join(root, 'package.json');
  let text: string;
  try {
    if ((await stat(file)).size > MAX_PACKAGE_JSON_BYTES)
      throw new RunError(
        'INVALID_MANIFEST',
        `${file} is larger than ${MAX_PACKAGE_JSON_BYTES} bytes`,
      );
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof RunError) throw error;
    // SAFETY: Node file-system errors carry a string `code`.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const plainLine = await plain();
    throw new RunError(
      'INVALID_MANIFEST',
      `${file} is not valid JSON: ${plainLine(error instanceof Error ? error.message : String(error))}`,
    );
  }
  if (!isRecord(parsed))
    throw new RunError('INVALID_MANIFEST', `${file} is not a JSON object`);
  const scripts = new Map<string, unknown>();
  if (parsed.scripts !== undefined) {
    if (!isRecord(parsed.scripts))
      throw new RunError(
        'INVALID_MANIFEST',
        `"scripts" in ${file} is not an object`,
      );
    for (const [name, command] of Object.entries(parsed.scripts))
      scripts.set(name, command);
  }
  return {
    name: asText(parsed.name),
    version: asText(parsed.version),
    scripts,
  };
}

/** `--path` is the project exactly; otherwise the opm project, else here. */
async function projectDirectory(
  path: string | undefined,
  cwd: string,
): Promise<string> {
  if (path !== undefined) return resolve(cwd, path);
  return (await findProjectRoot(cwd)) ?? resolve(cwd);
}

/**
 * A command on one line: a line feed shows as the two characters `\n`, and
 * what a terminal acts on is removed.
 */
function oneLine(command: string, plainLine: (text: string) => string): string {
  return plainLine(command.replace(/\r?\n/gu, '\\n'));
}

async function listScripts(pkg: PackageFile, io: ChildIo): Promise<number> {
  const plainLine = await plain();
  let listed = 0;
  for (const [name, command] of pkg.scripts)
    if (typeof command === 'string') {
      io.stdout.write(`${plainLine(name)}\t${oneLine(command, plainLine)}\n`);
      listed += 1;
    }
  if (listed === 0) io.stdout.write('(no scripts)\n');
  return 0;
}

function describeEnd(label: string, outcome: ChildOutcome): string {
  return outcome.code === undefined
    ? `opm: ${label} was ended by ${outcome.signal ?? 'a signal'}\n`
    : `opm: ${label} exited with code ${outcome.code}\n`;
}

/** Whether the first command of a Windows script is a batch file. */
async function firstCommandIsBatch(
  command: string,
  binDirs: readonly string[],
  context: RunContext,
): Promise<boolean> {
  const word = firstWord(command);
  if (word === '') return false;
  if (/[\\/]/u.test(word)) return isBatchFile(word);
  const inherited = (context.env.Path ?? context.env.PATH ?? '')
    .split(';')
    .filter((directory) => directory !== '');
  const { found } = await resolveBin(word, [...binDirs, ...inherited], {
    platform: context.platform,
    pathext: context.env.PATHEXT,
    probe: context.probe,
  });
  return found !== undefined && isBatchFile(found);
}

function comspec(context: RunContext): string | undefined {
  return context.env.ComSpec ?? context.env.COMSPEC;
}

export async function runScriptCommand(
  request: RunRequest,
  io: ChildIo,
  cwd: string,
  context: RunContext = processContext(),
): Promise<number> {
  const root = await projectDirectory(request.path, cwd);
  const pkg = await readPackageFile(root);
  if (pkg === undefined)
    throw new RunError(
      'NOT_FOUND',
      `No package.json in ${root}; opm run reads the scripts of the project's package.json (--path <dir> names another)`,
    );
  if (request.script === undefined) return await listScripts(pkg, io);

  const script = request.script;
  if (!pkg.scripts.has(script)) {
    if (request.ifPresent) return 0;
    const plainLine = await plain();
    const names = [...pkg.scripts.keys()].map((name) => plainLine(name));
    throw new RunError(
      'NOT_FOUND',
      `No script "${script}" in ${join(root, 'package.json')}` +
        (names.length === 0
          ? ' (it has no scripts)'
          : `; it has: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', ...' : ''}`),
    );
  }

  const binDirs = binDirectories(root);
  const sequence = [`pre${script}`, script, `post${script}`].filter((event) =>
    pkg.scripts.has(event),
  );
  for (const event of sequence) {
    const command = pkg.scripts.get(event);
    if (typeof command !== 'string')
      throw new RunError(
        'INVALID_MANIFEST',
        `Script "${event}" in ${join(root, 'package.json')} is not a string`,
      );
    const env = scriptEnvironment({
      base: context.env,
      binDirs,
      event,
      packageName: pkg.name,
      packageVersion: pkg.version,
      initCwd: resolve(cwd),
      platform: context.platform,
    });
    const plan = planScript(command, event === script ? request.args : [], {
      platform: context.platform,
      comspec: comspec(context),
      firstIsBatch:
        context.platform === 'win32' &&
        (await firstCommandIsBatch(command, binDirs, context)),
    });
    const outcome = await runChild(
      { plan, cwd: root, env, label: `script "${event}"` },
      io,
      context.host,
    );
    const status = exitStatus(outcome);
    if (status !== 0) {
      io.stderr.write(describeEnd(`script "${event}"`, outcome));
      return status;
    }
  }
  return 0;
}

function describeProviders(
  report: BinProviderReport,
  bin: string,
  plainLine: (text: string) => string,
): string[] {
  if (!report.locked)
    return [
      'This is not an opm project with a lock, so there is nothing to say about which package provides it.',
    ];
  if (report.providers.length === 0)
    return [
      `No package in opm.lock.json provides "${bin}". Add one with: opm add <purl>`,
    ];
  const lines = report.providers.slice(0, 5).map((provider) => {
    const how =
      provider.evidence === 'declared'
        ? 'declares it'
        : 'has that name, so it likely does';
    return `${plainLine(provider.alias)} (${plainLine(provider.purl)}), ${provider.direct ? 'a direct requirement' : 'a dependency'}, ${how}`;
  });
  const first = report.providers[0];
  const next =
    report.projection === 'layout'
      ? 'Run: opm sync   (it writes node_modules/.bin)'
      : 'Set native_projection = "layout" under [options] in opm.toml, then run: opm sync';
  return [
    'The lock would provide it through:',
    ...lines.map((line) => `  ${line}`),
    next,
    ...(first?.evidence === 'declared'
      ? [`Or run it inside the sandbox with: opmx ${bin}`]
      : []),
  ];
}

export async function runExecCommand(
  request: ExecRequest,
  io: ChildIo,
  cwd: string,
  context: RunContext = processContext(),
): Promise<number> {
  const problem = binNameProblem(request.bin, context.platform);
  if (problem !== undefined)
    throw new RunError('USAGE', `Cannot exec "${request.bin}": ${problem}`);
  const root = await projectDirectory(request.path, cwd);
  const binDirs = binDirectories(root);
  const resolution = await resolveBin(request.bin, binDirs, {
    platform: context.platform,
    pathext: context.env.PATHEXT,
    probe: context.probe,
  });
  if (resolution.found === undefined) {
    // The lock is only read to explain a failure, so the library that reads it
    // is loaded only then: a bin that is found never pays for it.
    const { findBinProviders } = await import('@openpacker/opm-project');
    const report = await findBinProviders(root, request.bin);
    const plainLine = await plain();
    throw new RunError(
      'NOT_FOUND',
      [
        `"${request.bin}" is not in node_modules/.bin of ${root} or any parent directory; exec never fetches or searches PATH`,
        ...resolution.present.map(
          (file) => `${plainLine(file)} exists but is not executable`,
        ),
        ...describeProviders(report, request.bin, plainLine),
      ].join('\n'),
    );
  }

  // package.json only names the run in the environment; a broken one must not
  // stop an executable that needs nothing from it.
  const pkg = await readPackageFile(root).catch(() => undefined);
  const env = scriptEnvironment({
    base: context.env,
    binDirs,
    event: 'exec',
    packageName: pkg?.name,
    packageVersion: pkg?.version,
    initCwd: resolve(cwd),
    platform: context.platform,
  });
  const plan = planBin(resolution.found, request.args, {
    platform: context.platform,
    comspec: comspec(context),
  });
  const outcome = await runChild(
    {
      plan,
      cwd: request.path === undefined ? resolve(cwd) : root,
      env,
      label: `"${request.bin}"`,
    },
    io,
    context.host,
  );
  if (outcome.code === undefined)
    io.stderr.write(describeEnd(`"${request.bin}"`, outcome));
  return exitStatus(outcome);
}

/** The entry `opm` uses: parse the tokens around the command name, then run. */
export async function runProjectCommand(
  command: 'run' | 'exec',
  head: readonly string[],
  rest: readonly string[],
  io: ChildIo,
  cwd: string,
  context: RunContext = processContext(),
): Promise<number> {
  return command === 'run'
    ? await runScriptCommand(parseRunRequest(head, rest), io, cwd, context)
    : await runExecCommand(parseExecRequest(head, rest), io, cwd, context);
}

/**
 * One package's scripts: reading its `package.json` and running a script with
 * its `pre` and `post` hooks in npm's order (ADR 0047). `opm run` calls it for
 * the project, and for each member of a workspace (ADR 0053).
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { RunError } from './run-error.js';
import { firstWord, isBatchFile, planScript } from './run-command-line.js';
import {
  exitStatus,
  type ChildIo,
  type ChildOutcome,
  type ChildSpec,
} from './run-child.js';
import type { RunContext } from './run-context.js';
import { binDirectories, resolveBin, scriptEnvironment } from './run-paths.js';
import { plain, quoted } from './run-plain.js';

export interface PackageFile {
  name: string | undefined;
  version: string | undefined;
  /** Own entries of `scripts`, in file order. */
  scripts: Map<string, unknown>;
}

export const MAX_PACKAGE_JSON_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * What `opm run` keeps of a `package.json`: its name, version and scripts. The
 * path is quoted as one plain line in what it says (`run-plain.ts`).
 */
export async function readPackageText(
  file: string,
  text: string,
): Promise<PackageFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const plainLine = await plain();
    throw new RunError(
      'INVALID_MANIFEST',
      `${plainLine(file)} is not valid JSON: ${plainLine(error instanceof Error ? error.message : String(error))}`,
    );
  }
  if (!isRecord(parsed))
    throw new RunError(
      'INVALID_MANIFEST',
      `${await quoted(file)} is not a JSON object`,
    );
  const scripts = new Map<string, unknown>();
  if (parsed.scripts !== undefined) {
    if (!isRecord(parsed.scripts))
      throw new RunError(
        'INVALID_MANIFEST',
        `"scripts" in ${await quoted(file)} is not an object`,
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

export async function readPackageFile(
  root: string,
): Promise<PackageFile | undefined> {
  const file = join(root, 'package.json');
  let text: string;
  try {
    if ((await stat(file)).size > MAX_PACKAGE_JSON_BYTES)
      throw new RunError(
        'INVALID_MANIFEST',
        `${await quoted(file)} is larger than ${MAX_PACKAGE_JSON_BYTES} bytes`,
      );
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof RunError) throw error;
    // SAFETY: Node file-system errors carry a string `code`.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return await readPackageText(file, text);
}

export function describeEnd(label: string, outcome: ChildOutcome): string {
  return outcome.code === undefined
    ? `${label} was ended by ${outcome.signal ?? 'a signal'}`
    : `${label} exited with code ${outcome.code}`;
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

export function comspec(context: RunContext): string | undefined {
  return context.env.ComSpec ?? context.env.COMSPEC;
}

/** The scripts that run for `script`, in order: `pre<script>`, `<script>`, `post<script>`. */
export function stepsOf(pkg: PackageFile, script: string): string[] {
  return [`pre${script}`, script, `post${script}`].filter((event) =>
    pkg.scripts.has(event),
  );
}

/** Starts one child and waits for its end; how a single run and a member of many differ. */
export type ChildRunner = (
  spec: ChildSpec,
  io: ChildIo,
) => Promise<ChildOutcome>;

export interface ScriptRun {
  /** The package directory: its `package.json` is read, the scripts run here. */
  dir: string;
  pkg: PackageFile;
  script: string;
  /** Appended to `script` and to no hook. */
  args: readonly string[];
  /** Where the child's output goes; a function gets the step's name and returns its streams. */
  io: ChildIo | ((step: string) => ChildIo);
  /** Runs each step's child. */
  start: ChildRunner;
  /** The directory `opm` was started in (`INIT_CWD`). */
  initCwd: string;
  context: RunContext;
  /** Run the children without a stdin of their own. */
  stdin?: 'inherit' | 'ignore' | undefined;
  /** Stop before the next step once this says so. */
  stopped?: () => boolean;
}

/** Refuse a `pre`, main or `post` script that is not a string, before any step runs. */
export async function assertStringSteps(
  dir: string,
  pkg: PackageFile,
  script: string,
): Promise<void> {
  for (const event of stepsOf(pkg, script))
    if (typeof pkg.scripts.get(event) !== 'string')
      throw new RunError(
        'INVALID_MANIFEST',
        `Script "${event}" in ${await quoted(join(dir, 'package.json'))} is not a string`,
      );
}

export interface ScriptResult {
  status: number;
  /** Why it stopped, for `opm:` on stderr; absent on success. */
  failure?: string;
}

/**
 * Run `pre<script>`, `<script>` and `post<script>` of one package, stopping at
 * the first step that fails. A step that cannot start throws `UNAVAILABLE`.
 */
export async function runScriptSteps(
  input: ScriptRun,
  where?: string,
): Promise<ScriptResult> {
  const { dir, pkg, script, context } = input;
  const binDirs = binDirectories(dir);
  for (const event of stepsOf(pkg, script)) {
    if (input.stopped?.() === true) return { status: 0 };
    const command = pkg.scripts.get(event);
    const label = `script "${event}"${where === undefined ? '' : ` of ${where}`}`;
    if (typeof command !== 'string')
      throw new RunError(
        'INVALID_MANIFEST',
        `Script "${event}" in ${await quoted(join(dir, 'package.json'))} is not a string`,
      );
    const env = scriptEnvironment({
      base: context.env,
      binDirs,
      event,
      packageName: pkg.name,
      packageVersion: pkg.version,
      initCwd: input.initCwd,
      platform: context.platform,
    });
    const plan = planScript(command, event === script ? input.args : [], {
      platform: context.platform,
      comspec: comspec(context),
      firstIsBatch:
        context.platform === 'win32' &&
        (await firstCommandIsBatch(command, binDirs, context)),
    });
    const spec: ChildSpec = { plan, cwd: dir, env, label };
    if (input.stdin !== undefined) spec.stdin = input.stdin;
    const streams = typeof input.io === 'function' ? input.io(event) : input.io;
    const outcome = await input.start(spec, streams);
    const status = exitStatus(outcome);
    if (status !== 0) return { status, failure: describeEnd(label, outcome) };
  }
  return { status: 0 };
}

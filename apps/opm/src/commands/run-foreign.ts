/**
 * What the `npm`, `pnpm` and `yarn` shims run (ADR 0061): the command line
 * read as that tool reads it, then `opm run` in the package that tool would
 * have used, with no step that reaches the tool.
 *
 * Like the rest of `opm run`, this imports nothing outside Node and its own
 * directory at load time; it is what starts inside the install jail when an
 * approved script calls `npm run` (ADR 0060 §3).
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { EXIT_CODES } from '../exit-codes.js';
import { parseRunRequest } from './run-args.js';
import type { ChildIo } from './run-child.js';
import { processContext, type RunContext } from './run-context.js';
import { RunError } from './run-error.js';
import { translateForeign, type ForeignTool } from './run-foreign-args.js';
import { MAX_PACKAGE_JSON_BYTES } from './run-package.js';
import { runScriptCommand } from './run.js';

async function isFile(path: string): Promise<boolean> {
  return await stat(path).then(
    (info) => info.isFile(),
    () => false,
  );
}

/** Whether `dir`'s package.json declares workspaces, read bounded; false when it cannot say. */
async function declaresWorkspaces(dir: string): Promise<boolean> {
  const file = join(dir, 'package.json');
  try {
    if ((await stat(file)).size > MAX_PACKAGE_JSON_BYTES) return false;
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return (
      typeof parsed === 'object' && parsed !== null && 'workspaces' in parsed
    );
  } catch {
    return false;
  }
}

/**
 * The package the tool would run in from `cwd`: the nearest directory at or
 * above it with a `package.json`, as npm, pnpm and yarn each find it; and,
 * when members are chosen, the nearest workspace root above that (a
 * `pnpm-workspace.yaml`, or a `package.json` with `workspaces`).
 */
export async function foreignProject(
  cwd: string,
  selects: boolean,
): Promise<string> {
  let nearest: string | undefined;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (nearest === undefined && (await isFile(join(dir, 'package.json'))))
      nearest = dir;
    if (!selects && nearest !== undefined) return nearest;
    if (
      selects &&
      ((await isFile(join(dir, 'pnpm-workspace.yaml'))) ||
        (await declaresWorkspaces(dir)))
    )
      return dir;
    if (dirname(dir) === dir) return nearest ?? resolve(cwd);
  }
}

function exitOf(error: RunError): number {
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

/** Run `<tool> <argv>` as the shim does; returns the exit status. */
export async function runForeign(
  tool: ForeignTool,
  argv: readonly string[],
  io: ChildIo,
  cwd: string,
  context: RunContext = processContext(),
): Promise<number> {
  try {
    const foreign = translateForeign(tool, argv);
    const project =
      foreign.path === undefined
        ? await foreignProject(cwd, foreign.selects)
        : resolve(cwd, foreign.path);
    const request = parseRunRequest([], ['--path', project, ...foreign.rest]);
    request.fallbackExec = foreign.fallbackExec;
    return await runScriptCommand(request, io, cwd, context);
  } catch (error) {
    if (!(error instanceof RunError)) throw error;
    // As `handleError` reports it, without loading the rest of opm to do so.
    const { report } = await import('@openpacker/canonical');
    io.stderr.write(report('opm: ', error.message));
    return exitOf(error);
  }
}

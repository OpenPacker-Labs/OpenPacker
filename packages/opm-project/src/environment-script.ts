import { quote } from 'shell-quote';
import {
  environmentPaths,
  readEnvironmentState,
  readGeneration,
  type Generation,
} from './generations.js';
import { OpmError } from './types.js';

/**
 * The environment a shell should see for a generation: the bin directories
 * that generation's members provide, newest first.
 *
 * This is derived from the record rather than stored, so it is regenerable and
 * an interrupted switch cannot leave it half-written.
 */
export async function environmentVariables(input: {
  root: string;
  generation?: Generation;
}): Promise<Record<string, string>> {
  const paths = environmentPaths(input.root);
  const state = await readEnvironmentState(input.root);
  const generation =
    input.generation ??
    (state
      ? await readGeneration(input.root, state.currentGenerationDigest)
      : undefined);
  // A directory containing ':' cannot be expressed in PATH at all. Checked
  // here, where PATH is built, rather than in the script writer: every
  // consumer — `opm shell`, `--json`, anything embedding these variables —
  // gets a truncated search path otherwise, and only one of them was quoting.
  if (paths.bin.includes(':'))
    throw new OpmError(
      'UNSAFE_PATH',
      `The project bin directory contains ':', which PATH cannot represent: ${paths.bin}`,
    );
  return {
    OPM_PROJECT_ROOT: paths.root,
    OPM_BIN: paths.bin,
    ...(generation && {
      OPM_GENERATION: String(generation.sequence),
      OPM_ENVIRONMENT: generation.environmentName,
    }),
    PATH: [paths.bin, process.env.PATH ?? ''].filter(Boolean).join(':'),
  };
}

/**
 * Quote a value for POSIX `sh`.
 *
 * Delegated to `shell-quote` rather than written here. The bug this replaced
 * used `JSON.stringify`, where `$`, a backtick and `\` stay live, so a project
 * directory named `demo$(...)` executed under the documented
 * `eval "$(opm shell)"`. Shell quoting has more edge cases than it appears to
 * — `!` under history expansion, `#`, globs, embedded quotes — and getting
 * them right is not this project's problem to solve.
 */
export function shellQuote(value: string): string {
  return quote([value]);
}

/**
 * The environment as `export` statements for `eval "$(opm shell)"`.
 *
 * Variable names are fixed constants rather than data, so only values need
 * quoting; a caller adding a dynamic name would have to validate it here.
 */
export async function environmentScript(input: {
  root: string;
  generation?: Generation;
}): Promise<string> {
  const environment = await environmentVariables(input);
  return Object.entries(environment)
    .map(([name, value]) => `export ${name}=${shellQuote(value)}\n`)
    .join('');
}

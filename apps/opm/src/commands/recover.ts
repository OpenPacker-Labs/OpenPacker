import { resolve } from 'node:path';
import {
  DEFAULT_STEP_WAIT_MS,
  OpmError,
  abandonStep,
  describeProcessOwner,
  describeRecovery,
  parseStepWait,
  printable,
  recoverInterruptedSteps,
  requireOpmRoot,
  type StepOptions,
} from '@openpacker/opm-project';
import type { CommandArgs, CommandIo } from './yank.js';

/**
 * What `opm` passes to every library step that changes a project
 * (`project-step.ts`): each step takes the project's step lock and puts back
 * what a killed `opm` left before it does its own work, on the root it was
 * given. The CLI says so in one line on stderr; it keeps no list of commands
 * of its own and recovers nothing itself.
 *
 * How long a step waits for another is `--wait <ms>`, or
 * `OPM_STEP_WAIT_MS`, or 10 s; whole milliseconds from 0 to an hour. It is
 * read, and refused if it makes no sense, when a step asks for it: a command
 * that never waits (`opm list`) does not care what it says.
 */
export function cliStep(
  io: { stderr: Pick<NodeJS.WriteStream, 'write'> },
  options: ReadonlyMap<string, string | true> = new Map(),
  env: NodeJS.ProcessEnv = process.env,
): StepOptions {
  const wait = (): number => {
    const flag = options.get('wait');
    if (flag === true)
      throw new OpmError(
        'INVALID_SPEC',
        '--wait needs a number of milliseconds',
      );
    const fromEnv = env.OPM_STEP_WAIT_MS;
    if (flag !== undefined) return parseStepWait(flag, '--wait');
    return fromEnv !== undefined && fromEnv !== ''
      ? parseStepWait(fromEnv, 'OPM_STEP_WAIT_MS')
      : DEFAULT_STEP_WAIT_MS;
  };
  return {
    get waitMs() {
      return wait();
    },
    onRecovered: (step) => io.stderr.write(`${describeRecovery(step)}\n`),
    onWait: (holder) =>
      io.stderr.write(
        `opm: waiting for ${holder.owner === undefined ? 'a lock opm cannot read' : describeProcessOwner(holder.owner)}, which is changing this project (${holder.file})\n`,
      ),
  };
}

/** What `opm recover` takes; anything else is refused, not ignored. */
const RECOVER_OPTIONS = ['abandon-step', 'force', 'path', 'wait'];

/**
 * `opm recover`: finish what a killed `opm` left, now, and nothing else.
 *
 * `opm recover --abandon-step <id>`: take the step with that lock or copy id
 * as dead, though this machine cannot see its owner (a container restarted
 * over the project, another host), remove its lock and put its copy back. It
 * is refused for a step whose owner is running here. For a step it cannot
 * judge it says what it costs to be wrong (the step may be running, writing
 * the project with its lock gone and its work undone) and does nothing until
 * `--force` says the operator knows. A copy made in another project is only
 * removed.
 */
export async function runRecoverCommand(
  args: CommandArgs,
  io: CommandIo,
  cwd: string,
  step: StepOptions,
): Promise<number> {
  for (const name of args.options.keys())
    if (!RECOVER_OPTIONS.includes(name))
      throw new OpmError(
        'INVALID_SPEC',
        `opm recover has no option --${name}; it takes --abandon-step <id>, --force, --path <dir> and --wait <ms>`,
      );
  // A wait that makes no sense is refused here, before anything is looked at.
  void step.waitMs;
  const path = args.options.get('path');
  if (path === true)
    throw new OpmError('INVALID_SPEC', '--path needs a directory');
  const root = await requireOpmRoot(
    path === undefined ? cwd : resolve(cwd, path),
  );
  const id = args.options.get('abandon-step');
  const force = args.options.get('force');
  if (id === true)
    throw new OpmError(
      'INVALID_SPEC',
      'opm recover --abandon-step needs the id of a step lock or copy, as the refusal prints it',
    );
  if (force !== undefined && (force !== true || id === undefined))
    throw new OpmError(
      'INVALID_SPEC',
      '--force goes with --abandon-step <id> and takes no value: it says you know that step is not running',
    );
  if (args.positionals.length > 0)
    throw new OpmError(
      'INVALID_SPEC',
      'opm recover takes no arguments but --abandon-step <id>, --force and --wait <ms>',
    );
  if (id === undefined) {
    const recovered = await recoverInterruptedSteps(root, step);
    io.stdout.write(
      recovered.length === 0
        ? 'Nothing to recover\n'
        : `Recovered ${recovered.length} step${recovered.length === 1 ? '' : 's'}\n`,
    );
    return 0;
  }
  const result = await abandonStep(root, id, {
    ...step,
    force: force === true,
  });
  const foreign = result.recovered.find((copy) => copy.foreign !== undefined);
  if (foreign !== undefined) {
    io.stdout.write(
      `Removed ${foreign.copy}, made for the project at ${printable(foreign.foreign!)}; this project was not changed\n`,
    );
    return 0;
  }
  if (result.owner !== undefined)
    io.stdout.write(
      `Took the step of ${describeProcessOwner(result.owner)} to be dead; if it is running on another host it still writes this project\n`,
    );
  for (const lock of result.removedLocks)
    io.stdout.write(
      lock.owner === undefined
        ? `Removed ${lock.file}, which does not say who held it\n`
        : `Removed ${lock.file}, held by ${describeProcessOwner(lock.owner)}\n`,
    );
  io.stdout.write(
    result.recovered.length === 0
      ? 'It left no copy to put back\n'
      : `Dealt with ${result.recovered.length} cop${result.recovered.length === 1 ? 'y' : 'ies'} it left (named above)\n`,
  );
  return 0;
}

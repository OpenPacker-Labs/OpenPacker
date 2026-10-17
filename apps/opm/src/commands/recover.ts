import {
  OpmError,
  abandonStep,
  describeProcessOwner,
  describeRecovery,
  parseStepWait,
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
 * `OPM_STEP_WAIT_MS`, or 10 s; whole milliseconds from 0 to an hour.
 */
export function cliStep(
  io: { stderr: Pick<NodeJS.WriteStream, 'write'> },
  options: ReadonlyMap<string, string | true> = new Map(),
  env: NodeJS.ProcessEnv = process.env,
): StepOptions {
  const flag = options.get('wait');
  if (flag === true)
    throw new OpmError('INVALID_SPEC', '--wait needs a number of milliseconds');
  const fromEnv = env.OPM_STEP_WAIT_MS;
  const waitMs =
    flag !== undefined
      ? parseStepWait(flag, '--wait')
      : fromEnv !== undefined && fromEnv !== ''
        ? parseStepWait(fromEnv, 'OPM_STEP_WAIT_MS')
        : undefined;
  return {
    ...(!(waitMs === undefined) && { waitMs }),
    onRecovered: (step) => io.stderr.write(`${describeRecovery(step)}\n`),
    onWait: (holder) =>
      io.stderr.write(
        `opm: waiting for ${holder.owner === undefined ? 'a lock opm cannot read' : describeProcessOwner(holder.owner)}, which is changing this project (${holder.file})\n`,
      ),
  };
}

/**
 * `opm recover`: finish what a killed `opm` left, now, and nothing else.
 * `opm recover --abandon-step <id>`: take the step with that lock or copy id
 * as dead, though this machine cannot see its owner (a container restarted
 * over the project, another host), remove its lock and put its copy back. It
 * is refused for a step whose owner is running here.
 */
export async function runRecoverCommand(
  args: CommandArgs,
  io: CommandIo,
  cwd: string,
  step: StepOptions,
): Promise<number> {
  const root = await requireOpmRoot(cwd);
  const id = args.options.get('abandon-step');
  if (id === true)
    throw new OpmError(
      'INVALID_SPEC',
      'opm recover --abandon-step needs the id of a step lock or copy, as the refusal prints it',
    );
  if (args.positionals.length > 0)
    throw new OpmError(
      'INVALID_SPEC',
      'opm recover takes no arguments but --abandon-step <id> and --wait <ms>',
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
  const result = await abandonStep(root, id, step);
  io.stdout.write(
    `Took the step of ${describeProcessOwner(result.owner)} to be dead; if it is running on another host it still writes this project\n`,
  );
  for (const lock of result.removedLocks)
    io.stdout.write(
      `Removed ${lock.file}, held by ${describeProcessOwner(lock.owner)}\n`,
    );
  io.stdout.write(
    result.recovered.length === 0
      ? 'It left no copy to put back\n'
      : `Dealt with ${result.recovered.length} cop${result.recovered.length === 1 ? 'y' : 'ies'} it left (named above)\n`,
  );
  return 0;
}

import {
  describeProcessOwner,
  describeRecovery,
  type StepOptions,
} from '@openpacker/opm-project';

/**
 * What `opm` passes to every library step that changes a project
 * (`project-step.ts`): each step takes the project's step lock and puts back
 * what a killed `opm` left before it does its own work, on the root it was
 * given. The CLI says so in one line on stderr; it keeps no list of commands
 * of its own and recovers nothing itself.
 */
export function cliStep(io: {
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}): StepOptions {
  return {
    onRecovered: (step) => io.stderr.write(`${describeRecovery(step)}\n`),
    onWait: (holder) =>
      io.stderr.write(
        `opm: waiting for ${holder.owner === undefined ? 'a lock opm cannot read' : describeProcessOwner(holder.owner)}, which is changing this project (${holder.file})\n`,
      ),
  };
}

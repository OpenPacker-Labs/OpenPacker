import { resolve } from 'node:path';
import {
  describeRecovery,
  findOpmRoot,
  recoverInterruptedSteps,
} from '@openpacker/opm-project';

/** The commands that change a project, which finish a killed step first. */
const CHANGES_THE_PROJECT = new Set([
  'add',
  'remove',
  'sync',
  'update',
  'install',
  'ci',
  'uninstall',
]);

/**
 * Before a command that changes the project: put back a project a killed
 * `opm` left half way through a step, and say so in one line on stderr
 * (`rollback-recovery.ts`). The library's steps do the same, silently, for
 * hosts that call them directly; by then there is nothing left to do.
 */
export async function recoverBeforeCommand(
  command: string,
  cwd: string,
  /** `--path`, where the command takes one (`opm ci --path <dir>`). */
  path: string | undefined,
  io: { stderr: Pick<NodeJS.WriteStream, 'write'> },
): Promise<void> {
  if (!CHANGES_THE_PROJECT.has(command)) return;
  const root = await findOpmRoot(resolve(cwd, path ?? '.'));
  if (root === undefined) return;
  for (const step of await recoverInterruptedSteps(root))
    io.stderr.write(`${describeRecovery(step)}\n`);
}

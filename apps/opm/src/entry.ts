/**
 * What the `opm` process entry does (ADR 0047).
 *
 * `opm run` and `opm exec` start the person's own scripts, and a build calls
 * them dozens of times. They need none of what every other command loads (the
 * project library and every ecosystem adapter), and loading that library costs
 * several times what Node itself takes to start. So they are answered here,
 * before it is loaded; everything else goes to `opm.js` unchanged. A failure is
 * reported by the same `handleError`, which is loaded only then.
 *
 * Nothing in this file or in `commands/run*.ts` may import a workspace package
 * for a value at load time; `run-load.test.ts` holds that.
 */
import { asksForHelp } from './commands/run-args.js';

export interface EntryIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export async function main(
  argv: readonly string[],
  io: EntryIo,
  cwd: string,
  otherCommands: () => Promise<number>,
): Promise<number> {
  const command = argv[0];
  if (
    (command === 'run' || command === 'exec') &&
    !asksForHelp(command, argv.slice(1))
  ) {
    try {
      const { runProjectCommand } = await import('./commands/run.js');
      return await runProjectCommand(command, [], argv.slice(1), io, cwd);
    } catch (error) {
      const { handleError } = await import('./opm.js');
      return handleError(error, io);
    }
  }
  return await otherCommands();
}

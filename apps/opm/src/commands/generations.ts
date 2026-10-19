<<<<<<< ours
=======
/**
 * `opm generations`, `opm rollback` and `opm gc`: what the project's (or the
 * shared) store holds and keeps. The values they print are paths and times the
 * store wrote, in a directory a repository may have named, so each line goes
 * through `say`.
 */

>>>>>>> theirs
import {
  OpmError,
  collectGarbage,
  collectSharedStore,
<<<<<<< ours
  rollbackTarget,
  switchGeneration,
  type Generation,
  type StepOptions,
} from '@openpacker/opm-project';
import type { CommandArgs, CommandIo } from './yank.js';

function option(args: CommandArgs, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

/** `opm rollback [--to <n>]`: one generation back unless told which. */
export async function runRollbackCommand(
  args: CommandArgs,
  io: CommandIo,
  root: string,
  step: StepOptions,
): Promise<number> {
  const to = option(args, 'to');
  const target = to
    ? await switchGeneration({ root, target: Number(to), step })
    : await rollbackToPrevious(root, step);
  io.stdout.write(`Rolled back to generation ${target.sequence}\n`);
  return 0;
}

/** Roll back one step, which is the common case. */
async function rollbackToPrevious(
  root: string,
  step: StepOptions,
): Promise<Generation> {
=======
  listGenerations,
  readEnvironmentState,
  requireOpmRoot,
  rollbackTarget,
  switchGeneration,
  type Generation,
} from '@openpacker/opm-project';
import { say } from '../error-report.js';

interface Io {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

const SUCCESS = 0;

export async function runGenerations(io: Io, cwd: string): Promise<number> {
  const root = await requireOpmRoot(cwd);
  const state = await readEnvironmentState(root);
  const generations = await listGenerations(root);
  if (generations.length === 0) {
    io.stdout.write('No generations yet. Run: opm install\n');
    return SUCCESS;
  }
  for (const generation of generations) {
    const current =
      generation.generationDigest === state?.currentGenerationDigest;
    say(
      io.stdout,
      `${current ? '*' : ' '} ${generation.sequence}\t${generation.createdAt}\t${generation.members.length} package(s)\n`,
    );
  }
  return SUCCESS;
}

/** Roll back one step, which is the common case. */
async function rollbackToPrevious(root: string): Promise<Generation> {
>>>>>>> theirs
  const target = await rollbackTarget(root);
  if (!target)
    throw new OpmError(
      'NOT_FOUND',
      'There is no earlier generation to roll back to',
    );
<<<<<<< ours
  return switchGeneration({ root, target: target.generationDigest, step });
}

/** `opm gc --shared [--dry-run]`: the user's store, which needs no project. */
export async function runSharedGcCommand(
  args: CommandArgs,
  io: CommandIo,
): Promise<number> {
  const result = await collectSharedStore({
    dryRun: args.options.has('dry-run'),
  });
  if (result.root === undefined) {
    io.stdout.write(
      'No shared store is in use (OPM_STORE_HOME is off or this host has none)\n',
    );
    return 0;
  }
  const verb = args.options.has('dry-run') ? 'Would remove' : 'Removed';
  io.stdout.write(
    `${verb} ${result.removed.length} unreferenced entr${result.removed.length === 1 ? 'y' : 'ies'} from ${result.root}; ` +
      `${result.referenced} still used by a project, ${result.tooNew} too new to judge\n`,
  );
  for (const path of result.removed) io.stdout.write(`  ${path}\n`);
  return 0;
}

/** `opm gc [--keep <n>] [--dry-run]`: the project's own store. */
export async function runGcCommand(
  args: CommandArgs,
  io: CommandIo,
  root: string,
  step: StepOptions,
): Promise<number> {
  const keepValue = option(args, 'keep');
  const result = await collectGarbage({
    root,
    ...(!(keepValue === undefined) && { keep: Number(keepValue) }),
    dryRun: args.options.has('dry-run'),
    step,
  });
  const verb = args.options.has('dry-run') ? 'Would remove' : 'Removed';
  io.stdout.write(
    `${verb} ${result.removed.length} store path(s); retained ${result.retained.length} generation(s)\n`,
  );
  for (const path of result.removed) io.stdout.write(`  ${path}\n`);
  return 0;
=======
  return switchGeneration({ root, target: target.generationDigest });
}

export async function runRollback(
  to: string | undefined,
  io: Io,
  cwd: string,
): Promise<number> {
  const root = await requireOpmRoot(cwd);
  const target = to
    ? await switchGeneration({ root, target: Number(to) })
    : await rollbackToPrevious(root);
  say(io.stdout, `Rolled back to generation ${target.sequence}\n`);
  return SUCCESS;
}

export async function runGc(
  options: {
    shared: boolean;
    dryRun: boolean;
    keep: string | undefined;
  },
  io: Io,
  cwd: string,
): Promise<number> {
  const verb = options.dryRun ? 'Would remove' : 'Removed';
  // The shared store belongs to the user, not to a project, so this needs no
  // project and never runs as part of a project's own gc.
  if (options.shared) {
    const result = await collectSharedStore({ dryRun: options.dryRun });
    if (result.root === undefined) {
      io.stdout.write(
        'No shared store is in use (OPM_STORE_HOME is off or this host has none)\n',
      );
      return SUCCESS;
    }
    say(
      io.stdout,
      `${verb} ${result.removed.length} unreferenced entr${result.removed.length === 1 ? 'y' : 'ies'} from ${result.root}; ` +
        `${result.referenced} still used by a project, ${result.tooNew} too new to judge\n`,
    );
    for (const path of result.removed) say(io.stdout, `  ${path}\n`);
    return SUCCESS;
  }
  const root = await requireOpmRoot(cwd);
  const result = await collectGarbage({
    root,
    ...(options.keep !== undefined && { keep: Number(options.keep) }),
    dryRun: options.dryRun,
  });
  say(
    io.stdout,
    `${verb} ${result.removed.length} store path(s); retained ${result.retained.length} generation(s)\n`,
  );
  for (const path of result.removed) say(io.stdout, `  ${path}\n`);
  return SUCCESS;
>>>>>>> theirs
}

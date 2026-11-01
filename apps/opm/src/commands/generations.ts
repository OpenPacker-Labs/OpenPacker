import { out } from '@openpacker/canonical';
import {
  OpmError,
  collectGarbage,
  collectSharedStore,
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
  out(io, `Rolled back to generation ${target.sequence}\n`);
  return 0;
}

/** Roll back one step, which is the common case. */
async function rollbackToPrevious(
  root: string,
  step: StepOptions,
): Promise<Generation> {
  const target = await rollbackTarget(root);
  if (!target)
    throw new OpmError(
      'NOT_FOUND',
      'There is no earlier generation to roll back to',
    );
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
    out(
      io,
      'No shared store is in use (OPM_STORE_HOME is off or this host has none)\n',
    );
    return 0;
  }
  const verb = args.options.has('dry-run') ? 'Would remove' : 'Removed';
  out(
    io,
    `${verb} ${result.removed.length} unreferenced entr${result.removed.length === 1 ? 'y' : 'ies'} from ${result.root}; ` +
      `${result.referenced} still used by a project, ${result.tooNew} too new to judge\n`,
  );
  for (const path of result.removed) out(io, `  ${path}\n`);
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
  out(
    io,
    `${verb} ${result.removed.length} store path(s); retained ${result.retained.length} generation(s)\n`,
  );
  for (const path of result.removed) out(io, `  ${path}\n`);
  return 0;
}

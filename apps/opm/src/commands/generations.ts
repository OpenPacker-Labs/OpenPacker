/**
 * `opm generations`, `opm rollback` and `opm gc`: what the project's (or the
 * shared) store holds and keeps. The values they print are paths and times the
 * store wrote, in a directory a repository may have named, so each line goes
 * through `say`.
 */

import {
  OpmError,
  collectGarbage,
  collectSharedStore,
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
  const target = await rollbackTarget(root);
  if (!target)
    throw new OpmError(
      'NOT_FOUND',
      'There is no earlier generation to roll back to',
    );
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
}

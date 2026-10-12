/**
 * Where the directories of a layout are, on disk.
 *
 * The project's own packages sit in `<project>/node_modules`. A workspace
 * member has a `node_modules` of its own beside its source
 * (`<project>/packages/x/node_modules`) for the versions only it wants, and the
 * same rules apply inside it: a package at a chain of names, a `.bin` for the
 * executables, a record of what opm wrote.
 */

import { join } from 'node:path';

/** The `node_modules` of the project (`base` empty) or of the member at `base`. */
export function modulesOf(projectRoot: string, base: string): string {
  return base === ''
    ? join(projectRoot, 'node_modules')
    : join(projectRoot, ...base.split('/'), 'node_modules');
}

/** `['b', 'c']` → `<modules>/b/node_modules/c`. */
export function directoryOf(modules: string, chain: readonly string[]): string {
  return join(
    modules,
    ...chain.flatMap((name, index) => [
      ...(index === 0 ? [] : ['node_modules']),
      ...name.split('/'),
    ]),
  );
}

/** The `node_modules` directory a package at `chain` sits directly in. */
export function containerOf(modules: string, chain: readonly string[]): string {
  return chain.length === 1
    ? modules
    : join(directoryOf(modules, chain.slice(0, -1)), 'node_modules');
}

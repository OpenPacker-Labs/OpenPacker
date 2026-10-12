/**
 * Shared set-up for the Windows-only link suites (`handle-windows-link*.test.ts`):
 * a project with a workspace member, an open `node_modules`, and the cleanup that
 * closes and removes them. Every step can write a line to stderr first: a native
 * fault takes the process down without a JavaScript error, and the last line then
 * names the call that did it.
 */

import { constants, writeSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const trace = (message: string): void => {
  writeSync(2, `[handle-windows-link] ${message}\n`);
};

export const MEMBER = '../packages/pkg';

const temps: string[] = [];
export const handles: FileHandle[] = [];

/** Close every handle and remove every project the test made; run from `afterEach`. */
export async function cleanup(): Promise<void> {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

export async function project() {
  trace('make a project directory');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opm-junction-')));
  temps.push(root);
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await mkdir(join(root, 'packages', 'pkg'), { recursive: true });
  await writeFile(join(root, 'packages', 'pkg', 'index.js'), 'member');
  const modules = await open(join(root, 'node_modules'), constants.O_RDONLY);
  handles.push(modules);
  return {
    root,
    modules,
    site: { directory: 'node_modules', projectRoot: root },
    member: join(root, 'packages', 'pkg'),
    link: (name: string) => join(root, 'node_modules', name),
  };
}

/**
 * Shared set-up for the layout-writer link suites (`layout-write-links*.test.ts`):
 * a project with a workspace member and a place to keep extracted packages, and
 * the two links the tests write.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { NativeLockEntry } from '@openpacker/adapter-core';
import type { LayoutLink } from './layout-links.js';
import {
  LAYOUT_RECORD,
  writeNodeModules,
  type LayoutOutcome,
} from './layout-write.js';

const temps: string[] = [];
/** Remove every project the test made; run from `afterEach`. */
export async function cleanup(): Promise<void> {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

/** A project with a workspace member and a place to keep extracted packages. */
export async function project() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'npm-links-')));
  temps.push(dir);
  const root = join(dir, 'project');
  const member = join(root, 'packages', 'member');
  await mkdir(member, { recursive: true });
  await writeFile(
    join(member, 'package.json'),
    '{"name":"member","version":"1.0.0","main":"index.js"}',
  );
  await writeFile(join(member, 'index.js'), "module.exports = 'one';\n");
  let counter = 0;
  const modules = join(root, 'node_modules');
  return {
    dir,
    root,
    member,
    modules,
    async store(
      name: string,
      files: Record<string, string> = {},
      extra: Record<string, unknown> = {},
    ): Promise<NativeLockEntry> {
      counter += 1;
      const storePath = join(dir, 'store', `sha256-${counter}`);
      const all: Record<string, string> = {
        'package.json': JSON.stringify({ name, version: '1.0.0', ...extra }),
        'index.js': `module.exports = ${JSON.stringify(name)};\n`,
        ...files,
      };
      for (const [path, contents] of Object.entries(all)) {
        const target = join(storePath, 'package', path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, contents);
      }
      return {
        purl: `pkg:npm/${name}`,
        exactPurl: `pkg:npm/${name}@1.0.0`,
        name,
        version: '1.0.0',
        scope: 'runtime',
        source: `file:${storePath}`,
        digest: `sha256:${String(counter).padStart(64, '0')}`,
        size: 1,
        storePath,
        transitive: false,
        alias: `${name}@1.0.0`,
      };
    },
    write: (
      entries: NativeLockEntry[],
      links: readonly LayoutLink[],
    ): Promise<LayoutOutcome> => writeNodeModules(root, entries, { links }),
    run(script: string): string {
      return execFileSync(process.execPath, ['-e', script], {
        cwd: root,
        encoding: 'utf8',
      }).trim();
    },
    async record(): Promise<Record<string, unknown>> {
      return JSON.parse(
        await readFile(join(modules, LAYOUT_RECORD), 'utf8'),
      ) as Record<string, unknown>;
    },
  };
}

export const MEMBER: LayoutLink = {
  path: 'node_modules/member',
  target: '../packages/member',
};
export const SCOPED: LayoutLink = {
  path: 'node_modules/@scope/scoped',
  target: '../../packages/member',
};

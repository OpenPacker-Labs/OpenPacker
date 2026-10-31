/**
 * macOS puts $TMPDIR under /var, which is a link to /private/var, and a jail
 * grant may not contain a link (`assertSafeJailPath`). The jail home is a
 * grant of every run, so a home made under the lexical $TMPDIR refused every
 * run there with "path must not contain symbolic links". Linux can show the
 * same by pointing TMPDIR at a link.
 */

import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeJailPath,
  createMockBackend,
  defaultJailHomeRoot,
  runInSandbox,
} from './index.js';

const roots: string[] = [];
const restores: Array<() => void> = [];

afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** A temp directory reached through a symlink, as /var/folders is on macOS. */
async function linkedTmpdir(): Promise<{ real: string; link: string }> {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'op-jail-home-'));
  roots.push(base);
  const real = join(base, 'private-var');
  await mkdir(real);
  const link = join(base, 'var');
  await symlink(real, link);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = link;
  restores.push(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
  return { real, link };
}

describe('the jail home under a symlinked temp directory', () => {
  it('is rooted at the real path, which is a grant the check accepts', async () => {
    const { real } = await linkedTmpdir();
    const root = defaultJailHomeRoot();
    expect(root).toBe(join(real, `openpacker-sandbox-${process.geteuid?.()}`));
    await mkdir(root, { recursive: true });
    expect(assertSafeJailPath(root, 'readwrite path')).toBe(root);
  });

  it('lets a run start where the lexical temp directory is a link', async () => {
    await linkedTmpdir();
    const project = await mkdtemp(
      join(await realpath(tmpdir()), 'op-jail-home-run-'),
    );
    roots.push(project);
    const outcome = await runInSandbox({
      argv: ['/bin/sh', '-c', 'echo started'],
      cwd: project,
      policy: { enabled: true, mode: 'fail-closed', required: true },
      readwritePaths: [],
      readonlyPaths: [project],
      backend: createMockBackend(),
    });
    expect(outcome.stdout.trim()).toBe('started');
    expect(outcome.exitCode).toBe(0);
  });
});

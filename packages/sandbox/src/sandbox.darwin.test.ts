/**
 * macOS only. The suites that run everywhere else bind the libc backend to
 * glibc and spoof the platform for the refusals; this one runs the sandbox on
 * the real thing (CI: the macOS leg of "CI build"). A failure names the call
 * that failed: `openStableJailPath` is the walk that used to end in
 * `ENOENT: no such file or directory, open '/dev/fd/N/<name>'`, and
 * `runInSandbox` is what lifecycle scripts, `opmx` and `opm pack` go through.
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDirChild } from '@openpacker/project-io';
import { createMockBackend, runInSandbox } from './index.js';
import { openStableJailPath } from './paths.js';

describe.skipIf(process.platform !== 'darwin')('the sandbox on macOS', () => {
  let dir: string;
  beforeAll(async () => {
    // $TMPDIR is under /var, a symlink to /private/var; a jail grant may not
    // contain a link, so the real path is used.
    dir = await mkdtemp(join(await realpath(tmpdir()), 'op-sandbox-darwin-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('openStableJailPath opens a directory and a file grant without /dev/fd', async () => {
    await mkdir(join(dir, 'tree', 'inner'), { recursive: true });
    await writeFile(join(dir, 'tree', 'inner', 'file'), 'bytes');
    const folder = await openStableJailPath(join(dir, 'tree', 'inner'));
    try {
      expect(await readDirChild(folder)).toEqual(['file']);
    } finally {
      await folder.close();
    }
    const file = await openStableJailPath(
      join(dir, 'tree', 'inner', 'file'),
      'sandbox bind',
    );
    try {
      expect((await file.stat()).size).toBe(5);
    } finally {
      await file.close();
    }
  });

  it('runInSandbox runs under a supplied backend with its grants opened by libc openat', async () => {
    const project = join(dir, 'project');
    const scratch = join(dir, 'scratch');
    await mkdir(project, { recursive: true });
    await mkdir(scratch, { recursive: true });
    const outcome = await runInSandbox({
      argv: ['/bin/sh', '-c', 'pwd -P'],
      cwd: project,
      policy: { enabled: true, mode: 'fail-closed', required: true },
      readwritePaths: [scratch],
      readonlyPaths: [project],
      backend: createMockBackend(),
    });
    // Before the fix this threw ENOENT while opening the first grant.
    expect(outcome.stderr).not.toMatch(/ENOENT|\/dev\/fd/u);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.trim()).toBe(project);
  });

  it('runInSandbox with no supplied backend is refused, naming macOS, never a late ENOENT', async () => {
    const project = join(dir, 'project-default');
    await mkdir(project, { recursive: true });
    const outcome = await runInSandbox({
      argv: ['/bin/sh', '-c', 'true'],
      cwd: project,
      policy: { enabled: true, mode: 'fail-closed', required: true },
      readwritePaths: [],
      readonlyPaths: [project],
    });
    expect(outcome.enforced).toBe(false);
    expect(outcome.exitCode).toBe(78);
    expect(outcome.stderr).not.toMatch(/ENOENT|\/dev\/fd/u);
    expect(outcome.stderr).toMatch(/withdrawn on macOS/u);
  });

  it('runInSandbox refuses an executable snapshot before it opens anything', async () => {
    const failure = await runInSandbox({
      argv: ['/approved/tool'],
      cwd: dir,
      policy: { enabled: true, mode: 'fail-closed', required: true },
      readwritePaths: [],
      readonlyPaths: [],
      executableAuthority: { fd: 3, path: '/approved/tool' },
      backend: createMockBackend(),
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'EXECUTABLE_AUTHORITY_UNSUPPORTED' });
    expect(String(failure)).toMatch(/on macOS/u);
  });
});

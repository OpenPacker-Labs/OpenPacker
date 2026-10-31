import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  inheritedHandleCount,
  MAX_INHERITED_HANDLES,
  runInSandbox,
  spawnCapture,
  type RunInSandboxInput,
  type SandboxBackend,
} from './index.js';

/**
 * A caller that binds many paths (opmx binds every package a tool needs) has
 * to know, before it runs, how many handles the run will hand the process: the
 * spawner refuses more than MAX_INHERITED_HANDLES. `inheritedHandleCount` is
 * that number, and it must be the one `runInSandbox` actually passes.
 */

const root = mkdtempSync(join(tmpdir(), 'op-handles-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const dir = (name: string) => {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
};

/** Runs nothing; records how many handles the backend was given. */
function recording(): { backend: SandboxBackend; passed: number[] } {
  const passed: number[] = [];
  return {
    passed,
    backend: {
      id: 'mock',
      async run(input) {
        passed.push(
          (input.directoryAuthorities?.length ?? 0) +
            (input.executableAuthority === undefined ? 0 : 1),
        );
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  };
}

type Input = Omit<RunInSandboxInput, 'argv' | 'backend'>;
const policy = { mode: 'fail-closed', prefer: 'native' } as const;

describe('inheritedHandleCount', () => {
  it('is what runInSandbox passes the backend', async () => {
    const handle = await open(dir('passed'), 'r');
    try {
      const inputs: Input[] = [
        // Paths, the working directory apart from them.
        {
          cwd: dir('work'),
          policy,
          readwritePaths: [dir('rw')],
          readonlyPaths: [dir('a'), dir('b')],
        },
        // The working directory is one of the paths, and a path is given twice.
        {
          cwd: dir('a'),
          policy,
          readwritePaths: [],
          readonlyPaths: [dir('a'), dir('b'), join(dir('b'), '.')],
        },
        // Grants for the package, from the policy and from the caller.
        {
          cwd: dir('work'),
          policy: {
            ...policy,
            packages: {
              'pkg:npm/x': { read: [dir('g1')], write: [dir('g2')] },
            },
          },
          packageId: 'pkg:npm/x',
          grants: { read: [dir('g3'), dir('a')] },
          readwritePaths: [],
          readonlyPaths: [dir('a')],
        },
        // A handle passed in for one of the paths.
        {
          cwd: dir('work'),
          policy,
          readwritePaths: [],
          readonlyPaths: [dir('passed'), dir('b')],
          directoryAuthorities: [{ fd: handle.fd, path: dir('passed') }],
        },
      ];
      for (const input of inputs) {
        const { backend, passed } = recording();
        await runInSandbox({ ...input, argv: ['/bin/true'], backend });
        expect(passed).toEqual([inheritedHandleCount(input)]);
      }
    } finally {
      await handle.close();
    }
  });

  it('is the bound the spawner holds a run to', async () => {
    const run = (fds: number) =>
      spawnCapture({
        argv: [process.execPath, '-e', ''],
        cwd: root,
        env: {},
        treeContainment: 'test-only',
        inheritedFds: Array.from({ length: fds }, () => 0),
      });
    await expect(run(MAX_INHERITED_HANDLES)).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(run(MAX_INHERITED_HANDLES + 1)).rejects.toThrow(
      `At most ${MAX_INHERITED_HANDLES} valid handles may be inherited`,
    );
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildBwrapArgv,
  createMockBackend,
  inheritedHandleCount,
  runInSandbox,
  type RunInSandboxInput,
  type SandboxBackend,
} from './index.js';

/**
 * `inheritedHandleCount` is held to three things that do not use its rule:
 * numbers counted by hand from each layout below; the handles the bwrap
 * command line takes (`--bind-fd`, `--ro-bind-fd`, `--ro-bind-data`); and the
 * directories a process really holds when the spawner starts it. A rule that
 * is wrong moves `runInSandbox`'s handles and the count together, so comparing
 * those two with each other proved nothing.
 */

const root = mkdtempSync(join(tmpdir(), 'op-handles-oracle-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const dir = (name: string) => {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
};

type Input = Omit<RunInSandboxInput, 'argv' | 'backend'>;
const policy = { mode: 'fail-closed', prefer: 'native' } as const;

interface Layout {
  name: string;
  input: Input;
  /** Counted by hand: the jail's home always, then each line's own. */
  handles: number;
  /** A handle held open for a path the layout was given one for. */
  passed?: string[];
  /** The standalone executable's handle. */
  executable?: boolean;
}

const layouts = (): Layout[] => [
  {
    // work, jail home
    name: 'a working directory and nothing else',
    input: { cwd: dir('work'), policy, readwritePaths: [], readonlyPaths: [] },
    handles: 2,
  },
  {
    // rw, a, b, work, jail home
    name: 'a writable path, two read-only ones, the working directory apart',
    input: {
      cwd: dir('work'),
      policy,
      readwritePaths: [dir('rw')],
      readonlyPaths: [dir('a'), dir('b')],
    },
    handles: 5,
  },
  {
    // a (the cwd, given twice), b (given twice), jail home
    name: 'the working directory is a path, and paths are given twice',
    input: {
      cwd: dir('a'),
      policy,
      readwritePaths: [],
      readonlyPaths: [dir('a'), dir('b'), join(dir('b'), '.')],
    },
    handles: 3,
  },
  {
    // a, g1 (policy read), g3 (caller read), g2 (policy write), work, jail home
    name: 'grants from the policy and from the caller',
    input: {
      cwd: dir('work'),
      policy: {
        ...policy,
        packages: { 'pkg:npm/x': { read: [dir('g1')], write: [dir('g2')] } },
      },
      packageId: 'pkg:npm/x',
      grants: { read: [dir('g3'), dir('a')] },
      readwritePaths: [],
      readonlyPaths: [dir('a')],
    },
    handles: 6,
  },
  {
    // passed (handed in), b, work, jail home
    name: 'a handle handed in for one of the paths',
    input: {
      cwd: dir('work'),
      policy,
      readwritePaths: [],
      readonlyPaths: [dir('passed'), dir('b')],
    },
    passed: ['passed'],
    handles: 4,
  },
  {
    // work and g2 (both handed in), jail home
    name: 'handles handed in for the working directory and a granted path',
    input: {
      cwd: dir('work'),
      policy: {
        ...policy,
        packages: { 'pkg:npm/x': { write: [dir('g2')] } },
      },
      packageId: 'pkg:npm/x',
      readwritePaths: [],
      readonlyPaths: [],
    },
    passed: ['work', 'g2'],
    handles: 3,
  },
  {
    // work, jail home, the executable
    name: 'a standalone executable',
    input: { cwd: dir('work'), policy, readwritePaths: [], readonlyPaths: [] },
    executable: true,
    handles: 3,
  },
  {
    // work, jail home, g2 (handed in), the executable
    name: 'a standalone executable, a handed-in handle and a grant',
    input: {
      cwd: dir('work'),
      policy: {
        ...policy,
        packages: { 'pkg:npm/x': { read: [dir('g2')] } },
      },
      packageId: 'pkg:npm/x',
      readwritePaths: [],
      readonlyPaths: [],
    },
    passed: ['g2'],
    executable: true,
    handles: 4,
  },
];

/** The layout's input with handles opened for what it was handed. */
async function withHandles(layout: Layout) {
  const files = await Promise.all(
    (layout.passed ?? []).map(async (name) => ({
      name,
      handle: await open(join(root, name), 'r'),
    })),
  );
  writeFileSync(join(root, 'tool'), '#!/bin/sh\n');
  const executable = layout.executable
    ? await open(join(root, 'tool'), 'r')
    : undefined;
  const input: Input = {
    ...layout.input,
    ...(files.length > 0 && {
      directoryAuthorities: files.map(({ name, handle }) => ({
        fd: handle.fd,
        path: join(root, name),
      })),
    }),
    ...(executable !== undefined && {
      executableAuthority: { fd: executable.fd, path: join(root, 'tool') },
    }),
  };
  return {
    input,
    close: () =>
      Promise.all(
        [...files.map(({ handle }) => handle), executable].map((h) =>
          h?.close(),
        ),
      ),
  };
}

/** What the backend of a run is given. */
type Seen = Parameters<SandboxBackend['run']>[0];

function recording(): { backend: SandboxBackend; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    backend: {
      id: 'mock',
      async run(input) {
        seen.push(input);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  };
}

/** The bwrap command line the native backend builds from what it is given. */
function bwrapLine(input: Seen): string[] {
  const directoryAuthorities = (input.directoryAuthorities ?? []).map(
    ({ path }, index) => ({ path, childFd: 3 + index }),
  );
  return buildBwrapArgv({
    bwrap: '/usr/bin/bwrap',
    command: input.argv,
    cwd: input.cwd,
    readwritePaths: input.readwritePaths,
    readonlyPaths: input.readonlyPaths,
    network: input.network,
    profile: input.profile,
    environment: input.env,
    directoryAuthorities,
    ...(!(input.executableAuthority === undefined) && {
      executableAuthority: {
        path: input.executableAuthority.path,
        childFd: 3 + directoryAuthorities.length,
      },
    }),
  });
}

describe('inheritedHandleCount against what does not use its rule', () => {
  it('is the number counted by hand for each layout', async () => {
    for (const layout of layouts()) {
      const { input, close } = await withHandles(layout);
      try {
        expect([layout.name, inheritedHandleCount(input)]).toEqual([
          layout.name,
          layout.handles,
        ]);
      } finally {
        await close();
      }
    }
  });

  it('is the number of handles the bwrap command line takes', async () => {
    for (const layout of layouts()) {
      const { input, close } = await withHandles(layout);
      try {
        const { backend, seen } = recording();
        await runInSandbox({ ...input, argv: ['/bin/true'], backend });
        const line = bwrapLine(seen[0]!);
        const taken = line.filter((word) =>
          ['--bind-fd', '--ro-bind-fd', '--ro-bind-data'].includes(word),
        );
        expect([layout.name, taken.length]).toEqual([
          layout.name,
          layout.handles,
        ]);
        // Each handle is given to bwrap once: the children number them 3, 4, ...
        const given =
          (seen[0]!.directoryAuthorities?.length ?? 0) +
          (input.executableAuthority === undefined ? 0 : 1);
        expect([layout.name, given]).toEqual([layout.name, layout.handles]);
      } finally {
        await close();
      }
    }
  });

  it('binds every path of a run by its handle, none by its name', async () => {
    // A path bound by name is the path a swap could redirect (ADR 0036).
    for (const layout of layouts()) {
      const { input, close } = await withHandles(layout);
      try {
        const { backend, seen } = recording();
        await runInSandbox({ ...input, argv: ['/bin/true'], backend });
        const line = bwrapLine(seen[0]!);
        const at = (flags: string[], offset: number) =>
          line.flatMap((word, index) =>
            flags.includes(word) ? [line[index + offset]!] : [],
          );
        const byHandle = at(['--bind-fd', '--ro-bind-fd'], 2);
        const byName = at(['--bind', '--ro-bind'], 1);
        const bound = [
          ...seen[0]!.readwritePaths,
          ...seen[0]!.readonlyPaths,
          seen[0]!.cwd,
        ];
        expect([layout.name, bound.filter((p) => byName.includes(p))]).toEqual([
          layout.name,
          [],
        ]);
        expect([
          layout.name,
          bound.filter((p) => !byHandle.includes(p)),
        ]).toEqual([layout.name, []]);
      } finally {
        await close();
      }
    }
  });

  it('is the number of directories a process really holds', async () => {
    // The spawner starts a process with exactly the handles the run was given.
    const program =
      "const fs=require('fs');let n=0;" +
      "for(const f of fs.readdirSync('/proc/self/fd')){if(Number(f)<3)continue;" +
      "try{const to=fs.readlinkSync('/proc/self/fd/'+f);" +
      "if(!to.startsWith('/proc/')&&fs.statSync('/proc/self/fd/'+f).isDirectory())n++}catch{}}" +
      'process.stdout.write(String(n))';
    for (const layout of layouts().filter(({ executable }) => !executable)) {
      const { input, close } = await withHandles(layout);
      try {
        const outcome = await runInSandbox({
          ...input,
          argv: [process.execPath, '-e', program],
          backend: createMockBackend(),
        });
        expect([layout.name, outcome.stderr, outcome.stdout]).toEqual([
          layout.name,
          '',
          String(layout.handles),
        ]);
      } finally {
        await close();
      }
    }
  });
});

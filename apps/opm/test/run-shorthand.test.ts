import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/entry.js';
import { runOpm } from '../src/opm.js';
import { capture, makeProject, report } from './run-fixture.js';
import { makeWorkspace, started, trace } from './workspace-fixture.js';

const never = async (): Promise<number> => {
  throw new Error('the full command line was loaded for a script');
};

const posix = describe.skipIf(process.platform === 'win32');

/** Run `body` with INIT_CWD set to `dir`, as the first opm of a chain would have it. */
async function startedIn<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const before = process.env.INIT_CWD;
  process.env.INIT_CWD = dir;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env.INIT_CWD;
    else process.env.INIT_CWD = before;
  }
}

describe('opm <script>, as pnpm and npm let a word stand for a script', () => {
  it('runs the script of that name, in the entry, with the hooks', async () => {
    const root = await makeProject({
      scripts: {
        prebuild: 'node mark.cjs pre',
        build: 'node mark.cjs main',
        postbuild: 'node mark.cjs post',
      },
    });
    const cap = capture();
    expect(await main(['build'], cap.io, root, never), cap.err).toBe(0);
    expect(
      (await readFile(join(root, 'log.txt'), 'utf8'))
        .split('\n')
        .filter(Boolean),
    ).toEqual(['pre', 'main', 'post']);
  });

  it('gives what follows the word to the script, with or without a --', async () => {
    const root = await makeProject({
      scripts: { show: 'node node_modules/fake-tool/cli.js' },
    });
    for (const [argv, expected] of [
      [
        ['show', 'a', '--watch'],
        ['a', '--watch'],
      ],
      [['show', '--', '--x'], ['--x']],
      [
        ['show', '--', '--', 'y'],
        ['--', 'y'],
      ],
      [
        ['show', '-r', '--filter', 'z'],
        ['-r', '--filter', 'z'],
      ],
    ] as const) {
      const cap = capture();
      expect(await main([...argv], cap.io, root, never), cap.err).toBe(0);
      expect(report(cap.out).argv, argv.join(' ')).toEqual(expected);
    }
  });

  it('starts the executable of that name when there is no such script', async () => {
    const root = await makeProject({});
    const cap = capture();
    expect(
      await main(['fake-tool', 'q', '-x'], cap.io, root, never),
      cap.err,
    ).toBe(0);
    expect(report(cap.out)).toMatchObject({ argv: ['q', '-x'], event: 'exec' });
  });

  it('prefers the script to the executable of the same name', async () => {
    const root = await makeProject({
      scripts: { 'fake-tool': 'node mark.cjs script' },
    });
    expect(await main(['fake-tool'], capture().io, root, never)).toBe(0);
    expect(await readFile(join(root, 'log.txt'), 'utf8')).toBe('script\n');
  });

  it('exits with the script status, as run does', async () => {
    const root = await makeProject({ scripts: { fail: 'node fail.cjs 7' } });
    const cap = capture();
    expect(await main(['fail'], cap.io, root, never)).toBe(7);
    expect(cap.err).toBe('opm: script "fail" exited with code 7\n');
  });

  it('is not tried for a command, a mistyped word or an unknown one', async () => {
    const root = await makeProject({
      scripts: { list: 'node mark.cjs wrong' },
    });
    let handed = 0;
    const other = async () => ((handed += 1), 17);
    expect(await main(['list'], capture().io, root, other)).toBe(17);
    expect(await main(['biuld'], capture().io, root, other)).toBe(17);
    expect(handed).toBe(2);
  });

  it('is reported as an unknown command by the full command line, with a pointer for dlx', async () => {
    const root = await makeProject({});
    const typo = capture();
    expect(await runOpm(['biuld'], typo.io, root)).toBe(2);
    expect(typo.err).toContain('Unknown command: biuld');
    const dlx = capture();
    expect(await runOpm(['dlx', 'cowsay'], dlx.io, root)).toBe(2);
    expect(dlx.err).toContain(
      'Unknown command: dlx. "dlx": opm has no such command',
    );
    expect(dlx.err).toContain('opmx <package> fetches a package');
  });

  it('works through the full command line too', async () => {
    const root = await makeProject({
      scripts: { build: 'node mark.cjs main' },
    });
    const cap = capture();
    expect(await runOpm(['build'], cap.io, root), cap.err).toBe(0);
    expect(await readFile(join(root, 'log.txt'), 'utf8')).toBe('main\n');
  });
});

posix('pnpm option order: opm --filter <selector> <script>', () => {
  async function workspace() {
    return await makeWorkspace({
      'packages/a': {
        name: '@s/a',
        dependencies: { '@s/b': 'workspace:*' },
        scripts: { build: trace('a') },
      },
      'packages/b': { name: '@s/b', scripts: { build: trace('b') } },
    });
  }

  it('opm --filter <name> <script> runs it in that member', async () => {
    const ws = await workspace();
    const cap = capture();
    const status = await startedIn(ws.root, () =>
      main(['--filter', '@s/b', 'build'], cap.io, ws.root, never),
    );
    expect(status, cap.err).toBe(0);
    expect(started(await ws.log())).toEqual(['b']);
  });

  it('opm --filter <name>... run <script> and opm -r <script> run in dependency order', async () => {
    for (const argv of [
      ['--filter', '@s/a...', 'run', 'build', '--workspace-concurrency=1'],
      ['-r', 'build', '--', 'ignored'],
      ['-r', 'run', 'build'],
    ]) {
      const ws = await workspace();
      const cap = capture();
      const status = await startedIn(ws.root, () =>
        main(argv, cap.io, ws.root, never),
      );
      expect(status, `${argv.join(' ')}: ${cap.err}`).toBe(0);
      expect(started(await ws.log()).sort()).toEqual(['a', 'b']);
    }
  });

  it('opm --filter <name> exec <bin> runs the bin in that member', async () => {
    const ws = await workspace();
    const cap = capture();
    expect(
      await main(
        ['--filter', '@s/b', 'exec', 'fake-tool', 'z'],
        cap.io,
        ws.root,
        never,
      ),
      cap.err,
    ).toBe(0);
    expect(report(cap.out)).toMatchObject({
      name: '@s/b',
      argv: ['z'],
      cwd: join(ws.root, 'packages', 'b'),
    });
  });

  it('opm -r <bin> falls back to the bin when no member has such a script', async () => {
    const ws = await workspace();
    const cap = capture();
    expect(
      await main(
        ['--filter', '@s/b', 'fake-tool', 'q'],
        cap.io,
        ws.root,
        never,
      ),
      cap.err,
    ).toBe(0);
    expect(report(cap.out)).toMatchObject({
      name: '@s/b',
      argv: ['q'],
      event: 'exec',
    });
  });

  it('works through the full command line, and -C names the project directory', async () => {
    const ws = await workspace();
    const here = capture();
    const status = await startedIn(ws.root, () =>
      runOpm(
        ['-C', ws.root, '--filter', '@s/b', 'run', 'build'],
        here.io,
        join(ws.root, 'packages'),
      ),
    );
    expect(status, here.err).toBe(0);
    expect(started(await ws.log())).toEqual(['b']);
  });

  it('refuses pnpm -w (the root) with a pointer to --workspace-root', async () => {
    const ws = await workspace();
    const cap = capture();
    expect(await main(['-w', 'run', 'build'], cap.io, ws.root, never)).toBe(2);
    expect(cap.err).toContain('--workspace-root');
  });

  it('refuses an option pnpm has and opm does not, by name', async () => {
    const ws = await workspace();
    const cap = capture();
    expect(
      await main(['-r', 'run', 'build', '--no-bail'], cap.io, ws.root, never),
    ).toBe(2);
    expect(cap.err).toContain('--no-bail is not supported');
  });
});

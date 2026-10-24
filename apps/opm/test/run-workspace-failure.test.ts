import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChildHost } from '../src/commands/run-child.js';
import {
  contextWith,
  go,
  hostWithSignals,
  makeWorkspace,
  started,
  trace,
  until,
} from './workspace-fixture.js';

const posix = describe.skipIf(process.platform === 'win32');

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

posix('a failing member', () => {
  it('ends the run with that member status, names it, and starts nothing that waited for it', async () => {
    const ws = await makeWorkspace({
      'packages/a': {
        name: '@s/a',
        dependencies: { '@s/b': 'workspace:*' },
        scripts: { build: trace('a') },
      },
      'packages/b': {
        name: '@s/b',
        dependencies: { '@s/c': 'workspace:*' },
        scripts: { build: trace('b', 0, 3) },
      },
      'packages/c': { name: '@s/c', scripts: { build: trace('c') } },
    });
    const ran = await go(
      'run',
      ['build', '-r', '--workspace-concurrency=1'],
      ws.root,
    );
    expect(ran.status).toBe(3);
    expect(ran.err).toBe('opm: script "build" of @s/b exited with code 3\n');
    expect(started(await ws.log())).toEqual(['c', 'b']);
  });

  it('is the exit status of the member whatever it is', async () => {
    for (const code of [1, 2, 42, 255]) {
      const ws = await makeWorkspace({
        'packages/a': { name: 'a', scripts: { build: trace('a', 0, code) } },
        'packages/b': { name: 'b', scripts: { build: trace('b', 400) } },
      });
      const ran = await go('run', ['build', '-r'], ws.root);
      expect(ran.status, `code ${code}`).toBe(code);
    }
  });

  it('stops a hook failing the way it stops the run: no later step of that member', async () => {
    const ws = await makeWorkspace({
      'packages/a': {
        name: 'a',
        scripts: {
          prebuild: trace('a-pre', 0, 5),
          build: trace('a'),
          postbuild: trace('a-post'),
        },
      },
      'packages/b': { name: 'b', scripts: { build: trace('b', 300) } },
    });
    const ran = await go('run', ['build', '-r'], ws.root);
    expect(ran.status).toBe(5);
    expect(ran.err).toContain('script "prebuild" of a exited with code 5');
    expect(started(await ws.log())).not.toContain('a');
    expect(started(await ws.log())).not.toContain('a-post');
  });

  it('tells the members still running to end, and does not wait for them to finish', async () => {
    const ws = await makeWorkspace({
      'packages/fails': {
        name: 'fails',
        scripts: { build: trace('fails', 0, 7, ['slow']) },
      },
      'packages/slow': {
        name: 'slow',
        scripts: { build: trace('slow', 20_000) },
      },
    });
    const ran = await go(
      'run',
      ['build', '-r', '--workspace-concurrency=2'],
      ws.root,
      contextWith({}, { host: hostWithSignals().host }),
    );
    expect(ran.status).toBe(7);
    // `slow` was told to end and ended by it: a run that waited for it to
    // finish would find it ended by itself, twenty seconds on.
    const log = await ws.log();
    expect(log.some(([what, id]) => what === 'term' && id === 'slow')).toBe(
      true,
    );
    expect(log.some(([what, id]) => what === 'end' && id === 'slow')).toBe(
      false,
    );
  });

  it('reports a member that cannot be started, exits 8, and stops the rest', async () => {
    const ws = await makeWorkspace({
      'packages/a': { name: 'a', scripts: { build: trace('a', 5000) } },
      'packages/b': { name: 'b', scripts: { build: trace('b') } },
    });
    let spawned = 0;
    const base = hostWithSignals().host;
    const host: ChildHost = {
      ...base,
      spawn: ((...args: Parameters<typeof base.spawn>) => {
        spawned += 1;
        if (spawned === 2) throw new Error('spawn EAGAIN');
        return base.spawn(...args);
      }) as typeof base.spawn,
    };
    const ran = await go(
      'run',
      ['build', '-r', '--workspace-concurrency=2'],
      ws.root,
      contextWith({}, { host }),
    );
    expect(ran.status).toBe(8);
    expect(ran.err).toContain('Cannot start script "build"');
    expect(ran.err).toContain('spawn EAGAIN');
  });
});

posix('signals', () => {
  it('reach every running member through one subscription, and nothing more is started', async () => {
    const ws = await makeWorkspace({
      'packages/a': { name: 'a', scripts: { build: trace('a', 20_000) } },
      'packages/b': { name: 'b', scripts: { build: trace('b', 20_000) } },
      'packages/c': { name: 'c', scripts: { build: trace('c', 20_000) } },
      'packages/d': {
        name: 'd',
        dependencies: { a: 'workspace:*' },
        scripts: { build: trace('d') },
      },
    });
    const { host, signals } = hostWithSignals();
    const running = go(
      'run',
      ['build', '-r', '--workspace-concurrency=3'],
      ws.root,
      contextWith({}, { host }),
    );
    await until(async () => started(await ws.log()).length === 3);
    expect(signals.listenerCount('SIGTERM')).toBe(1);
    signals.emit('SIGTERM');
    const ran = await running;
    const log = await ws.log();
    expect(
      log
        .filter(([what]) => what === 'term')
        .map(([, id]) => id)
        .sort(),
    ).toEqual(['a', 'b', 'c']);
    expect(started(log)).not.toContain('d');
    expect(ran.status).toBe(143);
    // The members the signal ended are not reported as members that failed.
    expect(ran.err).toBe('');
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  it('forward SIGINT and SIGHUP too, and the status is 128 plus the signal', async () => {
    for (const [signal, status] of [
      ['SIGINT', 130],
      ['SIGHUP', 129],
    ] as const) {
      const ws = await makeWorkspace({
        'packages/a': { name: 'a', scripts: { build: trace('a', 20_000) } },
        'packages/b': { name: 'b', scripts: { build: trace('b', 20_000) } },
      });
      const { host, signals } = hostWithSignals();
      const running = go(
        'run',
        ['build', '-r'],
        ws.root,
        contextWith({}, { host }),
      );
      await until(async () => started(await ws.log()).length === 2);
      signals.emit(signal);
      const ran = await running;
      // trace.cjs handles SIGTERM only; these end the child by default action.
      const log = await ws.log();
      expect(
        log.some(([w]) => w === 'end'),
        signal,
      ).toBe(false);
      expect(ran.status, signal).toBe(status);
    }
  });

  it('end a grandchild of a member too, when there is no terminal', async () => {
    const ws = await makeWorkspace({
      'packages/a': {
        name: 'a',
        scripts: {
          build: `sh -c 'sleep 30 & echo $! > "$INIT_CWD/pid-a"; wait'`,
        },
      },
      'packages/b': {
        name: 'b',
        scripts: {
          build: `sh -c 'sleep 30 & echo $! > "$INIT_CWD/pid-b"; wait'`,
        },
      },
    });
    const { host, signals } = hostWithSignals();
    const running = go(
      'run',
      ['build', '-r', '--workspace-concurrency=2'],
      ws.root,
      contextWith({}, { host }),
    );
    await until(
      async () =>
        existsSync(join(ws.root, 'pid-a')) &&
        existsSync(join(ws.root, 'pid-b')),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { readFileSync } = await import('node:fs');
    const pids = ['a', 'b'].map((id) =>
      Number(readFileSync(join(ws.root, `pid-${id}`), 'utf8')),
    );
    signals.emit('SIGTERM');
    await running;
    for (const pid of pids)
      await until(async () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
  });
});

posix('a link in the workspace', () => {
  async function outsideScript() {
    const outside = await realpath(
      await mkdtemp(join(tmpdir(), 'opm-outside-')),
    );
    temps.push(outside);
    await writeFile(
      join(outside, 'package.json'),
      JSON.stringify({
        name: 'evil',
        scripts: { build: `echo pwned > ${join(outside, 'marker')}` },
      }),
    );
    return outside;
  }

  it('is refused when a pattern selects a symbolic link as a member, and its script never runs', async () => {
    const outside = await outsideScript();
    const ws = await makeWorkspace({
      'packages/ok': { name: 'ok', scripts: { build: 'true' } },
    });
    await symlink(outside, join(ws.root, 'packages', 'evil'));
    const ran = await go('run', ['build', '-r'], ws.root);
    expect(ran.status).toBe(3);
    expect(ran.err).toContain('packages/evil');
    expect(ran.err).toMatch(/symbolic link/u);
    expect(existsSync(join(outside, 'marker'))).toBe(false);
  });

  it('is passed over when a ** searches past it, and its script never runs', async () => {
    const outside = await outsideScript();
    const ws = await makeWorkspace(
      {
        'packages/ok': { name: 'ok', scripts: { build: 'echo fine' } },
        'packages/two': { name: 'two', scripts: { build: 'true' } },
      },
      { patterns: ['packages/**'] },
    );
    await symlink(outside, join(ws.root, 'packages', 'evil'));
    const ran = await go('run', ['build', '-r'], ws.root);
    expect(ran.status, ran.err).toBe(0);
    expect(existsSync(join(outside, 'marker'))).toBe(false);
  });

  it('is refused when a directory on the way to the members is the link', async () => {
    const outside = await realpath(
      await mkdtemp(join(tmpdir(), 'opm-outside-')),
    );
    temps.push(outside);
    await mkdir(join(outside, 'x'));
    await writeFile(
      join(outside, 'x', 'package.json'),
      JSON.stringify({
        name: 'x',
        scripts: { build: `echo pwned > ${join(outside, 'marker')}` },
      }),
    );
    const ws = await makeWorkspace({}, { patterns: ['linked/*'] });
    await symlink(outside, join(ws.root, 'linked'));
    const ran = await go('run', ['build', '-r'], ws.root);
    expect(ran.status).toBe(3);
    expect(existsSync(join(outside, 'marker'))).toBe(false);
  });

  it('is refused by --filter too: selecting the name of a linked member runs nothing', async () => {
    const outside = await outsideScript();
    const ws = await makeWorkspace({});
    await symlink(outside, join(ws.root, 'packages'));
    const ran = await go('run', ['build', '--filter', 'evil'], ws.root);
    expect(ran.status, ran.err).toBe(3);
    expect(ran.err).toContain('packages');
    expect(existsSync(join(outside, 'marker'))).toBe(false);
  });
});

posix('what is never printed', () => {
  it('keeps the environment out of a failed run, a refusal and a spawn error', async () => {
    const token = 'vtok_dummy_marker_0123456789abcdef';
    const ws = await makeWorkspace({
      'packages/a': { name: 'a', scripts: { build: trace('a', 0, 4) } },
      'packages/b': { name: 'b', scripts: { build: trace('b', 300) } },
    });
    const context = contextWith({ OPM_TEST_TOKEN: token });
    for (const argv of [
      ['build', '-r'],
      ['build', '--filter', 'nobody'],
      ['nothing', '-r'],
      ['build', '-w', 'x'],
    ]) {
      const ran = await go('run', argv, ws.root, context);
      expect(ran.out + ran.err, argv.join(' ')).not.toContain(token);
    }
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exitStatus, runChild, startChild } from '../src/commands/run-child.js';
import {
  alive,
  capture,
  node,
  testHost,
  waitFor,
} from './run-child-fixture.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('exitStatus', () => {
  it('is the code, or 128 plus the signal number', () => {
    expect(exitStatus({ code: 7, signal: undefined })).toBe(7);
    expect(exitStatus({ code: 0, signal: undefined })).toBe(0);
    expect(exitStatus({ code: undefined, signal: 'SIGTERM' })).toBe(143);
    expect(exitStatus({ code: undefined, signal: 'SIGINT' })).toBe(130);
    expect(exitStatus({ code: undefined, signal: 'SIGKILL' })).toBe(137);
  });
});

describe('runChild', () => {
  it('reports the exit code exactly', async () => {
    for (const code of [0, 1, 2, 7, 42, 255]) {
      const outcome = await runChild(
        node(['-e', `process.exit(${code})`]),
        capture().io,
      );
      expect(outcome).toEqual({ code, signal: undefined });
    }
  });

  it('writes the child output to the streams it was given', async () => {
    const cap = capture();
    await runChild(
      node(['-e', "console.log('héllo out'); console.error('err line')"]),
      cap.io,
    );
    expect(cap.out).toBe('héllo out\n');
    expect(cap.err).toBe('err line\n');
  });

  it.skipIf(process.platform === 'win32')(
    'reports the signal that ended the child',
    async () => {
      const outcome = await runChild(
        node(['-e', "process.kill(process.pid, 'SIGTERM')"]),
        capture().io,
      );
      expect(outcome).toEqual({ code: undefined, signal: 'SIGTERM' });
      expect(exitStatus(outcome)).toBe(143);
    },
  );

  it('fails with a message that names the command when it cannot start', async () => {
    const spec = node([]);
    spec.plan.file = join(tmpdir(), 'opm-no-such-program-xyz');
    await expect(runChild(spec, capture().io)).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: expect.stringContaining('Cannot start test child'),
    });
  });

  it('never puts the environment in an error', async () => {
    const spec = node([]);
    spec.plan.file = join(tmpdir(), 'opm-no-such-program-xyz');
    spec.env.OPM_TEST_TOKEN = 'vtok_dummy_marker_0123456789abcdef';
    const error = await runChild(spec, capture().io).catch(
      (caught: unknown) => caught,
    );
    expect(String(error)).not.toContain('vtok_dummy_marker');
  });

  it('removes its signal listeners when the child ends', async () => {
    const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) =>
      process.listenerCount(signal),
    );
    await runChild(node(['-e', '0']), capture().io);
    expect(
      ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) =>
        process.listenerCount(signal),
      ),
    ).toEqual(before);
  });
});

describe.skipIf(process.platform === 'win32')('signal forwarding', () => {
  /**
   * A child that starts a grandchild, records the grandchild's pid, and then
   * waits. Neither handles a signal, so either one ends on SIGTERM.
   */
  async function familyFixture() {
    const dir = await mkdtemp(join(tmpdir(), 'opm-run-child-'));
    temps.push(dir);
    const script = join(dir, 'family.cjs');
    const pidFile = join(dir, 'grandchild.pid');
    await writeFile(
      script,
      [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync } = require('node:fs');",
        "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        'writeFileSync(process.argv[2], String(g.pid));',
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    return { script, pidFile };
  }

  const grandchildPid = (pidFile: string) =>
    Number(readFileSync(pidFile, 'utf8'));

  it('sends a signal to the whole group when no terminal is attached', async () => {
    const { script, pidFile } = await familyFixture();
    const { host, signals } = testHost(false);
    const running = runChild(node([script, pidFile]), capture().io, host);
    await waitFor(() => existsSync(pidFile));
    const grandchild = grandchildPid(pidFile);
    expect(alive(grandchild)).toBe(true);

    signals.emit('SIGTERM');
    const outcome = await running;

    expect(outcome.signal).toBe('SIGTERM');
    expect(exitStatus(outcome)).toBe(143);
    await waitFor(() => !alive(grandchild));
  });

  it('forwards SIGINT and SIGHUP to the group as well', async () => {
    for (const signal of ['SIGINT', 'SIGHUP'] as const) {
      const { script, pidFile } = await familyFixture();
      const { host, signals } = testHost(false);
      const running = runChild(node([script, pidFile]), capture().io, host);
      await waitFor(() => existsSync(pidFile));
      const grandchild = grandchildPid(pidFile);
      signals.emit(signal);
      expect((await running).signal).toBe(signal);
      await waitFor(() => !alive(grandchild));
    }
  });

  it('with a terminal, leaves SIGINT to the terminal and sends SIGTERM to the child only', async () => {
    const { script, pidFile } = await familyFixture();
    const { host, signals } = testHost(true);
    const running = runChild(node([script, pidFile]), capture().io, host);
    await waitFor(() => existsSync(pidFile));
    const grandchild = grandchildPid(pidFile);
    try {
      let settled = false;
      void running.then(() => {
        settled = true;
      });

      signals.emit('SIGINT');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);

      signals.emit('SIGTERM');
      expect((await running).signal).toBe('SIGTERM');
      // The grandchild is in the terminal's group, not signalled by opm.
      expect(alive(grandchild)).toBe(true);
    } finally {
      try {
        process.kill(grandchild, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });

  it('ignores a signal that arrives after the child has gone', async () => {
    const { host, signals } = testHost(false);
    await runChild(node(['-e', '0']), capture().io, host);
    expect(signals.emit('SIGTERM')).toBe(false);
  });
});

describe('startChild', () => {
  it('gives a child with stdin ignored an empty input instead of the parent terminal', async () => {
    const spec = node([
      '-e',
      "process.stdin.on('data', () => {}).on('end', () => console.log('eof'))",
    ]);
    spec.stdin = 'ignore';
    const cap = capture();
    const outcome = await startChild(spec, cap.io).outcome;
    expect(outcome.code).toBe(0);
    expect(cap.out).toBe('eof\n');
  });

  it.skipIf(process.platform === 'win32')(
    'signals one child by the same rules a signal sent to opm follows, and does not subscribe the process',
    async () => {
      const before = process.listenerCount('SIGTERM');
      const { host } = testHost(false);
      const running = startChild(
        node(['-e', 'setInterval(() => {}, 1000)']),
        capture().io,
        host,
      );
      expect(process.listenerCount('SIGTERM')).toBe(before);
      running.signal('SIGTERM');
      expect((await running.outcome).signal).toBe('SIGTERM');
      // A child that has ended is left alone.
      running.signal('SIGTERM');
    },
  );

  it('rejects, rather than throws, when the program cannot start', async () => {
    const spec = node([]);
    spec.plan.file = join(tmpdir(), 'opm-no-such-program-xyz');
    const running = startChild(spec, capture().io);
    await expect(running.outcome).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    running.signal('SIGTERM');
  });
});

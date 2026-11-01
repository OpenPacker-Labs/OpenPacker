import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startChild } from '../src/commands/run-child.js';
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

const grandchildPid = (pidFile: string) =>
  Number(readFileSync(pidFile, 'utf8'));

describe.skipIf(process.platform === 'win32')(
  'a child that is handed none of the terminal',
  () => {
    /**
     * A child that starts a grandchild which keeps the child's output pipes (as
     * `sleep` does under `sh -c 'sleep 30 & wait'`), records its pid and waits.
     */
    async function pipeHolderFixture() {
      const dir = await mkdtemp(join(tmpdir(), 'opm-run-child-'));
      temps.push(dir);
      const script = join(dir, 'holder.cjs');
      const pidFile = join(dir, 'holder.pid');
      await writeFile(
        script,
        [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
          'writeFileSync(process.argv[2], String(g.pid));',
          'setInterval(() => {}, 1000);',
        ].join('\n'),
      );
      return { script, pidFile };
    }

    /** Whether `running` ended within `ms`; a grandchild still holding the pipes keeps it from closing. */
    async function endedWithin(
      running: { outcome: Promise<unknown> },
      ms: number,
    ): Promise<boolean> {
      return await Promise.race([
        running.outcome.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
      ]);
    }

    it('with a terminal on opm, still gives a child that is handed none of it a group of its own', async () => {
      const { script, pidFile } = await pipeHolderFixture();
      const { host } = testHost(true);
      const spec = node([script, pidFile]);
      spec.stdin = 'ignore';
      const running = startChild(spec, capture().io, host);
      await waitFor(() => existsSync(pidFile));
      const holder = grandchildPid(pidFile);
      try {
        running.signal('SIGTERM');
        expect(
          await endedWithin(running, 6000),
          'the run waited for a descendant that holds the output pipes',
        ).toBe(true);
        expect((await running.outcome).signal).toBe('SIGTERM');
        await waitFor(() => !alive(holder));
      } finally {
        running.signal('SIGKILL');
        try {
          process.kill(holder, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }, 15_000);

    it('forwards SIGINT to such a child, since the terminal signals opm and not a group it is not in', async () => {
      const { script, pidFile } = await pipeHolderFixture();
      const { host } = testHost(true);
      const spec = node([script, pidFile]);
      spec.stdin = 'ignore';
      const running = startChild(spec, capture().io, host);
      await waitFor(() => existsSync(pidFile));
      const holder = grandchildPid(pidFile);
      try {
        running.signal('SIGINT');
        expect(await endedWithin(running, 6000)).toBe(true);
        expect((await running.outcome).signal).toBe('SIGINT');
        await waitFor(() => !alive(holder));
      } finally {
        running.signal('SIGKILL');
        try {
          process.kill(holder, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }, 15_000);

    it('with a terminal and the child reading stdin, leaves the group to the terminal as before', async () => {
      const { script, pidFile } = await pipeHolderFixture();
      const { host } = testHost(true);
      const running = startChild(node([script, pidFile]), capture().io, host);
      await waitFor(() => existsSync(pidFile));
      const holder = grandchildPid(pidFile);
      try {
        running.signal('SIGTERM');
        // The child is gone but its grandchild is in the terminal's group and holds the pipes.
        expect(await endedWithin(running, 1500)).toBe(false);
        expect(alive(holder)).toBe(true);
      } finally {
        process.kill(holder, 'SIGKILL');
        await running.outcome;
      }
    });
  },
);

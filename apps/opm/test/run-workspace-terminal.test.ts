import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChildHost } from '../src/commands/run-child.js';
import {
  contextWith,
  go,
  hostWithSignals,
  makeWorkspace,
  until,
} from './workspace-fixture.js';

const posix = describe.skipIf(process.platform === 'win32');

posix('a failing member, with a terminal on opm', () => {
  it('with a terminal on opm, ends what a stopped member started and returns at once', async () => {
    // `sleep` keeps the member's output pipes: without a group of its own the
    // member's SIGTERM left it running, `close` never came, and opm waited.
    const ws = await makeWorkspace({
      'packages/a': {
        name: 'a',
        scripts: {
          go: `sh -c 'sleep 20 & echo $! > "$INIT_CWD/pid-a"; wait'`,
        },
      },
      'packages/b': {
        name: 'b',
        scripts: {
          go: `sh -c 'while [ ! -f "$INIT_CWD/pid-a" ]; do sleep 0.05; done; exit 7'`,
        },
      },
    });
    const host: ChildHost = { ...hostWithSignals().host, hasTerminal: true };
    const before = Date.now();
    try {
      const ran = await go(
        'run',
        ['go', '-r', '--workspace-concurrency=2'],
        ws.root,
        contextWith({}, { host }),
      );
      expect(ran.status).toBe(7);
      expect(
        Date.now() - before,
        'the run waited for the sleep a stopped member started',
      ).toBeLessThan(10_000);
      const pid = Number(readFileSync(join(ws.root, 'pid-a'), 'utf8'));
      await until(async () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
    } finally {
      try {
        process.kill(Number(readFileSync(join(ws.root, 'pid-a'), 'utf8')), 9);
      } catch {
        // gone, as it should be
      }
    }
  });
});

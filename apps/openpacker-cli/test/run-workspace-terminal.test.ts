import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChildHost } from '../src/commands/run-child.js';
import {
  contextWith,
  go,
  hostWithSignals,
  makeWorkspace,
  trace,
  until,
} from './workspace-fixture.js';

const posix = describe.skipIf(process.platform === 'win32');

posix('a failing member, with a terminal on opm', () => {
  it('with a terminal on opm, ends what a stopped member started and returns at once', async () => {
    // What `a` starts in the background keeps the member's output pipes:
    // without a group of its own the member's SIGTERM left it running, `close`
    // never came, and opm waited for it. It is `trace`, so how it ended is in
    // the log: `term` when the run ends it, `end` when it ran its twenty
    // seconds out because the run waited for it.
    const ws = await makeWorkspace({
      'packages/a': {
        name: 'a',
        scripts: {
          go: `sh -c '${trace('held', 20_000)} & echo $! > "$INIT_CWD/pid-a"; wait'`,
        },
      },
      'packages/b': {
        name: 'b',
        scripts: {
          go: `sh -c 'while [ ! -f "$INIT_CWD/started-held" ]; do sleep 0.05; done; exit 7'`,
        },
      },
    });
    const host: ChildHost = { ...hostWithSignals().host, hasTerminal: true };
    try {
      const ran = await go(
        'run',
        ['go', '-r', '--workspace-concurrency=2'],
        ws.root,
        contextWith({}, { host }),
      );
      expect(ran.status).toBe(7);
      // No clock is read: the log says whether the run ended what the stopped
      // member started or waited for it to end on its own.
      const held = (await ws.log()).filter(([, id]) => id === 'held');
      expect(
        held.map(([what]) => what),
        'the run waited for what a stopped member started',
      ).toEqual(['start', 'term']);
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

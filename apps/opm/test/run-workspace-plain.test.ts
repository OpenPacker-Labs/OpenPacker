import { describe, expect, it } from 'vitest';
import { HOSTILE, lines, violations } from './plain-fixture.js';
import { go, makeWorkspace } from './workspace-fixture.js';

const posix = describe.skipIf(process.platform === 'win32');

/**
 * A member's directory is named by whoever made the repository, and a run over
 * several members starts every line of their output with it (a member with no
 * name is shown by its directory) and names it when one fails. So the label is
 * one plain line: no line opm writes looks like opm's own after a line break,
 * and none holds a character a terminal acts on. What the child itself writes
 * after the label is the child's, passed through as a single run passes it.
 */
posix('opm run across members a repository named', () => {
  // A directory name can hold anything but a slash and a NUL.
  const directory = (text: string) => `packages/m${text.replaceAll('/', '_')}`;

  async function run(text: string, script: string) {
    const ws = await makeWorkspace({
      [directory(text)]: { scripts: { talk: script } },
      'packages/other': { name: 'other', scripts: { talk: 'echo other' } },
    });
    return await go(
      'run',
      ['talk', '-r', '--workspace-concurrency=1'],
      ws.root,
    );
  }

  it.each([
    ['writes', 'echo out; echo err >&2'],
    ['fails', 'echo out; exit 3'],
  ])(
    'labels the lines of a member that %s on one plain line',
    async (_, script) => {
      const innocent = await run('x', script);
      const hostile = await run(HOSTILE, script);
      expect(hostile.status, hostile.err).toBe(innocent.status);
      for (const stream of ['out', 'err'] as const) {
        expect(violations(hostile[stream])).toEqual([]);
        expect(lines(hostile[stream])).toBe(lines(innocent[stream]));
      }
    },
  );
});

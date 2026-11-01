import { describe, expect, it } from 'vitest';
import { main } from '../src/entry.js';
import { capture, makeProject, report } from './run-fixture.js';

const never = async (): Promise<number> => {
  throw new Error('the library was loaded for a command that does not need it');
};

// A failure is reported through the full CLI's handleError, which main()
// imports on the first failure: the whole opm module graph, seconds to
// transform and load under a loaded machine. It is loaded here, while the file
// is collected, so that no test's time budget holds a one-time load.
await import('../src/opm.js');

describe('the process entry', () => {
  it('answers run and exec itself', async () => {
    const root = await makeProject({
      scripts: { show: 'node node_modules/fake-tool/cli.js' },
    });
    const run = capture();
    expect(await main(['run', 'show', '--', 'a'], run.io, root, never)).toBe(0);
    expect(report(run.out).argv).toEqual(['a']);
    const exec = capture();
    expect(await main(['exec', 'fake-tool', 'b'], exec.io, root, never)).toBe(
      0,
    );
    expect(report(exec.out).argv).toEqual(['b']);
  });

  it('reports a failure with the same exit codes as the full CLI', async () => {
    const root = await makeProject({});
    for (const [argv, code] of [
      [['run', 'nope'], 4],
      [['exec', 'nope'], 4],
      [['run', 'x', '--watch'], 2],
      [['exec'], 2],
      [['exec', './x'], 2],
    ] as const) {
      const cap = capture();
      expect(await main(argv, cap.io, root, never), argv.join(' ')).toBe(code);
      expect(cap.err).toMatch(/^opm: |Unknown option/u);
    }
  });

  it('refuses a workspace option before a command that does not take it, instead of handing it to the full CLI', async () => {
    const root = await makeProject({});
    for (const argv of [
      ['--filter', 'a', 'sync'],
      ['-r', 'install'],
    ]) {
      const cap = capture();
      let handed = false;
      const status = await main(argv, cap.io, root, async () => {
        handed = true;
        return 0;
      });
      expect(handed, argv.join(' ')).toBe(false);
      expect(status, argv.join(' ')).toBe(2);
      expect(cap.err).toContain('does not take it');
    }
  });

  it('hands every other command, and a help request, to the full CLI', async () => {
    const root = await makeProject({});
    for (const argv of [
      ['list'],
      ['--help'],
      ['run', '--help'],
      ['exec', '-h'],
      [],
      ['--offline', 'run', 'x'],
    ]) {
      let handed = false;
      const status = await main(argv, capture().io, root, async () => {
        handed = true;
        return 17;
      });
      expect(handed, argv.join(' ')).toBe(true);
      expect(status).toBe(17);
    }
  });

  it('gives --help after the bin to the bin', async () => {
    const root = await makeProject({});
    const cap = capture();
    expect(
      await main(['exec', 'fake-tool', '--help'], cap.io, root, never),
    ).toBe(0);
    expect(report(cap.out).argv).toEqual(['--help']);
  });
});

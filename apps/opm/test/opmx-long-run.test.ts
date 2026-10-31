import { describe, expect, it } from 'vitest';
import { runOpmx } from '../src/opmx.js';
import {
  INSTALLED_TIMEOUT_MS,
  binPackage,
  capture,
  installedProject,
} from './installed-fixture.js';
import { canSandbox } from './signal-fixture.js';

/**
 * opmx runs a tool someone started, as npx does: it runs until it ends or is
 * stopped, and all it writes reaches the terminal. The sandbox ended every
 * tool after ten minutes (the default `timeout_ms`, which is for what runs
 * unattended), and after 1 MiB of stdout or 2 MiB of output in all, so a
 * server was ended by its own log. A limit the project or the command line
 * sets still holds: `--timeout`, else `opmx_timeout_ms`, else `timeout_ms`.
 */

const MiB = 1024 * 1024;

/**
 * `chatty` writes 3 MiB to stdout and 1.5 MiB to stderr, waiting for each
 * write to be taken, and says it is done.
 */
const chatty = binPackage(
  'chatty',
  `const line = 'x'.repeat(1023) + '\\n';
const write = (stream, left, then) =>
  left === 0 ? then() : stream.write(line, () => write(stream, left - 1, then));
write(process.stdout, 3 * 1024, () =>
  write(process.stderr, 1536, () => process.stdout.write('done\\n')));
`,
);

/** `forever` says it is up and runs until it is ended. */
const forever = binPackage(
  'forever',
  "process.stdout.write('up\\n');\nsetInterval(() => {}, 1000);\n",
);

describe.runIf(canSandbox)(
  'opmx runs a tool for as long as it runs',
  { timeout: INSTALLED_TIMEOUT_MS },
  () => {
    it('writing past the byte limits, to its end', async () => {
      // What used to end it at 1 MiB, exit 125.
      const root = await installedProject([chatty]);
      const cap = capture();
      expect(await runOpmx(['chatty'], cap.io, root), cap.seen.err).toBe(0);
      expect(cap.seen.out.length).toBe(3 * MiB + 'done\n'.length);
      expect(cap.seen.out.endsWith('x\ndone\n')).toBe(true);
      // Nothing but the tool's own output, and no word from the sandbox.
      expect(cap.seen.err).toBe(`${'x'.repeat(1023)}\n`.repeat(1536));
    });

    it('until the project’s opmx_timeout_ms, which ends it', async () => {
      const root = await installedProject(
        [forever],
        '[sandbox]\nopmx_timeout_ms = 500',
      );
      const cap = capture();
      expect(await runOpmx(['forever'], cap.io, root)).toBe(124);
      // Whether the tool had started by then is the machine's business.
      expect(cap.seen.err).toBe(
        '\nopenpacker sandbox: process timed out after 500 ms\n',
      );
    });

    it('until the project’s timeout_ms, when it sets that and no opmx_timeout_ms', async () => {
      const root = await installedProject(
        [forever],
        '[sandbox]\ntimeout_ms = 400',
      );
      const cap = capture();
      expect(await runOpmx(['forever'], cap.io, root)).toBe(124);
      // Whether the tool had started by then is the machine's business.
      expect(cap.seen.err).toBe(
        '\nopenpacker sandbox: process timed out after 400 ms\n',
      );
    });

    it('until --timeout, which wins over the project’s', async () => {
      const root = await installedProject(
        [forever],
        '[sandbox]\nopmx_timeout_ms = 600000',
      );
      const cap = capture();
      expect(await runOpmx(['--timeout', '400', 'forever'], cap.io, root)).toBe(
        124,
      );
      // Whether the tool had started by then is the machine's business.
      expect(cap.seen.err).toBe(
        '\nopenpacker sandbox: process timed out after 400 ms\n',
      );
    });
  },
);

describe.skipIf(canSandbox)('opmx runs a tool for as long as it runs', () => {
  it.skip('needs bwrap (/usr/bin/bwrap); not checked on this host', () => {});
});

describe('opmx --timeout', () => {
  it.each(['abc', '-5', '1.5', '2147483648'])(
    'refuses %s with exit 2 and what it takes',
    async (value) => {
      const cap = capture();
      expect(await runOpmx(['--timeout', value, 'forever'], cap.io, '/')).toBe(
        2,
      );
      expect(cap.seen.err).toContain(
        `--timeout takes whole milliseconds from 0 (no limit) to 2147483647, not ${JSON.stringify(value)}`,
      );
    },
  );

  it('refuses to go without a value', async () => {
    const cap = capture();
    expect(await runOpmx(['--timeout'], cap.io, '/')).toBe(2);
    expect(cap.seen.err).toContain(
      'opmx --timeout requires a number of milliseconds (0 for none)',
    );
  });

  it('is read before the tool’s name, and is the tool’s own after it', async () => {
    const { parseForTest } = await import('../src/opmx.js');
    expect(parseForTest(['--timeout=250', 'tool', '--timeout', '9'])).toEqual(
      expect.objectContaining({
        timeoutMs: 250,
        positionals: ['tool'],
        passthrough: ['--timeout', '9'],
      }),
    );
  });
});

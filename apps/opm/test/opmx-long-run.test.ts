import { describe, expect, it } from 'vitest';
import { runOpmx } from '../src/opmx.js';
import { binPackage, capture, installedProject } from './installed-fixture.js';
import { canSandbox } from './signal-fixture.js';

/**
 * opmx runs a tool someone started, as npx does: it runs until it ends or is
 * stopped, and all it writes reaches the terminal. The sandbox ended every
 * tool after ten minutes (the project's `timeout_ms`, which is for an
 * install's lifecycle scripts), and after 1 MiB of stdout or 2 MiB of output
 * in all, so a server was ended by its own log.
 */

const MiB = 1024 * 1024;

/**
 * `chatty` writes 3 MiB to stdout and 1.5 MiB to stderr, waiting for each
 * write to be taken, then runs on for 1.5 s and says it is done.
 */
const chatty = binPackage(
  'chatty',
  `const line = 'x'.repeat(1023) + '\\n';
const write = (stream, left, then) =>
  left === 0 ? then() : stream.write(line, () => write(stream, left - 1, then));
write(process.stdout, 3 * 1024, () =>
  write(process.stderr, 1536, () =>
    setTimeout(() => process.stdout.write('done\\n'), 1500)));
`,
);

/** `forever` says it is up and runs until it is ended. */
const forever = binPackage(
  'forever',
  "process.stdout.write('up\\n');\nsetInterval(() => {}, 1000);\n",
);

describe.runIf(canSandbox)('opmx runs a tool for as long as it runs', () => {
  it('past the timeout lifecycle scripts get, writing past the byte limits', async () => {
    // What used to end it within a fifth of a second.
    const root = await installedProject(
      [chatty],
      '[sandbox]\ntimeout_ms = 200',
    );
    const cap = capture();
    expect(await runOpmx(['chatty'], cap.io, root), cap.err).toBe(0);
    expect(cap.seen.out.length).toBe(3 * MiB + 'done\n'.length);
    expect(cap.seen.out.endsWith('x\ndone\n')).toBe(true);
    // Nothing but the tool's own output, and no word from the sandbox.
    expect(cap.seen.err).toBe(`${'x'.repeat(1023)}\n`.repeat(1536));
  }, 120_000);

  it('until the project’s opmx_timeout_ms, which ends it', async () => {
    const root = await installedProject(
      [forever],
      '[sandbox]\nopmx_timeout_ms = 500',
    );
    const cap = capture();
    expect(await runOpmx(['forever'], cap.io, root)).toBe(124);
    expect(cap.seen).toEqual({
      out: 'up\n',
      err: '\nopenpacker sandbox: process timed out after 500 ms\n',
    });
  }, 120_000);

  it('until --timeout, which wins over the project’s', async () => {
    const root = await installedProject(
      [forever],
      '[sandbox]\nopmx_timeout_ms = 600000',
    );
    const cap = capture();
    expect(await runOpmx(['--timeout', '400', 'forever'], cap.io, root)).toBe(
      124,
    );
    expect(cap.seen).toEqual({
      out: 'up\n',
      err: '\nopenpacker sandbox: process timed out after 400 ms\n',
    });
  }, 120_000);
});

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

/**
 * Everything opm writes to stderr that a registry, a lock or a plugin could
 * have chosen goes through the one writer (`report`, or `formatFailure`, which
 * is built on it). That is a property of the call sites, so it is read from the
 * sources with the TypeScript parser (`stderr-scan.ts`), which does not
 * recognise write calls one spelling at a time but forbids the reference: any
 * mention of a `stderr` stream, of `console`, of a file descriptor 2. The one
 * allowed form is `io.stderr.write(report(...))`; every other mention in `src`
 * is named below with the reason it may be there.
 *
 * A new reference that is neither fails here, and an entry that no longer
 * matches a use fails too, so the list cannot outlive the code it excuses. The
 * scanner is held to the ways round the obvious spelling by fixtures that must
 * be caught. `apps/openpacker-cli` and the other packages are not scanned: this
 * is the `opm` command line's contract.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findStderrUses, type Use } from './stderr-scan.js';

const src = join(dirname(fileURLToPath(import.meta.url)), '../src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(directory, entry.name)]
        : [],
  );
}

interface Place extends Use {
  file: string;
}

/** What may be written as it is, by file and the start of the argument. */
const EXEMPT: ReadonlyArray<{
  file: string;
  starts: string;
  reason: string;
}> = [
  {
    file: 'opm.ts',
    starts: '`opm: candidate sets were bounded for ${graph.truncated.length}',
    reason: 'a constant sentence around a count',
  },
  {
    file: 'opm.ts',
    starts: '`\\n${help()}\\n`',
    reason: "opm's own usage text, after the usage error has been written",
  },
  {
    file: 'opm.ts',
    starts: "'opm: host install needs elevation;",
    reason: 'a constant sentence',
  },
  {
    file: 'opm.ts',
    starts: 'outcome.stderr',
    reason: "the host installer's own stderr, passed through as it wrote it",
  },
  {
    file: 'opm.ts',
    starts: '`opm: host install exited ${outcome.exitCode}',
    reason: 'a constant sentence around an exit status',
  },
  {
    file: 'opmx.ts',
    starts: 'outcome.stderr',
    reason: "the tool's own stderr, passed through as it wrote it",
  },
  {
    file: 'commands/auth.ts',
    starts: '`Unknown auth subcommand: ${sub',
    reason: "the person's own argument, and the usage text",
  },
  {
    file: 'commands/auth.ts',
    starts: '`opm auth set requires --origin',
    reason: 'a constant sentence and the usage text',
  },
  {
    file: 'commands/auth.ts',
    starts: '`opm auth unset requires --origin',
    reason: 'a constant sentence and the usage text',
  },
  {
    file: 'commands/run-child.ts',
    starts: 'chunk',
    reason: "the script's own stderr, passed through as it wrote it",
  },
  {
    file: 'commands/run.ts',
    starts: 'describeEnd(`script "${event}"`',
    reason:
      "the name of a script in the person's own package.json and an exit status; the run path loads no workspace package (run-load.test.ts)",
  },
  {
    file: 'commands/run.ts',
    starts: 'describeEnd(`"${request.bin}"`',
    reason:
      'the name the person typed and an exit status; the run path loads no workspace package (run-load.test.ts)',
  },
  {
    file: 'commands/run-child.ts',
    starts: 'return Boolean( process.stdin.isTTY',
    reason: 'asks whether a stream is a terminal; writes nothing',
  },
  {
    file: 'commands/run-child.ts',
    starts: 'export const processHost',
    reason:
      'the one place the real process streams are named, handed to the host seam',
  },
  {
    file: 'commands/run-child.ts',
    starts:
      "const stderr = direct(io.stderr, host.stderr) ? 'inherit' : 'pipe'",
    reason:
      "decides whether the child's stderr is inherited (passed through as the child wrote it) or piped",
  },
  {
    file: 'commands/run-child.ts',
    starts: 'child = host.spawn(',
    reason: "hands the child's stderr choice to spawn",
  },
  {
    file: 'commands/run-child.ts',
    starts: "child.stderr?.setEncoding('utf8')",
    reason: "reads the child's own stderr; writes nothing",
  },
  {
    file: 'commands/run-child.ts',
    starts: "child.stderr?.on('data'",
    reason:
      "forwards the script's own stderr as it wrote it (the write is named above)",
  },
  {
    file: 'opm.ts',
    starts: "throw new OpmError( 'PACK_FAILED', result.stderr",
    reason:
      "a packer's own captured stderr, carried in an OpmError the writer then reports",
  },
  {
    file: 'opm.ts',
    starts: 'if (outcome.stderr) io.stderr.write(outcome.stderr)',
    reason:
      "the host installer's own captured stderr (the write is named above)",
  },
  {
    file: 'opm.ts',
    starts: 'io.stderr.write(outcome.stderr)',
    reason:
      "the host installer's own captured stderr (the write is named above)",
  },
  {
    file: 'opmx.ts',
    starts: 'if (outcome.stderr) io.stderr.write(outcome.stderr)',
    reason: "the tool's own captured stderr (the write is named above)",
  },
  {
    file: 'opmx.ts',
    starts: 'io.stderr.write(outcome.stderr)',
    reason: "the tool's own captured stderr (the write is named above)",
  },
];

const places: Place[] = sourceFiles(src).flatMap((path) =>
  findStderrUses(readFileSync(path, 'utf8'), path).map((written) => ({
    ...written,
    file: relative(src, path),
  })),
);
const exempted = (place: Place) =>
  EXEMPT.find(
    (entry) =>
      entry.file === place.file && place.argument.startsWith(entry.starts),
  );

describe('what opm writes to stderr', () => {
  it('finds the writers it is about', () => {
    expect(places.length).toBeGreaterThan(25);
    expect(new Set(places.map((place) => place.file))).toEqual(
      new Set([
        'opm.ts',
        'opmx.ts',
        'commands/auth.ts',
        'commands/ci.ts',
        'commands/packslip.ts',
        'commands/run-child.ts',
        'commands/run.ts',
      ]),
    );
  });

  it('goes through the writer, or is named here with the reason it need not', () => {
    const raw = places
      .filter((place) => !place.routed && exempted(place) === undefined)
      .map((place) => `${place.file}: ${place.how}(${place.argument})`);
    expect(raw).toEqual([]);
  });

  it('names nothing that is no longer written', () => {
    const unused = EXEMPT.filter(
      (entry) =>
        !places.some(
          (place) =>
            !place.routed &&
            place.file === entry.file &&
            place.argument.startsWith(entry.starts),
        ),
    ).map((entry) => `${entry.file}: ${entry.starts}`);
    expect(unused).toEqual([]);
  });
});

describe('the scanner', () => {
  const flagged = (code: string) =>
    findStderrUses(code).filter((use) => !use.routed);

  // The ways a stream was reached that the scanner was first written for.
  it.each([
    ['a stream write', 'io.stderr.write(`opm: ${s}\n`);'],
    ['the process stream', 'process.stderr.write(s);'],
    ['a stream behind parentheses', '(io.stderr).write(s);'],
    ['an optional chain', 'io.stderr?.write(s);'],
    ['console.error', 'console.error(s);'],
    ['console.warn', 'console.warn(s);'],
    ['a destructured write', 'const { write } = io.stderr; write(s);'],
    [
      'a renamed destructured write',
      'const { write: w } = process.stderr; w(s);',
    ],
    ['an element access', "io.stderr['write'](s);"],
    ['an alias of the stream', 'const err = io.stderr; err.write(s);'],
    ['an alias of an alias', 'const a = io.stderr; const b = a; b.write(s);'],
    ['a destructured stream', 'const { stderr } = process; stderr.write(s);'],
    [
      'a renamed destructured stream',
      'const { stderr: err } = io; err.write(s);',
    ],
    ['a bound write', 'io.stderr.write.bind(io.stderr)(s);'],
    [
      'a bound write kept for later',
      'const w = io.stderr.write.bind(io.stderr); w(s);',
    ],
    ['write.call', 'io.stderr.write.call(io.stderr, s);'],
    ['write.apply', 'io.stderr.write.apply(io.stderr, [s]);'],
    ['writeSync to descriptor 2', 'fs.writeSync(2, s);'],
    ['writeSync to the stream descriptor', 'writeSync(process.stderr.fd, s);'],
    ['a pipe into the stream', 'child.stdout.pipe(process.stderr);'],
    ['the writer and then more', "io.stderr.write(report('opm: ', x) + s);"],
    [
      'the writer inside a template with more',
      "io.stderr.write(`${report('opm: ', x)}${s}`);",
    ],
    ['the writer for one part', "io.stderr.write(`${report('opm: ', x)}`);"],
    ['the writer and a line', "io.stderr.write(report('opm: ', x) || s);"],
  ])('catches %s', (_, code) => {
    expect(flagged(code).length).toBeGreaterThanOrEqual(1);
  });

  // What an independent review wrote to get round it (round 6, G7): a stream
  // handed to a helper, a console of another kind, a descriptor, a computed key.
  it.each([
    [
      'Reflect.apply',
      'Reflect.apply(process.stderr.write, process.stderr, [s]);',
    ],
    ['a stream by element access', "process['stderr']['write'](s);"],
    ['a Console on the stream', 'new Console(process.stderr).error(s);'],
    [
      'a Console on two streams',
      'const c = new Console(process.stdout, process.stderr); c.error(s);',
    ],
    [
      'an import renamed',
      "import { stderr as e } from 'node:process'; e.write(s);",
    ],
    [
      'a stream passed to a helper',
      'function emit(stream, text) { stream.write(text); } emit(io.stderr, s);',
    ],
    ['an assignment alias', 'let w; w = io.stderr; w.write(s);'],
    ['a computed key', "const key = 'stderr'; io[key].write(s);"],
    ['a concatenated key', "io['std' + 'err'].write(s);"],
    ['writeFileSync to descriptor 2', 'fs.writeFileSync(2, s);'],
    ['appendFileSync to /dev/stderr', "fs.appendFileSync('/dev/stderr', s);"],
    ['a path to the descriptor', "const p = '/dev/fd/2'; open(p);"],
    ['end', 'io.stderr.end(s);'],
    ['console.error kept in a variable', 'const log = console.error; log(s);'],
    ['console.error destructured', 'const { error } = console; error(s);'],
    ['console.trace', 'console.trace(s);'],
    ['console.assert', 'console.assert(false, s);'],
    ['console.log', 'console.log(s);'],
    ['process.emitWarning', 'process.emitWarning(s);'],
    ['console.error.call', 'console.error.call(console, s);'],
    ['a write in a comma expression', '(0, io.stderr.write)(s);'],
    ['a conditional stream', '(cond ? io.stderr : io.stdout).write(s);'],
    [
      'a stream bound for later',
      'const write = io.stderr.write.bind(io.stderr); [s].forEach(write);',
    ],
    ['a stream in an object', 'const o = { out: io.stderr }; o.out.write(s);'],
    ['a stream in an array', '[io.stderr].forEach((x) => x.write(s));'],
    [
      'a stream as a default parameter',
      'function f(out = io.stderr) { out.write(s); } f();',
    ],
    [
      'a parameter named for it',
      'function f(stderr) { stderr.write(s); } f(io.err);',
    ],
    ['a shorthand property', 'const o = { stderr }; o.stderr.write(s);'],
    ['a stream read from a child', "child.stderr?.on('data', (c) => keep(c));"],
    [
      'a report that is a local function',
      'function report(a, b) { return a + b; } io.stderr.write(report("opm: ", s));',
    ],
    ['a stream behind a cast', '(io as Streams).stderr.write(s);'],
  ])('catches %s', (_, code) => {
    expect(flagged(code).length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['report', "io.stderr.write(report('opm: ', x));"],
    ['report, in parentheses', "io.stderr.write((report('opm: ', x)));"],
    ['formatFailure', 'io.stderr.write(formatFailure(parseFailure(e), o));'],
    [
      'a report of text a registry sent',
      'io.stderr.write(report(`opm: ${s}`));',
    ],
  ])('lets %s through, and sees it', (_, code) => {
    const uses = findStderrUses(code);
    expect(uses).toHaveLength(1);
    expect(uses[0]?.routed).toBe(true);
  });

  it.each([
    ['stdout', 'io.stdout.write(s);'],
    ['a write elsewhere', 'file.write(s); const { write } = file; write(s);'],
    ['writeSync to a file', 'fs.writeSync(fd, s);'],
    [
      'a type that names the stream',
      'interface Io { stderr: Pick<WriteStream, "write">; }',
    ],
    ['a type annotation', 'let sink: { stderr: string };'],
    ['a log that goes through the logger', 'logger.error(s);'],
  ])('does not take %s for stderr', (_, code) => {
    expect(findStderrUses(code)).toEqual([]);
  });
});

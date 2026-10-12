/**
 * Everything opm writes to stderr that a registry, a lock or a plugin could
 * have chosen goes through the one writer (`report`, or `formatFailure`, which
 * is built on it). That is a property of the call sites, so it is read from the
 * sources with the TypeScript parser (`stderr-scan.ts`): each write in `src` is
 * either, as a whole, a call to one of the two, or is named below with the
 * reason it may write its argument as it is.
 *
 * A new writer that is neither fails here, and an entry that no longer matches
 * a write fails too, so the list cannot outlive the code it excuses. The
 * scanner is held to the ways round the obvious spelling by fixtures that must
 * be caught.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findStderrWrites, type Written } from './stderr-scan.js';

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

interface Place extends Written {
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
];

const places: Place[] = sourceFiles(src).flatMap((path) =>
  findStderrWrites(readFileSync(path, 'utf8'), path).map((written) => ({
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
    findStderrWrites(code).filter((written) => !written.routed);

  it.each([
    ['a stream write', 'io.stderr.write(`opm: ${s}\\n`);'],
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

  it.each([
    ['report', "io.stderr.write(report('opm: ', x));"],
    ['report, in parentheses', "io.stderr.write((report('opm: ', x)));"],
    ['formatFailure', 'io.stderr.write(formatFailure(parseFailure(e), o));'],
    [
      'report through an alias of the stream',
      "const e = io.stderr; e.write(report('opm: ', x));",
    ],
  ])('lets %s through, and sees it', (_, code) => {
    const writes = findStderrWrites(code);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.routed).toBe(true);
  });

  it.each([
    ['stdout', 'io.stdout.write(s);'],
    ['console.log', 'console.log(s);'],
    [
      'listening to a child',
      "child.stderr?.on('data', (chunk) => s.push(chunk));",
    ],
    ['a write elsewhere', 'file.write(s); const { write } = file; write(s);'],
    ['writeSync to a file', 'fs.writeSync(fd, s);'],
  ])('does not take %s for stderr', (_, code) => {
    expect(findStderrWrites(code)).toEqual([]);
  });
});

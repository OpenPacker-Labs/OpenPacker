/**
 * Everything the command lines write to standard output goes through a named
 * writer from `@openpacker/canonical`: `out` for text, `outJson` for a JSON
 * document, and `outRaw` for what a child wrote itself. That is a property of
 * the call sites, so it is read from the sources with the TypeScript parser
 * (`stderr-scan.ts`, the same scanner that holds standard error to `report`),
 * which forbids the reference: any mention of a `stdout` stream, of `console`,
 * of a file descriptor 1. The writers take the command's `io` and never name the
 * stream, so they are not mentioned here; every other mention in the sources of
 * `opm`, `openpacker` and the daemon's start is named below with the reason it
 * may be there, and every call of `outRaw` is named too.
 *
 * Before this, nothing held standard output, and a new line there that repeated
 * a value from a repository forged a line until someone remembered to flatten it
 * (the four findings of ADR 0044's third round were this). An entry that no
 * longer matches a use fails, so the list cannot outlive the code it excuses.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findStdoutUses, type Use } from './stderr-scan.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOTS = [
  { prefix: '', directory: join(here, '../src') },
  {
    prefix: 'openpacker-cli/',
    directory: join(here, '../../openpacker-cli/src'),
  },
  { prefix: 'openpackerd/', directory: join(here, '../../openpackerd/src') },
] as const;

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

/** What may name standard output, by file and the start of the statement or argument. */
const EXEMPT: ReadonlyArray<{
  file: string;
  starts: string;
  reason: string;
}> = [
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
      "const stdout = direct(io.stdout, host.stdout) ? 'inherit' : 'pipe'",
    reason:
      "decides whether the child's stdout is inherited (the script's own, as it wrote it) or piped",
  },
  {
    file: 'commands/run-child.ts',
    starts: 'child = host.spawn(',
    reason: "hands the child's stdout choice to spawn",
  },
  {
    file: 'commands/run-child.ts',
    starts: "child.stdout?.setEncoding('utf8')",
    reason: "reads the child's own stdout; writes nothing",
  },
  {
    file: 'commands/run-child.ts',
    starts: "child.stdout?.on('data'",
    reason:
      "forwards the script's own stdout as it wrote it (the write is named below); this file may import only Node and this directory (run-load.test.ts), so it cannot call outRaw",
  },
  {
    file: 'commands/run-child.ts',
    starts: 'chunk',
    reason:
      "the script's own stdout, passed through as it wrote it, which is the point of `opm run`",
  },
  {
    file: 'opm.ts',
    starts: 'if (outcome.stdout) outRaw(io, outcome.stdout)',
    reason:
      "reads the host installer's captured stdout, a string, to hand it on (the call is named below)",
  },
  {
    file: 'opm.ts',
    starts: 'outRaw',
    reason: "the host installer's own stdout, passed through as it wrote it",
  },
  {
    file: 'opmx.ts',
    starts: 'if (outcome.stdout) outRaw(io, outcome.stdout)',
    reason:
      "reads the tool's captured stdout, a string, to hand it on (the call is named below)",
  },
  {
    file: 'opmx.ts',
    starts: 'outRaw',
    reason: "the tool's own stdout, passed through as it wrote it",
  },
];

const places: Place[] = ROOTS.flatMap(({ prefix, directory }) =>
  sourceFiles(directory).flatMap((path) =>
    findStdoutUses(readFileSync(path, 'utf8'), path).map((use) => ({
      ...use,
      file: `${prefix}${relative(directory, path)}`,
    })),
  ),
);
const matches = (place: Place, entry: (typeof EXEMPT)[number]) =>
  entry.file === place.file && place.argument.startsWith(entry.starts);

describe('what the command lines write to stdout', () => {
  it('finds the places it is about', () => {
    expect(new Set(places.map((place) => place.file))).toEqual(
      new Set(['commands/run-child.ts', 'opm.ts', 'opmx.ts']),
    );
  });

  it('goes through a named writer, or is named here with the reason it need not', () => {
    const raw = places
      .filter((place) => !EXEMPT.some((entry) => matches(place, entry)))
      .map((place) => `${place.file}: ${place.how}(${place.argument})`);
    expect(raw).toEqual([]);
  });

  it('names nothing that is no longer written', () => {
    const unused = EXEMPT.filter(
      (entry) => !places.some((place) => matches(place, entry)),
    ).map((entry) => `${entry.file}: ${entry.starts}`);
    expect(unused).toEqual([]);
  });

  it('lists every call of outRaw', () => {
    const calls = places.filter((place) => place.how === 'outRaw');
    expect(calls.map((place) => place.file).sort()).toEqual([
      'opm.ts',
      'opmx.ts',
    ]);
  });
});

describe('the scanner, for standard output', () => {
  const flagged = (code: string) => findStdoutUses(code);

  it.each([
    ['a stream write', 'io.stdout.write(`${s}\n`);'],
    ['the process stream', 'process.stdout.write(s);'],
    ['a stream behind parentheses', '(io.stdout).write(s);'],
    ['an optional chain', 'io.stdout?.write(s);'],
    ['console.log', 'console.log(s);'],
    ['console.info', 'console.info(s);'],
    ['console.table', 'console.table(rows);'],
    ['a destructured write', 'const { write } = io.stdout; write(s);'],
    ['an element access', "io.stdout['write'](s);"],
    ['an alias of the stream', 'const o = io.stdout; o.write(s);'],
    ['a destructured stream', 'const { stdout } = process; stdout.write(s);'],
    ['a bound write', 'io.stdout.write.bind(io.stdout)(s);'],
    ['write.call', 'io.stdout.write.call(io.stdout, s);'],
    ['writeSync to descriptor 1', 'fs.writeSync(1, s);'],
    ['writeSync to the stream descriptor', 'writeSync(process.stdout.fd, s);'],
    ['a path to the descriptor', "fs.appendFileSync('/dev/stdout', s);"],
    ['a pipe into the stream', 'child.stdout.pipe(process.stdout);'],
    ['a Console on the stream', 'new Console(process.stdout).log(s);'],
    ['a stream handed to a helper', 'emit(io.stdout, s);'],
    ['a stream in an object', 'const o = { out: io.stdout };'],
    ['a stream read from a child', "child.stdout?.on('data', (c) => keep(c));"],
    ['a computed key', "const key = 'stdout'; io[key].write(s);"],
    ['a concatenated key', "io['std' + 'out'].write(s);"],
    ['a parameter named for it', 'function f(stdout) { stdout.write(s); }'],
    ['outRaw', 'outRaw(io, chunk);'],
  ])('catches %s', (_name, code) => {
    expect(flagged(code).length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['out', 'out(io, `Installed ${x}\n`);'],
    ['outJson', 'outJson(io, JSON.stringify(document));'],
    ['stderr', 'io.stderr.write(report("opm: ", x));'],
    [
      'a type that names the stream',
      'interface Io { stdout: Pick<WriteStream, "write">; }',
    ],
    ['a type annotation', 'let sink: { stdout: string };'],
    ['a write elsewhere', 'file.write(s); const { write } = file; write(s);'],
    ['a log that goes through the logger', 'logger.info(s);'],
  ])('does not take %s for standard output', (_name, code) => {
    expect(flagged(code)).toEqual([]);
  });
});

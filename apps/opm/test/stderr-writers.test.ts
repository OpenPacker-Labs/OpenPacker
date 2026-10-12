/**
 * Everything opm writes to stderr that a registry, a lock or a plugin could
 * have chosen goes through the one writer (`report`, or `formatFailure`, which
 * is built on it). That is a property of the call sites, so it is read from the
 * sources: each `stderr.write(` in `src` either starts with one of the two or is
 * named below with the reason it may write its argument as it is.
 *
 * A new writer that is neither fails here, and an entry that no longer matches
 * a call fails too, so the list cannot outlive the code it excuses.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const src = join(dirname(fileURLToPath(import.meta.url)), '../src');

interface Write {
  file: string;
  /** The argument of the call, as written, on one line. */
  argument: string;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(directory, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(directory, entry.name)]
        : [],
  );
}

function stderrWrites(file: string): Write[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: Write[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      /\bstderr\.write$/u.test(node.expression.getText(source))
    )
      found.push({
        file: relative(src, file),
        argument: (node.arguments[0]?.getText(source) ?? '').replace(
          /\s+/gu,
          ' ',
        ),
      });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Written through the writer: `report(…)`, `formatFailure(…)`, or a template that starts with `report(`. */
const ROUTED = /^(?:`\$\{)?(?:report|formatFailure)\(/u;

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

const writes = sourceFiles(src).flatMap(stderrWrites);
const exempted = (write: Write) =>
  EXEMPT.find(
    (entry) =>
      entry.file === write.file && write.argument.startsWith(entry.starts),
  );

describe('what opm writes to stderr', () => {
  it('finds the writers it is about', () => {
    expect(writes.length).toBeGreaterThan(25);
    expect(new Set(writes.map((write) => write.file))).toEqual(
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
    const raw = writes
      .filter((write) => !ROUTED.test(write.argument))
      .filter((write) => exempted(write) === undefined)
      .map((write) => `${write.file}: stderr.write(${write.argument})`);
    expect(raw).toEqual([]);
  });

  it('names nothing that is no longer written', () => {
    const unused = EXEMPT.filter(
      (entry) =>
        !writes.some(
          (write) =>
            write.file === entry.file &&
            write.argument.startsWith(entry.starts) &&
            !ROUTED.test(write.argument),
        ),
    ).map((entry) => `${entry.file}: ${entry.starts}`);
    expect(unused).toEqual([]);
  });
});

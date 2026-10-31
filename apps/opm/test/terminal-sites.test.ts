/**
 * Every write to a terminal in `apps/opm/src` carries fixed text, or passes
 * through `say` / `terminalSafe` or `report` (`@openpacker/canonical`, which
 * makes the text plain), or is one of the few raw outputs listed here with the
 * reason it is raw (the review of #179, round 6, N-a). `out`, `outJson` and
 * `outRaw` write standard output for the code that uses them and name no stream
 * here. A line that interpolates a value, written straight to a stream, is how
 * a registry, a lock or a repository got ESC, BEL or a right-to-left override
 * onto a terminal; a new one fails here before a review has to find it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = fileURLToPath(new URL('../src/', import.meta.url));

/** What may be written raw: the argument as the source spells it, and why. */
const RAW: readonly { file: string; argument: string; why: string }[] = [
  {
    file: 'opm.ts',
    argument: '`\\n${helpText()}\\n`',
    why: "opm's own usage text, after the usage error has been written",
  },
  {
    file: 'opm.ts',
    argument:
      '`opm: candidate sets were bounded for ${graph.truncated.length} package(s); ` +\n              `a solve over a truncated universe can report unsatisfiable for a solvable problem\\n`',
    why: 'a constant sentence around a count',
  },
  {
    file: 'opm.ts',
    argument: '`opm: host install exited ${outcome.exitCode}\\n`',
    why: 'a constant sentence around an exit status',
  },
  {
    file: 'opm.ts',
    argument:
      "formatFailure(parseFailure(error), { tool: 'opm', internalError: true })",
    why: '`formatFailure` makes plain what it formats (`report`, `plainText`)',
  },
  {
    file: 'opm.ts',
    argument: 'outcome.stderr',
    why: "a host installer's own output, passed through as a child's is",
  },
  {
    file: 'opmx-spawn.ts',
    argument: 'outcome.stderr',
    why: "a tool's own output, passed through",
  },
  {
    file: 'opmx.ts',
    argument: "formatFailure(parseFailure(error), { tool: 'opmx' })",
    why: '`formatFailure` makes plain what it formats (`report`, `plainText`)',
  },
  {
    file: 'commands/run-child.ts',
    argument: 'chunk',
    why: "a child's own output, passed through",
  },
  {
    file: 'commands/run-output.ts',
    argument: 'text',
    why: "a member's own line, passed through as a child's is, behind a prefix of the member's label and step that `plainLine` makes one plain line (run-workspace-labels.test.ts)",
  },
];

/** The text between the parenthesis that opens at `open` and its match, skipping strings and templates. */
function argumentAt(text: string, open: number): string {
  let depth = 0;
  const skipQuoted = (at: number, quote: string): number => {
    for (let i = at + 1; i < text.length; i += 1) {
      if (text[i] === '\\') i += 1;
      else if (quote === '`' && text.startsWith('${', i)) {
        let braces = 1;
        i += 2;
        while (braces > 0) {
          if (text[i] === '{') braces += 1;
          else if (text[i] === '}') braces -= 1;
          else if ('\'"`'.includes(text[i]!)) i = skipQuoted(i, text[i]!);
          i += 1;
        }
        i -= 1;
      } else if (text[i] === quote) return i;
    }
    return text.length;
  };
  for (let i = open; i < text.length; i += 1) {
    const char = text[i]!;
    if ('\'"`'.includes(char)) i = skipQuoted(i, char);
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0)
        return text
          .slice(open + 1, i)
          .trim()
          .replace(/,$/u, '');
    }
  }
  return text.slice(open + 1).trim();
}

/** Whether the argument is nothing but literal text with no interpolation. */
function fixed(argument: string): boolean {
  const withoutLiterals = argument
    .replace(/'(?:[^'\\]|\\.)*'/gu, '""')
    .replace(/"(?:[^"\\]|\\.)*"/gu, '""')
    .replace(/`(?:[^`\\$]|\\.|\$(?!\{))*`/gu, '""');
  return /^(?:""\s*\+?\s*)+$/u.test(withoutLiterals);
}

function sources(): { file: string; text: string }[] {
  return (readdirSync(SOURCE, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.ts'))
    .map((file) => ({
      file: file.replaceAll('\\', '/'),
      text: readFileSync(join(SOURCE, file), 'utf8'),
    }));
}

describe('what apps/opm writes to a terminal', () => {
  const writes = sources().flatMap(({ file, text }) =>
    [
      ...text.matchAll(
        /\b(?:stdout|stderr)\??\.write\(|\bout\[[\w.]+\]\.write\(/gu,
      ),
    ].map((match) => ({
      file,
      argument: argumentAt(text, match.index + match[0].length - 1),
    })),
  );

  it('finds the writes it is meant to hold (it is not vacuous)', () => {
    expect(writes.length).toBeGreaterThan(15);
    expect(
      writes.filter(({ argument }) => argument.startsWith('report(')).length,
    ).toBeGreaterThan(8);
    // The values go through a writer instead: far more of those than raw writes.
    const says = sources().reduce(
      (count, { text }) =>
        count + (text.match(/\b(?:say|out|outJson|report)\(/gu)?.length ?? 0),
      0,
    );
    expect(says).toBeGreaterThan(40);
  });

  it('is fixed text, `terminalSafe`, `report`, or listed as raw with its reason', () => {
    const loose = writes.filter(
      ({ file, argument }) =>
        !fixed(argument) &&
        !argument.startsWith('terminalSafe(') &&
        !argument.startsWith('report(') &&
        !RAW.some((raw) => raw.file === file && raw.argument === argument),
    );
    expect(loose).toEqual([]);
  });

  it('lists no raw output that is no longer written', () => {
    for (const raw of RAW)
      expect(
        writes.some(
          ({ file, argument }) =>
            file === raw.file && argument === raw.argument,
        ),
        `${raw.file}: ${raw.argument}`,
      ).toBe(true);
  });
});

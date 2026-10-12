import { describe, expect, it } from 'vitest';
import {
  out,
  outJson,
  outRaw,
  plainOutput,
  jsonOutput,
  report,
} from '../src/index.js';

/**
 * The writers of the command lines: what a person's terminal is sent. Text is
 * made plain (no escape sequence, control, format or bidirectional character)
 * with the line feeds and tabs a command writes itself kept; a JSON document
 * has the characters a terminal acts on written as `\uXXXX`, which parses back
 * to the same document; and a child's own output is passed through as it wrote
 * it, by a separate writer that a repository test lists by name.
 */
const chars = (...codes: number[]): string => String.fromCodePoint(...codes);
const ESC = chars(0x1b);
const HOSTILE = `evil${ESC}]0;retitled${chars(0x07)}name${chars(0x85, 0x202e, 0x200b)}X${ESC}[2K`;

function sink() {
  let written = '';
  return {
    io: {
      stdout: {
        write(chunk: string) {
          written += chunk;
          return true;
        },
      },
    },
    get written() {
      return written;
    },
  };
}

describe('report', () => {
  it('is the prefix, the message made plain, and a line feed', () => {
    expect(report('opm: ', `a${HOSTILE}b\r\nc`)).toBe('opm: aevilnameXb\nc\n');
  });

  it('says a value that is not text as String does', () => {
    expect(report('opm: ', undefined)).toBe('opm: undefined\n');
    expect(report('', 5)).toBe('5\n');
  });
});

describe('plainOutput', () => {
  it('keeps what a command writes itself: line feeds and tabs', () => {
    const text = 'name\tcommand\nsecond line\n\ttabbed\n';
    expect(plainOutput(text)).toBe(text);
  });

  it('removes what a terminal acts on and keeps the words', () => {
    expect(plainOutput(`a ${HOSTILE} b\n`)).toBe('a evilnameX b\n');
  });

  it('turns a carriage return into a line feed, as the stderr writer does', () => {
    expect(plainOutput('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });

  it('leaves text with nothing to remove byte for byte', () => {
    const text =
      'Installed into /home/me/project/.opm/store\n  - pkg:npm/a@1\n';
    expect(plainOutput(text)).toBe(text);
  });
});

describe('jsonOutput', () => {
  it('writes the characters a terminal acts on as escapes, and the document is the same', () => {
    const document = { name: HOSTILE, list: [`a${chars(0x2028, 0x9b)}b`] };
    const text = JSON.stringify(document, null, 2);
    const shown = jsonOutput(text);
    expect(shown).not.toMatch(
      /[\u0080-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u,
    );
    expect(JSON.parse(shown)).toEqual(document);
  });

  it('leaves a document with nothing to escape as it is', () => {
    const text = JSON.stringify({ a: 'é日本', b: [1, 2] }, null, 2);
    expect(jsonOutput(text)).toBe(text);
  });
});

describe('the writers', () => {
  it('out writes plain text as it is given, with its own line feeds', () => {
    const target = sink();
    out(target.io, `Installed ${HOSTILE}\n`);
    expect(target.written).toBe('Installed evilnameX\n');
  });

  it('outJson writes a document and ends it with a line feed', () => {
    const target = sink();
    outJson(target.io, JSON.stringify({ a: chars(0x202e) }));
    expect(target.written).toBe('{"a":"\\u202e"}\n');
  });

  it('outRaw passes a chunk through as it is', () => {
    const target = sink();
    outRaw(target.io, `${ESC}[31mred${ESC}[0m`);
    expect(target.written).toBe(`${ESC}[31mred${ESC}[0m`);
  });
});

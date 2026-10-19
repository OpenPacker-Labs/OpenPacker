import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT_CODES, runCli, type CliIo } from '../src/index.js';

/**
 * What the `openpacker` command line writes is text a server, a file or an
 * argument chose, and it reaches a terminal. Errors go through `report` and
 * output through `out` and `outJson` (`@openpacker/canonical`, the writers
 * `opm` uses), so whatever the server wrote (an escape sequence that retitles
 * the window, a line break and a line that looks like the tool's own, NEL, a
 * right-to-left override, a zero-width space), the person sees plain text.
 */
const chars = (...codes: number[]): string => String.fromCodePoint(...codes);
const ESC = chars(0x1b);
const HOSTILE = [
  'evil',
  `${ESC}]0;retitled${chars(0x07)}`,
  'name',
  '\r\n',
  'openpacker: ok done',
  chars(0x85, 0x202e, 0x200b),
  'X',
  `${ESC}[2K`,
].join('');
const UNSAFE = new RegExp(
  `[${[
    [0x00, 0x09],
    [0x0b, 0x1f],
    [0x7f, 0x9f],
    [0x200b, 0x200f],
    [0x2028, 0x202e],
    [0x2060, 0x2069],
    [0xfeff, 0xfeff],
  ]
    .map(([from, to]) => `\\u{${from!.toString(16)}}-\\u{${to!.toString(16)}}`)
    .join('')}]`,
  'u',
);

function io(): CliIo & { out: string; err: string } {
  const result = {
    out: '',
    err: '',
    stdin: Readable.from([]),
    stdout: {
      write(value: string | Uint8Array) {
        result.out += value.toString();
        return true;
      },
    },
    stderr: {
      write(value: string | Uint8Array) {
        result.err += value.toString();
        return true;
      },
    },
  };
  return result;
}

afterEach(() => vi.unstubAllGlobals());

function problem(text: string) {
  return Response.json(
    {
      type: 'https://openpacker.dev/problems/invalid',
      title: text,
      status: 400,
      detail: text,
      code: 'INVALID_REQUEST',
    },
    { status: 400, headers: { 'content-type': 'application/problem+json' } },
  );
}

describe('an error a server worded', () => {
  it('is written as plain lines, one for the tool and none for the server', async () => {
    vi.stubGlobal('fetch', async () => problem(HOSTILE));
    const output = io();
    const exit = await runCli(['normalize', 'pkg:npm/demo'], output);
    expect(exit).not.toBe(EXIT_CODES.success);
    expect(output.err.startsWith('openpacker: ')).toBe(true);
    expect(output.err).not.toMatch(UNSAFE);
    expect(output.err.split('\n').filter((line) => line !== '')).toHaveLength(
      1,
    );
    expect(output.err).toContain('evilname');
  });

  it('is a JSON document on one line whose strings carry no escape', async () => {
    vi.stubGlobal('fetch', async () => problem(HOSTILE));
    const output = io();
    await runCli(['normalize', 'pkg:npm/demo', '--json'], output);
    expect(output.err).not.toMatch(UNSAFE);
    const lines = output.err.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    // In a JSON document an escape is the text \u001b, which shows nothing.
    expect(JSON.parse(lines[0]!).error.message).toContain('evil');
  });
});

describe('a document a server sent', () => {
  it('is written with what a terminal acts on as escapes, and parses to the same document', async () => {
    const document = { name: HOSTILE, list: [`a${chars(0x2028, 0x9b)}b`] };
    vi.stubGlobal('fetch', async () => Response.json(document));
    const output = io();
    expect(await runCli(['normalize', 'pkg:npm/demo'], output)).toBe(
      EXIT_CODES.success,
    );
    expect(output.out).not.toMatch(UNSAFE);
    expect(JSON.parse(output.out)).toEqual(document);
  });
});

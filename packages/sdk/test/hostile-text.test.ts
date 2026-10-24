import { describe, expect, it } from 'vitest';
import {
  OpenPackerClient,
  PrexClientError,
  UnsupportedProtocolVersionError,
} from '../src/index.js';

/**
 * A server words the `detail` and `title` of a problem and names the protocol
 * version it speaks. The client's errors repeat them, and an error goes to a
 * terminal, a log and a report, so the message is one line of plain text, cut:
 * the escape sequence that retitles the window, the line break and the line
 * that looks like the tool's own, NEL, the override and the zero-width space
 * are the server's words and not the message's. The `problem` keeps the
 * document as it arrived.
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
    [0x00, 0x1f],
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

async function failure(detail: string): Promise<PrexClientError> {
  const client = new OpenPackerClient({
    baseUrl: 'https://prex.example/',
    fetch: async () =>
      Response.json(
        { title: 'Invalid', status: 400, detail },
        {
          status: 400,
          headers: { 'content-type': 'application/problem+json' },
        },
      ),
  });
  try {
    await client.normalize({ input: 'pkg:npm/demo' });
  } catch (error) {
    if (error instanceof PrexClientError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('an error a server worded', () => {
  it('is one plain line, and the problem is kept as it arrived', async () => {
    const error = await failure(HOSTILE);
    expect(error.message).not.toMatch(UNSAFE);
    expect(error.message).toContain('evilname');
    expect(error.problem?.detail).toBe(HOSTILE);
  });

  it('is cut at 512 characters, with how long it was', async () => {
    const error = await failure('d'.repeat(100_000));
    expect(error.message.length).toBeLessThan(560);
    expect(error.message).toContain('100000 characters');
  });

  it('is the same for the protocol version it names', () => {
    const error = new UnsupportedProtocolVersionError(HOSTILE);
    expect(error.message).not.toMatch(UNSAFE);
    expect(error.message).toContain('evilname');
  });
});

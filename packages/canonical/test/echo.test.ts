import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  ECHO_LIMIT,
  parseCanonicalJson,
  safeEcho,
} from '../src/index.js';

/** Anything a terminal, a log or a bidi-aware renderer would act on. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

const ESC = '\u001b';
const BEL = '\u0007';

describe('safeEcho', () => {
  it('leaves ordinary text as it is', () => {
    expect(safeEcho('id')).toBe('id');
    expect(safeEcho('@scope/pkg-name_1.2')).toBe('@scope/pkg-name_1.2');
    expect(safeEcho('naïve ключ 键')).toBe('naïve ключ 键');
  });

  it.each([
    ['a colour', `${ESC}[31mred${ESC}[0m`, 'red'],
    ['a cursor move and a line erase', `a${ESC}[2A${ESC}[2Kb`, 'ab'],
    ['a window title, ended by BEL', `${ESC}]0;pwned${BEL}key`, 'key'],
    [
      'a hyperlink, ended by ST',
      `${ESC}]8;;http://evil.test${ESC}\\link${ESC}]8;;${ESC}\\`,
      'link',
    ],
    ['a device control string', `${ESC}Pq#0;2;0;0;0${ESC}\\x`, 'x'],
    ['a two-character escape', `a${ESC}cb`, 'ab'],
    ['an escape that never ends', `a${ESC}]0;never ends`, 'a'],
    ['an escape that ends the text', `a${ESC}`, 'a'],
    ['two escapes in a row', `${ESC}${ESC}[1mx`, 'x'],
  ])('removes an escape sequence whole: %s', (_, text, expected) => {
    expect(safeEcho(text)).toBe(expected);
  });

  it.each([
    ['a newline and a carriage return', 'a\nb\rc', 'abc'],
    ['a tab', 'a\tb', 'ab'],
    ['NUL and DEL', 'a\u0000b\u007fc', 'abc'],
    [
      'the C1 introducers of CSI and OSC',
      'a\u009b31m\u009d0;t\u0007b',
      'a31m0;tb',
    ],
    ['zero-width characters', 'a​b⁠c', 'abc'],
    ['a bidirectional override', 'a‮b⁦c', 'abc'],
    ['line and paragraph separators', 'a b c', 'abc'],
    ['a lone surrogate', 'a\ud800b', 'ab'],
  ])('removes a control character: %s', (_, text, expected) => {
    expect(safeEcho(text)).toBe(expected);
  });

  it('keeps a character outside the basic plane', () => {
    expect(safeEcho('a\u{1f511}b')).toBe('a\u{1f511}b');
  });

  it('cuts at the limit and says how long the original was', () => {
    const text = 'k'.repeat(ECHO_LIMIT + 36);
    expect(safeEcho(text)).toBe(
      `${'k'.repeat(ECHO_LIMIT)}… (${text.length} characters)`,
    );
    expect(safeEcho(text, 5)).toBe(`kkkkk… (${text.length} characters)`);
  });

  it('does not mark a text that fits exactly', () => {
    expect(safeEcho('k'.repeat(ECHO_LIMIT))).toBe('k'.repeat(ECHO_LIMIT));
  });

  it('is short for a text of megabytes, and reads a bounded part of it', () => {
    const text = `${ESC}]0;${'t'.repeat(5 * 1024 * 1024)}${BEL}${'k'.repeat(50)}`;
    const quoted = safeEcho(text);
    // The title was never closed within what is read, so nothing but the
    // length is left.
    expect(quoted).toBe(`… (${text.length} characters)`);
    expect(quoted.length).toBeLessThan(40);
  });

  it('never returns a character a terminal would act on', () => {
    const codes = [
      ...Array.from({ length: 0x400 }, (_, code) => code),
      ...Array.from({ length: 0x71 }, (_, code) => 0x2000 + code),
      ...Array.from({ length: 0x802 }, (_, code) => 0xd7ff + code),
      0xfeff,
      ...Array.from({ length: 7 }, (_, code) => 0xfff9 + code),
    ];
    for (const code of codes) {
      const character = String.fromCharCode(code);
      for (const text of [
        character,
        `a${character}b`,
        `${ESC}[${character}`,
        `${ESC}]${character}x${BEL}`,
      ])
        expect(UNSAFE.test(safeEcho(text))).toBe(false);
    }
  });
});

describe('what the parser says of a duplicate member', () => {
  const duplicated = (key: string) =>
    `{"a":1,${JSON.stringify(key)}:1,${JSON.stringify(key)}:2}`;

  function refusal(text: string): string {
    try {
      parseCanonicalJson(text);
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalJsonError);
      return (error as Error).message;
    }
    throw new Error('the document was accepted');
  }

  it('is unchanged for an ordinary key', () => {
    expect(refusal('{"id":1,"id":2}')).toMatch(
      /^Duplicate object member: id at byte \d+$/u,
    );
  });

  it('holds no escape sequence and no newline from the key', () => {
    const message = refusal(duplicated(`${ESC}]0;pwned${BEL}x\ny${ESC}[31m`));
    expect(message).toMatch(/^Duplicate object member: xy at byte \d+$/u);
    expect(UNSAFE.test(message)).toBe(false);
  });

  it('is short whatever the length of the key', () => {
    const message = refusal(duplicated('k'.repeat(2 * 1024 * 1024)));
    expect(message).toBe(
      `Duplicate object member: ${'k'.repeat(ECHO_LIMIT)}… (2097152 characters) ` +
        `at byte ${new TextEncoder().encode(`{"a":1,"${'k'.repeat(2 * 1024 * 1024)}":1,"${'k'.repeat(2 * 1024 * 1024)}"`).length}`,
    );
    expect(message.length).toBeLessThan(200);
  });
});

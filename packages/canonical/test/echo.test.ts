import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  ECHO_LIMIT,
  parseCanonicalJson,
  safeEcho,
} from '../src/index.js';

/**
 * Anything a terminal, a log or a bidi-aware renderer would act on, as numeric
 * code point ranges written out here. The implementation drops characters by
 * their Unicode general category; this list is not that class, so a category it
 * missed would not also be missing from here by construction.
 */
const FORBIDDEN: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], // C0 controls: ESC, BEL, newline, tab
  [0x007f, 0x009f], // DEL and the C1 controls: U+009B is CSI, U+009D is OSC
  [0x00ad, 0x00ad], // soft hyphen
  [0x0600, 0x0605], // Arabic number signs
  [0x061c, 0x061c], // Arabic letter mark
  [0x06dd, 0x06dd], // Arabic end of ayah
  [0x070f, 0x070f], // Syriac abbreviation mark
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width characters and the direction marks
  [0x2028, 0x202e], // line and paragraph separators, embeddings and overrides
  [0x2060, 0x2064], // word joiner and the invisible operators
  [0x2066, 0x206f], // isolates and the deprecated format characters
  [0xfeff, 0xfeff], // byte order mark
  [0xfff9, 0xfffb], // interlinear annotation
  [0xd800, 0xdfff], // surrogates
  [0xe0001, 0xe0001], // language tag
  [0xe0020, 0xe007f], // tag characters
];

function holdsForbidden(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (FORBIDDEN.some(([low, high]) => code >= low && code <= high))
      return true;
  }
  return false;
}

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
    ['zero-width characters', 'a\u200bb\u2060c', 'abc'],
    ['a bidirectional override', 'a\u202eb\u2066c', 'abc'],
    ['line and paragraph separators', 'a\u2028b\u2029c', 'abc'],
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
        expect(holdsForbidden(safeEcho(text))).toBe(false);
    }
  });

  it('removes every code point of the forbidden ranges, and nothing near them', () => {
    // The neighbour is not an escape's final byte, so a lone ESC leaves it alone.
    for (const [low, high] of FORBIDDEN)
      for (let code = low; code <= high; code += 1)
        expect(safeEcho(`a${String.fromCodePoint(code)}\u00e9`)).toBe(
          'a\u00e9',
        );
    for (const code of [0x20, 0x7e, 0xa0, 0xae, 0x2027, 0x205f, 0x2065, 0xfffc])
      expect(safeEcho(`a${String.fromCodePoint(code)}\u00e9`)).toBe(
        `a${String.fromCodePoint(code)}\u00e9`,
      );
  });
});

describe('an escape sequence at the cut', () => {
  it.each([
    ['a colour', `${ESC}[31m`],
    ['a window title, ended by BEL', `${ESC}]0;pwned${BEL}`],
    ['a window title, ended by ST', `${ESC}]0;pwned${ESC}\\`],
    ['a device control string', `${ESC}Pq;pwned${ESC}\\`],
  ])('is removed whole where it begins before the limit: %s', (_, sequence) => {
    // The sequence and the four letters after it make exactly the limit.
    const fits = `${'a'.repeat(ECHO_LIMIT - 4)}${sequence}tail`;
    expect(safeEcho(fits)).toBe(`${'a'.repeat(ECHO_LIMIT - 4)}tail`);
    // Two letters, then one, of the tail are what is left to show.
    for (const [padding, shownOfTail] of [
      [ECHO_LIMIT - 2, 'ta'],
      [ECHO_LIMIT - 1, 't'],
    ] as const) {
      const text = `${'a'.repeat(padding)}${sequence}tail`;
      expect(safeEcho(text)).toBe(
        `${'a'.repeat(padding)}${shownOfTail}… (${text.length} characters)`,
      );
    }
  });

  it.each([
    ['a colour', `${ESC}[31m`],
    ['a window title, ended by BEL', `${ESC}]0;pwned${BEL}`],
  ])('is never read where it begins at the limit: %s', (_, sequence) => {
    const text = `${'a'.repeat(ECHO_LIMIT)}${sequence}tail`;
    const shown = safeEcho(text);
    expect(shown).toBe(
      `${'a'.repeat(ECHO_LIMIT)}… (${text.length} characters)`,
    );
    expect(shown).not.toMatch(/pwned|31m/u);
    expect(holdsForbidden(shown)).toBe(false);
  });

  it('shows nothing of a title the scan limit cuts', () => {
    // 4,096 characters are read; the title is still open at that point.
    const text = `${'a'.repeat(4090)}${ESC}]0;pwned${BEL}bcd`;
    const shown = safeEcho(text, 5000);
    expect(shown).toBe(`${'a'.repeat(4090)}… (${text.length} characters)`);
    expect(shown).not.toMatch(/pw|bcd/u);
  });

  it('drops an astral character the scan limit splits in two', () => {
    const text = `${'a'.repeat(4095)}\u{1f511}b`;
    expect(safeEcho(text, 5000)).toBe(
      `${'a'.repeat(4095)}… (${text.length} characters)`,
    );
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
    expect(holdsForbidden(message)).toBe(false);
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

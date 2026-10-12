import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  ECHO_LIMIT,
  parseCanonicalJson,
  plainLine,
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
  [0x0890, 0x0891], // Arabic pound and piastre marks above
  [0x08e2, 0x08e2], // Arabic disputed end of ayah
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width characters and the direction marks
  [0x2028, 0x202e], // line and paragraph separators, embeddings and overrides
  [0x2060, 0x2064], // word joiner and the invisible operators
  [0x2066, 0x206f], // isolates and the deprecated format characters
  [0xfeff, 0xfeff], // byte order mark
  [0xfff9, 0xfffb], // interlinear annotation
  [0xd800, 0xdfff], // surrogates
  [0x110bd, 0x110bd], // Kaithi number sign
  [0x110cd, 0x110cd], // Kaithi number sign above
  [0x13430, 0x1343f], // Egyptian hieroglyph format controls
  [0x1bca0, 0x1bca3], // shorthand format controls
  [0x1d173, 0x1d17a], // musical symbol beam and slur controls
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

describe('a text with nothing left to show', () => {
  it.each([
    ['control characters', '\u0001\u0002\u0003', '… (3 characters)'],
    ['one control character', '\u0007', '… (1 character)'],
    ['a colour and nothing else', `${ESC}[31m`, '… (5 characters)'],
    ['zero-width characters', '\u200b\u200d\u2060', '… (3 characters)'],
  ])('still says how long it was: %s', (_, text, expected) => {
    expect(safeEcho(text)).toBe(expected);
  });

  it('leaves an empty text empty, and a text with something left unmarked', () => {
    expect(safeEcho('')).toBe('');
    expect(safeEcho('a\u0001')).toBe('a');
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

describe('plainLine', () => {
  it('leaves text with nothing to remove byte for byte, at any length', () => {
    for (const text of [
      '',
      'id',
      'two  spaces and a trailing one ',
      ' a leading space',
      'The packument of @scope/name exceeds the limit of 67108864 bytes (64.00 MiB)',
      'p@1.0.0 depends on dep as "git+https://x.test/a.git", a git specifier',
      'naïve ключ 键 \u{1f511}',
      'k'.repeat(100_000),
    ])
      expect(plainLine(text)).toBe(text);
  });

  it.each([
    ['a colour', `${ESC}[31mred${ESC}[0m`, 'red'],
    ['a window title', `a${ESC}]0;pwned${BEL}b`, 'ab'],
    ['a title that never ends', `a${ESC}]0;pwned`, 'a'],
    ['a bidirectional override', 'a\u202eb', 'ab'],
    ['a zero-width character', 'a\u200bb', 'ab'],
    ['NUL, DEL and a C1 control', 'a\u0000b\u007fc\u009bd', 'abcd'],
    ['a lone surrogate', 'a\ud800b', 'ab'],
  ])('removes %s', (_, text, expected) => {
    expect(plainLine(text)).toBe(expected);
  });

  it.each([
    ['LF', 'a\nb'],
    ['CRLF', 'a\r\nb'],
    ['CR', 'a\rb'],
    ['NEL', 'a\u0085b'],
    ['line separator', 'a\u2028b'],
    ['paragraph separator', 'a\u2029b'],
    ['tab', 'a\tb'],
    ['vertical tab', 'a\u000bb'],
    ['form feed', 'a\u000cb'],
    ['a run of them', 'a\n\n\r\n\tb'],
  ])(
    'puts one space where a message had a %s, and no line break',
    (_, text) => {
      expect(plainLine(text)).toBe('a b');
    },
  );

  it('keeps no break at either end, and adds no space beside one', () => {
    expect(plainLine('\nabc\n')).toBe('abc');
    expect(plainLine('a\n b')).toBe('a b');
    expect(plainLine('a \nb')).toBe('a b');
    expect(plainLine('a\n\u200b\nb')).toBe('a b');
  });

  it('cannot be made to carry a line break or a forbidden character', () => {
    for (const [low, high] of FORBIDDEN)
      for (let code = low; code <= high; code += 1) {
        const shown = plainLine(`a${String.fromCodePoint(code)}\u00e9`);
        expect(holdsForbidden(shown)).toBe(false);
        expect(shown).toMatch(/^a ?\u00e9$/u);
      }
  });

  it('reads all of a long text, where safeEcho reads 4,096 characters', () => {
    const text = `${'a'.repeat(10_000)}${ESC}[31mb\nc`;
    expect(plainLine(text)).toBe(`${'a'.repeat(10_000)}b c`);
  });
});

describe('plainLine on a large text', () => {
  // A message can be as long as a registry makes it, and it is written once, in
  // full. The time is for a loaded machine: a linear reading takes tens of
  // milliseconds for these, the quadratic one it replaced took 5.7 s for the
  // first at 320,000 characters.
  const BOUND_MS = 2000;
  const SIZES = [320_000, 1_048_576] as const;

  it.each([
    ['a word to a line', 'line\n', 'line '],
    ['a character, a space and a break', 'a \n', 'a '],
    ['a character and a tab', 'a\t', 'a '],
    ['a word and a CRLF', 'line\r\n', 'line '],
    ['ordinary text', 'abcd', 'abcd'],
  ])('is linear: %s', (_, unit, joined) => {
    for (const size of SIZES) {
      const count = Math.ceil(size / unit.length);
      const text = unit.repeat(count);
      const start = performance.now();
      const shown = plainLine(text);
      const milliseconds = performance.now() - start;
      expect(milliseconds).toBeLessThan(BOUND_MS);
      // Every unit but the last is followed by its separator, and layout at the
      // end is dropped; a unit that ends in a shown space keeps it.
      const last = unit.endsWith(' \n') ? joined : joined.trimEnd();
      expect(shown).toBe(joined.repeat(count - 1) + last);
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
    expect(holdsForbidden(message)).toBe(false);
  });

  it('says so when the key is nothing a person could see', () => {
    expect(refusal(duplicated('\u0001\u0002'))).toMatch(
      /^Duplicate object member: … \(2 characters\) at byte \d+$/u,
    );
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

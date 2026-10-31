import { describe, expect, it } from 'vitest';
import { plainLine, plainText } from '../src/index.js';
import { FORBIDDEN, holdsForbidden } from './forbidden.js';

/**
 * Milliseconds of CPU this process has spent, user and system: what the work
 * under test costs. A busy machine stretches the wall clock by every time slice
 * it takes away; it does not add to this.
 */
function cpuMs(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

/**
 * `plainText` is `plainLine` for a writer whose messages are lists: it removes
 * the same things and keeps the line breaks a message carries, as line feeds.
 */

const ESC = '\u001b';
const BEL = '\u0007';

/** What `opm add` and `opm ci` write when they refuse, as the code builds it. */
const CLOSURE_REFUSAL =
  'Cannot lock the dependency closure of pkg:npm/a@1.0.0: boom\n' +
  'What the walk could not use:\n' +
  '  - pkg:npm/b@2.0.0: no candidate satisfying ^3 can be installed here\n' +
  '  - pkg:npm/c@1.0.0: gated';
const POLICY_REFUSAL =
  'Supply-chain policy refuses 2 packages in the lock:\n' +
  '  node_modules/a (a@1.0.0): RELEASE_AGE: too new\n' +
  '  node_modules/b (b@2.0.0): DENIED: denied';

describe('plainText', () => {
  it('leaves text with nothing to remove byte for byte, line feeds included', () => {
    for (const text of [
      '',
      'id',
      CLOSURE_REFUSAL,
      POLICY_REFUSAL,
      'a line\n\nafter a blank one\n',
      '\n  leading and trailing  \n',
      'naïve ключ 键 \u{1f511}\n\u{1f511}',
      'k'.repeat(100_000),
    ])
      expect(plainText(text)).toBe(text);
  });

  it.each([
    ['a colour', `${ESC}[31mred${ESC}[0m\nnext`, 'red\nnext'],
    ['a window title', `a${ESC}]0;pwned${BEL}b\nc`, 'ab\nc'],
    ['a title that never ends', `a\n${ESC}]0;pwned`, 'a\n'],
    ['a bidirectional override', 'a‮b\nc', 'ab\nc'],
    ['a zero-width character', 'a​b\nc', 'ab\nc'],
    ['NUL, DEL and a C1 control', 'a\u0000b\u007fc\u009bd\ne', 'abcd\ne'],
    ['NEL', 'a\u0085b\nc', 'ab\nc'],
    ['a lone surrogate', 'a\ud800b\nc', 'ab\nc'],
  ])('removes %s and keeps the line feed', (_, text, expected) => {
    expect(plainText(text)).toBe(expected);
  });

  it.each([
    ['LF', 'a\nb', 'a\nb'],
    ['CRLF', 'a\r\nb', 'a\nb'],
    ['CR', 'a\rb', 'a\nb'],
    ['two CRLF', 'a\r\n\r\nb', 'a\n\nb'],
    ['LF then CR', 'a\n\rb', 'a\n\nb'],
    ['a CR and a LF with a removed character between', 'a\r​\nb', 'a\nb'],
    ['a CR at the end', 'a\r', 'a\n'],
  ])('turns a %s into line feeds, one for each break', (_, text, expected) => {
    expect(plainText(text)).toBe(expected);
  });

  it.each([
    ['tab', 'a\tb'],
    ['vertical tab', 'a\u000bb'],
    ['form feed', 'a\u000cb'],
    ['line separator', 'a b'],
    ['paragraph separator', 'a b'],
    ['a run of them', 'a\t \u000b\tb'],
    ['a run of them beside a space', 'a \t b'],
  ])('puts one space where a message had a %s', (_, text) => {
    expect(plainText(text)).toBe('a b');
  });

  it('keeps no space at either end of a line', () => {
    expect(plainText('\ta\t\nb\t')).toBe('a\nb');
    expect(plainText('  - indented\n\t- tabbed')).toBe(
      '  - indented\n- tabbed',
    );
  });

  it('cannot be made to carry anything but a line feed or a space', () => {
    for (const [low, high] of FORBIDDEN)
      for (let code = low; code <= high; code += 1) {
        const shown = plainText(`a${String.fromCodePoint(code)}é`);
        expect(holdsForbidden(shown.replaceAll('\n', ''))).toBe(false);
        expect(shown).toMatch(/^a[ \n]?é$/u);
      }
  });

  it('is plainLine, with the breaks kept, for a text of one line', () => {
    expect(plainText(`${ESC}[31mred\tand blue${ESC}[0m`)).toBe(
      plainLine(`${ESC}[31mred\tand blue${ESC}[0m`),
    );
    // Without a CR or LF, the two read a text alike.
    const alphabet = [
      'a',
      'b',
      ' ',
      '\t',
      '\u000b',
      ' ',
      '\u0085',
      '​',
      ESC,
      '[',
      ']',
      '0',
      ';',
      'm',
      BEL,
      '\\',
      'é',
      '\n',
      '\r',
    ];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let round = 0; round < 3000; round += 1) {
      const text = Array.from(
        { length: next() % 14 },
        () => alphabet[next() % alphabet.length],
      ).join('');
      const shown = plainText(text);
      expect(plainText(shown)).toBe(shown);
      expect(plainLine(shown)).toBe(plainLine(text));
      expect(holdsForbidden(shown.replaceAll('\n', ''))).toBe(false);
      if (!/[\r\n]/u.test(text)) expect(shown).toBe(plainLine(text));
    }
  });
});

describe('plainText on a large text', () => {
  const BOUND_MS = 2000;
  const SIZES = [320_000, 1_048_576] as const;

  it.each([
    ['a word to a line', 'line\n', 'line\n'],
    ['a word and a CRLF', 'line\r\n', 'line\n'],
    ['a character and a tab', 'a\t', 'a '],
    ['an indented list', '  - item\n', '  - item\n'],
    ['ordinary text', 'abcd', 'abcd'],
  ])('is linear: %s', (_, unit, kept) => {
    for (const size of SIZES) {
      const count = Math.ceil(size / unit.length);
      const text = unit.repeat(count);
      const start = cpuMs();
      const shown = plainText(text);
      const milliseconds = cpuMs() - start;
      expect(milliseconds).toBeLessThan(BOUND_MS);
      // A tab at the very end is dropped; a line feed is not.
      expect(shown).toBe(
        unit === 'a\t' ? kept.repeat(count - 1) + 'a' : kept.repeat(count),
      );
    }
  });
});

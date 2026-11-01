import { describe, expect, it } from 'vitest';
import { scrub } from '../src/scrub.js';

/**
 * A URL is shown as its origin and path, and the URL parser writes a character
 * outside ASCII as up to nine (`日` is `%E6%97%A5`): 1 MiB of a path of `日` was
 * 9 MiB of output, four such entries 36 MiB, and the refusal of a lock lists
 * twenty. So a URL is shown at most twice its own length and at most 600
 * characters, whatever it holds. The text around it is not changed by this.
 *
 * Each text below is 256 KiB of one hostile shape; the ratio does not depend on
 * the size, and nothing here may come out more than twice as long as it went in.
 */

const SIZE = 1 << 18;
const repeated = (unit: string) =>
  unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);

/** Units that grow when the parser writes them: one code unit, up to nine characters. */
const UNITS: Record<string, string> = {
  'ß.é.': 'raw',
  日: 'cjk',
  '😀': 'emoji',
  é: 'e-acute',
  '%C3%A9.': 'escaped',
  'a.': 'ascii',
  ﷺ: 'fdfa',
  '\u0080': 'c1',
  '\u0001': 'c0',
};

function* texts(): Generator<[string, string]> {
  for (const [unit, name] of Object.entries(UNITS)) {
    yield [`a non-special host of ${name}`, `git+https://${repeated(unit)}`];
    yield [
      `a non-special host of ${name}, then a path`,
      `x-y://h/${repeated(unit)}`,
    ];
    yield [`an https path of ${name}`, `https://h.test/${repeated(unit)}`];
    yield [`an https query of ${name}`, `https://h.test/?${repeated(unit)}`];
    yield [`an https fragment of ${name}`, `https://h.test/#${repeated(unit)}`];
    yield [
      `non-special userinfo of ${name}`,
      `git+ssh://${repeated(unit)}@h/x`,
    ];
  }
  yield ['many short URLs', repeated('http://h/a ')];
  yield ['many non-special hosts', repeated('x://日日日日 ')];
  yield [
    'many URLs with a path of 30 日',
    repeated(`https://h.test/${'日'.repeat(30)} `),
  ];
  yield [
    'many URLs with a host of 100 日',
    repeated(`s://${'日'.repeat(100)} `),
  ];
  yield [
    'many URLs with a path of 100 é',
    repeated(`s://h/${'é'.repeat(100)} `),
  ];
  yield ['a bare credential name', repeated('token=aaaa ')];
  yield ['blob URLs', 'blob:'.repeat(SIZE / 5)];
}

describe('what scrub writes for text that grows when the parser writes it', () => {
  it('is never more than twice as long as the text, for 61 hostile texts', () => {
    const worst: string[] = [];
    let count = 0;
    for (const [name, input] of texts()) {
      count += 1;
      const output = scrub(input);
      if (output.length > 2 * input.length && worst.length < 8)
        worst.push(`${(output.length / input.length).toFixed(2)}x: ${name}`);
    }
    expect(worst).toEqual([]);
    expect(count).toBe(61);
  }, 120_000);

  it('shows one long URL at 600 characters, then a mark that it was cut', () => {
    const shown = scrub(`see https://h.test/${'日'.repeat(100_000)} end`);
    expect(shown.length).toBeLessThanOrEqual(`see  end`.length + 600);
    expect(shown.startsWith('see https://h.test/%E6%97%A5')).toBe(true);
    expect(shown).toMatch(/… end$/u);
  });

  it('shows a URL of ordinary length as it always did', () => {
    const path = `/${'a'.repeat(400)}`;
    expect(scrub(`GET https://h.test${path}?t=1 failed`)).toBe(
      `GET https://h.test${path} failed`,
    );
  });

  it('shows a URL whose parts the parser writes longer than the text up to twice its length', () => {
    // `x://日日` is 6 characters and `x://%E6%97%A5%E6%97%A5` is 22: 12 are shown.
    const shown = scrub('see x://日日 end');
    expect(shown).toBe('see x://%E6%97%… end');
  });
});

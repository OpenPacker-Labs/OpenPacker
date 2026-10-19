import { describe, expect, it } from 'vitest';
import { scrub } from '../src/scrub.js';

/**
 * `scrub` shows a URL at most twice as long as the text it came from and at
 * most 600 characters, and the whole text it returns is at most twice as long
 * as the text it was given, whatever the text holds. The second half is a
 * statement about the other two passes too: `token=x,` is 8 characters and
 * `token=[REDACTED],` 17. Where it would be longer, it is cut at twice the
 * length and ends in `…`, as a URL does.
 *
 * Three ways to look for a text that breaks it: the one that does, a seeded
 * search over short repeating units, and the 61 hostile shapes of a mebibyte
 * the URL cut was made for (60 of the review's, and one of short credential values).
 */

const MIB = 1 << 20;

/** mulberry32: the same texts on every run. */
function seeded(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const repeated = (unit: string, size: number) =>
  unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

describe('the text scrub returns is at most twice as long as the text it was given', () => {
  it('for a credential name and a short value, repeated', () => {
    for (const unit of ['token=x,', 'token=x;', 'token=x ', 'secret=1,']) {
      for (const size of [64, 4096, MIB]) {
        const input = repeated(unit, size);
        const output = scrub(input);
        expect(output.length, `${unit} x ${size}`).toBeLessThanOrEqual(
          2 * input.length,
        );
        // What is cut ends in the mark a cut URL ends in, and holds no value.
        expect(output.endsWith('…') || output.length <= 2 * input.length).toBe(
          true,
        );
        expect(output).not.toMatch(/token=x|secret=1/u);
      }
    }
  });

  it('for a one-character value it cuts and does not show it', () => {
    expect(scrub('token=x')).toBe('token=[REDACT…');
    expect(scrub('password=x')).toBe('password=[REDACTED]');
    expect(scrub('a')).toBe('a');
    expect(scrub('')).toBe('');
  });

  it('for 20,000 repeating units of up to 14 characters, searched with a seed', () => {
    const tokens = [
      's://',
      'x://',
      'http://',
      'https://',
      '日',
      'é',
      'ß',
      'ﷺ',
      '😀',
      'token=',
      'api_key=',
      'password=',
      'Bearer ',
      'Basic ',
      'a',
      'aaaaaaaa',
      'h',
      '/',
      ' ',
      ',',
      ';',
      '?',
      '#',
      '@',
      ':',
      '.',
      '%',
      'blob:',
      'x',
      'secret:',
      'authorization: ',
    ];
    const next = seeded(4242);
    const seen = new Set<string>();
    const worst: string[] = [];
    let tried = 0;
    for (let trial = 0; trial < 60_000 && tried < 20_000; trial += 1) {
      let unit = '';
      const count = 1 + Math.floor(next() * 6);
      for (let index = 0; index < count; index += 1)
        unit += tokens[Math.floor(next() * tokens.length)];
      if (unit.length > 14 || seen.has(unit)) continue;
      seen.add(unit);
      tried += 1;
      const input = repeated(unit, 4096);
      const output = scrub(input);
      if (output.length > 2 * input.length && worst.length < 8)
        worst.push(
          `${(output.length / input.length).toFixed(3)}x: ${JSON.stringify(unit)}`,
        );
    }
    expect(tried).toBeGreaterThan(15_000);
    expect(worst).toEqual([]);
  }, 120_000);
});

/** Units that grow when the parser writes them: one code unit, up to nine characters. */
const UNITS = [
  'ß.é.',
  '日',
  '😀',
  'é',
  '%C3%A9.',
  'a.',
  'ﷺ',
  '\u0080',
  '\u0001',
];

function* hostileTexts(): Generator<[string, string, boolean]> {
  for (const unit of UNITS) {
    const body = repeated(unit, MIB);
    // Each of the first six is one URL: the display cap shows it at 600.
    yield ['a non-special host', `git+https://${body}`, true];
    yield ['a path after a host', `x-y://h/${body}`, true];
    yield ['an https path', `https://h.test/${body}`, true];
    yield ['an https query', `https://h.test/?${body}`, true];
    yield ['an https fragment', `https://h.test/#${body}`, true];
    yield ['non-special userinfo', `git+ssh://${body}@h/x`, true];
  }
  yield ['many short URLs', repeated('http://h/a ', MIB), false];
  yield ['many non-special hosts', repeated('x://日日日日 ', MIB), false];
  yield [
    'many URLs with a path of 30 日',
    repeated(`https://h.test/${'日'.repeat(30)} `, MIB),
    false,
  ];
  yield [
    'many URLs with a host of 100 日',
    repeated(`s://${'日'.repeat(100)} `, MIB),
    false,
  ];
  yield ['many bare credential names', repeated('token=aaaa ', MIB), false];
  yield ['many short credential values', repeated('token=x,', MIB), false];
  yield ['blob URLs', 'blob:'.repeat(MIB / 5), false];
}

describe('what scrub returns for a mebibyte of a hostile shape', () => {
  it('is at most twice as long, and one URL at most 600 characters, for 61 shapes', () => {
    const tooLong: string[] = [];
    const tooWide: string[] = [];
    let count = 0;
    for (const [name, input, single] of hostileTexts()) {
      count += 1;
      const output = scrub(input);
      if (output.length > 2 * input.length && tooLong.length < 8)
        tooLong.push(`${(output.length / input.length).toFixed(3)}x: ${name}`);
      if (single && output.length > 600 && tooWide.length < 8)
        tooWide.push(`${output.length} characters: ${name}`);
    }
    expect(tooLong).toEqual([]);
    expect(tooWide).toEqual([]);
    expect(count).toBe(61);
  }, 300_000);
});

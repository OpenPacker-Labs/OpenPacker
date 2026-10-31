import { describe, expect, it } from 'vitest';
import { writtenHostLength } from '../src/url-host.js';
import { hostCall, hostLengthIncludingBlob } from './whatwg-host.js';

/**
 * Hands the event loop a turn. A test that computes for a minute without one
 * starves its vitest worker's answer to the runner (the worker gives up after
 * 60 s: "Timeout calling onTaskUpdate"), which a loaded machine reaches.
 */
const breathe = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * `src/url-host.ts` reads the host of an address with index arithmetic;
 * `whatwg-host.ts` runs the URL Standard's parser states over code points. They
 * were written apart, from different texts, so that one reading's mistake is a
 * disagreement with the other (the first reading of the helper counted `x[:` +
 * payload and `file://` + payload + `@x` as two characters long, and a test
 * written in its own model said so too).
 *
 * The oracle is first checked against the parser it describes: where Node's
 * `new URL` accepts an address and its hostname can be compared, the oracle's
 * host buffer is that hostname. Then the helper is held to the oracle on every
 * string of a small grammar of delimiters and on a seeded random sample.
 */

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

const SCHEMES = [
  'http',
  'https',
  'ws',
  'wss',
  'ftp',
  'file',
  'HtTp',
  'FILE',
  'x',
  'git+ssh',
  'blob',
];

describe('the oracle reads a host as Node does', () => {
  it('on 400,000 addresses that Node accepts, it has the hostname Node reports', async () => {
    const next = seeded(7);
    const pick = <T>(items: readonly T[]) => items[next() % items.length]!;
    const tokens = [
      '/',
      '//',
      '///',
      '\\',
      '\\\\',
      '?',
      '#',
      '@',
      '@',
      ':',
      ':',
      '[',
      ']',
      '\t',
      '\n',
      ' ',
      '\u0001',
      'ab',
      'Cd',
      'xy',
      'ab.cd',
      '.',
      '-',
      'é',
      '%41',
      '80',
    ];
    let accepted = 0;
    let compared = 0;
    const found: string[] = [];
    for (let count = 0; count < 400_000; count += 1) {
      if (count % 2000 === 0) await breathe();
      let address = `${pick(['', '', ' ', '\u0001 '])}${pick([...SCHEMES, 'ht\ttp', 'f\nile'])}:`;
      for (let step = next() % 9; step > 0; step -= 1) address += pick(tokens);
      if (next() % 7 === 0) address += pick(['', ' ', '\t']);
      let url: URL;
      try {
        url = new URL(address);
      } catch {
        continue;
      }
      accepted += 1;
      const call = hostCall(address);
      const hostname = url.hostname;
      if (hostname === '') {
        if (
          call !== undefined &&
          call.special &&
          call.buffer !== '' &&
          !/^[A-Za-z][:|]$/u.test(call.buffer)
        )
          found.push(
            `Node has no host, oracle has ${JSON.stringify(call)}: ${JSON.stringify(address)}`,
          );
        continue;
      }
      // Compare only hosts the parser leaves as written: not an IP address, not
      // percent-decoded, not mapped by IDNA.
      if (
        hostname.startsWith('[') ||
        /^[0-9.]+$/u.test(hostname.split('.').at(-1) ?? '') ||
        /%|xn--/u.test(hostname) ||
        [...hostname].some((point) => point.codePointAt(0)! > 0x7f)
      )
        continue;
      if (call === undefined) {
        found.push(
          `Node has host ${hostname}, oracle none: ${JSON.stringify(address)}`,
        );
        continue;
      }
      if (call.buffer.includes('%')) continue;
      compared += 1;
      const expected = call.special ? call.buffer.toLowerCase() : call.buffer;
      if (hostname !== expected && found.length < 8)
        found.push(
          `${JSON.stringify(address)}: Node ${hostname}, oracle ${JSON.stringify(call)}`,
        );
    }
    expect(found.slice(0, 8)).toEqual([]);
    expect(accepted).toBeGreaterThan(200_000);
    expect(compared).toBeGreaterThan(20_000);
  }, 300_000);
});

describe('the helper reads a host as the oracle does', () => {
  async function disagreements(addresses: Iterable<string>): Promise<string[]> {
    const found: string[] = [];
    let seen = 0;
    for (const address of addresses) {
      if (++seen % 2000 === 0) await breathe();
      const expected = hostLengthIncludingBlob(address);
      const actual = writtenHostLength(address);
      if (actual !== expected && found.length < 8)
        found.push(
          `${JSON.stringify(address)}: helper ${actual}, standard ${expected}`,
        );
    }
    return found;
  }

  it('on every string of nine delimiters up to five long, after every scheme', async () => {
    const delimiters = ['/', '\\', '@', ':', '[', ']', 'a', '?', '#'];
    const everything = function* () {
      for (const scheme of SCHEMES)
        for (const [before, after] of [
          ['', ''],
          ['\u0001 ', ' '],
        ] as const) {
          const walk = function* (
            prefix: string,
            left: number,
          ): Generator<string> {
            yield `${before}${scheme}:${prefix}${after}`;
            if (left === 0) return;
            for (const delimiter of delimiters)
              yield* walk(prefix + delimiter, left - 1);
          };
          yield* walk('', 5);
        }
    };
    expect(await disagreements(everything())).toEqual([]);
  }, 300_000);

  it('on 600,000 strings of longer runs, tabs, spaces, controls and blobs', async () => {
    const next = seeded(99);
    const pick = <T>(items: readonly T[]) => items[next() % items.length]!;
    const tokens = [
      '/',
      '//',
      '\\',
      '?',
      '#',
      '@',
      ':',
      ':',
      '[',
      ']',
      '\t',
      '\n',
      ' ',
      '\u0001',
      'a',
      'bc',
      'é',
      '.',
      '%40',
      '＠',
      '80',
      '::1',
      'http:',
      'https://',
      'file:',
      'blob:',
      'x[',
      '@x',
    ];
    const everything = function* () {
      for (let count = 0; count < 600_000; count += 1) {
        let address = `${pick(['', ' ', '\u0001'])}${pick(SCHEMES)}:`;
        for (let step = 1 + (next() % 11); step > 0; step -= 1)
          address += pick(tokens);
        yield address + pick(['', '', ' ', '\t ']);
      }
    };
    expect(await disagreements(everything())).toEqual([]);
  }, 300_000);

  it('on the families that were counted short, at several sizes', async () => {
    const everything = function* () {
      for (const units of [1, 2, 63, 64, 100, 4096]) {
        const payload = 'ß.é.'.repeat(units);
        const escaped = '%C3%A9.'.repeat(units);
        for (const scheme of [
          'http',
          'https',
          'ws',
          'wss',
          'ftp',
          'file',
          'HTTP',
        ])
          for (const text of payload === '' ? [] : [payload, escaped]) {
            yield `${scheme}://x[:${text}`;
            yield `${scheme}://x[:${text}]`;
            yield `${scheme}://x[${text}:80`;
            yield `${scheme}:// [::1]${text}`;
            yield `${scheme}://u:p@x[:${text}`;
            yield `${scheme}://${text}@x`;
            yield `${scheme}://${text}:pw@h`;
            yield `${scheme}://:${text}`;
            yield `${scheme}://x:${text}`;
            yield `${scheme}://u:${text}@h`;
            yield `${scheme}://${text}@v@h`;
            yield `${scheme}:${text}`;
            yield `${scheme}:/${text}`;
            yield `${scheme}:///${text}`;
            yield `${scheme}:////${text}`;
            yield `${scheme}:\\\\${text}@x`;
            yield `blob:${scheme}://x[:${text}`;
          }
      }
    };
    expect(await disagreements(everything())).toEqual([]);
  }, 300_000);
});

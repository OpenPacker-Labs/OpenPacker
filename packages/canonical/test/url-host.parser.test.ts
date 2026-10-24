import { describe, expect, it } from 'vitest';
import { hasOverlongHost } from '../src/url-host.js';

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
 * `url-host.spec.test.ts` holds the helper to the URL Standard, and the
 * Standard is not what runs: Node's parser (ada) reads some hosts differently,
 * and its cost is what the helper exists for. So this file times the REAL
 * `new URL` on a grid of addresses and holds the helper to that.
 *
 * Every address of the grid carries 32 KiB of `ß.é.` somewhere it could be read
 * as host (the review's forms also with 96 KiB of percent-escaped labels). On the unguarded shapes the parser takes about 60 ms; on anything it
 * reads in linear time it takes well under 2 ms. An address the helper lets
 * through must be the second kind: if it took over 25 ms (three tries, so that
 * a busy machine does not fail the test) the helper missed a way of reading a
 * host. The bound is generous on purpose: the shapes this found took 250 ms at
 * 64 KiB and 106 seconds at 512 KiB.
 */

const PAYLOAD = 'ß.é.'.repeat(8192);
/** Percent-escaped labels are slower to decode and cheaper to write: 96 KiB for the same cost. */
const ESCAPED = '%C3%A9.'.repeat(14043);
const BOUND_MS = 25;

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

function parseMilliseconds(address: string): number {
  const started = cpuMs();
  try {
    new URL(address);
  } catch {
    // Refusing an address is part of the cost.
  }
  return cpuMs() - started;
}

/** The slowest try of the fastest three: noise has to hit every one. */
function stableMilliseconds(address: string): number {
  let best = parseMilliseconds(address);
  for (let tries = 1; tries < 3 && best > BOUND_MS; tries += 1)
    best = Math.min(best, parseMilliseconds(address));
  return best;
}

const SCHEMES = [
  'http:',
  'https:',
  'ws:',
  'wss:',
  'ftp:',
  'HTTP:',
  'Http:',
  'file:',
  'blob:http:',
  'blob:blob:https:',
  'git+https:',
  'x-custom:',
];
const SLASHES = ['//', '', '/', '\\\\', '/\\', '///', '\t//', ' //'];
const USERINFO = ['', 'u@', 'u:p@', 'a@b@', ':@', '@', 'u:p@x[', '[:@'];
/** What the host can start with: stray brackets are the shapes that went wrong. */
const HOSTS = [
  '',
  'h.test',
  'x',
  'x[',
  'x[h.test',
  'a]b[c',
  '[',
  '[x',
  '[::1]',
  'x]',
  '[a]b[',
  'x[y]z[',
  'x[:',
  '][',
];
/** What can follow the stray bracket, up to where the payload begins. */
const DELIMITERS = [
  '',
  '/',
  '?',
  '\\',
  ':',
  ']',
  ';',
  '%2F',
  '#',
  ':80',
  '/p?q',
  '/p#f',
  '@',
  '.',
];
const TAILS = [
  (p: string) => p,
  (p: string) => `${p}#f`,
  (p: string) => `${p}/p`,
];

function* grid(): Generator<string> {
  const next = seeded(0x5eed);
  const pick = <T>(items: readonly T[]) => items[next() % items.length]!;
  // The shapes the review found, by name, then the seeded sample of the product.
  const named = [
    'http://x[h.test/',
    'https://reg.example[/p?',
    'ws://u:p@a]b[c\\',
    'ftp://x[h.test/',
    'wss://x[h.test?',
    'http://u@x[h.test/',
    'http:\\\\x[h.test/',
    'http:x[h.test/',
    'http:///x[h.test/',
  ];
  for (const prefix of named)
    for (const tail of TAILS) {
      yield tail(`${prefix}${PAYLOAD}`);
      yield tail(`${prefix}${ESCAPED}`);
    }
  for (const scheme of SCHEMES)
    for (const slashes of ['//', '\\\\'])
      for (const host of HOSTS)
        for (const delimiter of DELIMITERS)
          yield `${scheme}${slashes}${host}${delimiter}${PAYLOAD}`;
  for (let count = 0; count < 3000; count += 1)
    yield pick(TAILS)(
      `${pick(SCHEMES)}${pick(SLASHES)}${pick(USERINFO)}${pick(HOSTS)}${pick(DELIMITERS)}${PAYLOAD}`,
    );
}

describe('the helper, held to the parser that runs', () => {
  it('withholds, or the parser reads in linear time, every address of the grid', () => {
    const slow: string[] = [];
    let withheld = 0;
    let total = 0;
    for (const address of grid()) {
      total += 1;
      if (hasOverlongHost(address)) {
        withheld += 1;
        continue;
      }
      const milliseconds = stableMilliseconds(address);
      if (milliseconds > BOUND_MS) {
        slow.push(
          `${Math.round(milliseconds)} ms: ${JSON.stringify(address.slice(0, 40))}...`,
        );
        if (slow.length === 8) break;
      }
    }
    expect(slow).toEqual([]);
    // The grid has to be mostly the shapes that matter, or this proves nothing.
    expect(total).toBeGreaterThan(4000);
    expect(withheld).toBeGreaterThan(1500);
  }, 120_000);
});

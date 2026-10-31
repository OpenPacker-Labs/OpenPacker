import { describe, expect, it } from 'vitest';
import { DEFAULT_RETAINED_BYTES, RetentionLedger } from './retention.js';

/**
 * The ledger is how a resolve's memory is bounded: holders say what they keep
 * and what it costs, and the least recently used are told to let go when the
 * total passes the budget. What these hold is the arithmetic, in the order the
 * holders are told.
 */

const record = () => {
  const released: string[] = [];
  return {
    released,
    hold: (ledger: RetentionLedger, key: string, bytes: number) =>
      ledger.retain(key, bytes, () => released.push(key)),
  };
};

describe('the budget', () => {
  it('is 256 MiB unless said', () => {
    expect(DEFAULT_RETAINED_BYTES).toBe(256 * 1024 * 1024);
    expect(new RetentionLedger().maximumBytes).toBe(DEFAULT_RETAINED_BYTES);
  });

  it('refuses a negative or non-numeric one', () => {
    expect(() => new RetentionLedger(-1)).toThrow(RangeError);
    expect(() => new RetentionLedger(Number.NaN)).toThrow(RangeError);
  });

  it('refuses an entry of negative or infinite weight', () => {
    const ledger = new RetentionLedger(10);
    expect(() => ledger.retain('a', -1, () => undefined)).toThrow(RangeError);
    expect(() =>
      ledger.retain('a', Number.POSITIVE_INFINITY, () => undefined),
    ).toThrow(RangeError);
  });
});

describe('what is held', () => {
  it('adds up what the holders say', () => {
    const { hold } = record();
    const ledger = new RetentionLedger(100);
    hold(ledger, 'a', 30);
    hold(ledger, 'b', 20);
    expect(ledger.retainedBytes).toBe(50);
    expect(ledger.entries).toBe(2);
    expect(ledger.evictions).toBe(0);
  });

  it('replaces what a key held, and counts the new weight alone', () => {
    const { hold, released } = record();
    const ledger = new RetentionLedger(100);
    hold(ledger, 'a', 30);
    hold(ledger, 'a', 45);
    expect(ledger.retainedBytes).toBe(45);
    expect(ledger.entries).toBe(1);
    // Replacing is not letting go: the holder that replaced it still has it.
    expect(released).toEqual([]);
  });

  it('forgets an entry the holder dropped itself, without releasing it', () => {
    const { hold, released } = record();
    const ledger = new RetentionLedger(100);
    hold(ledger, 'a', 30);
    ledger.forget('a');
    ledger.forget('never held');
    expect(ledger.retainedBytes).toBe(0);
    expect(released).toEqual([]);
  });
});

describe('over the budget', () => {
  it('releases the least recently used first, until the total fits', () => {
    const { hold, released } = record();
    const ledger = new RetentionLedger(100);
    hold(ledger, 'a', 40);
    hold(ledger, 'b', 40);
    hold(ledger, 'c', 40);
    expect(released).toEqual(['a']);
    expect(ledger.retainedBytes).toBe(80);
    hold(ledger, 'd', 90);
    expect(released).toEqual(['a', 'b', 'c']);
    expect(ledger.retainedBytes).toBe(90);
    expect(ledger.evictions).toBe(3);
  });

  it('counts a use as recent, so the one used is released last', () => {
    const { hold, released } = record();
    const ledger = new RetentionLedger(100);
    hold(ledger, 'a', 40);
    hold(ledger, 'b', 40);
    ledger.touch('a');
    hold(ledger, 'c', 40);
    expect(released).toEqual(['b']);
    expect(ledger.has('a')).toBe(true);
    expect(ledger.has('b')).toBe(false);
  });

  it('does not mind a touch of what it does not hold', () => {
    const ledger = new RetentionLedger(100);
    expect(() => ledger.touch('nothing')).not.toThrow();
  });

  it('releases the new entry too when it alone is over the budget', () => {
    const { hold, released } = record();
    const ledger = new RetentionLedger(100);
    hold(ledger, 'small', 10);
    hold(ledger, 'huge', 500);
    // The small one went first: it was older, and the budget was not met.
    expect(released).toEqual(['small', 'huge']);
    expect(ledger.retainedBytes).toBe(0);
  });

  it('with a budget of nothing, keeps nothing', () => {
    const { hold, released } = record();
    const ledger = new RetentionLedger(0);
    hold(ledger, 'a', 1);
    hold(ledger, 'b', 1);
    expect(released).toEqual(['a', 'b']);
    expect(ledger.retainedBytes).toBe(0);
    expect(ledger.entries).toBe(0);
  });

  it('with an unlimited budget, keeps everything', () => {
    const { hold, released } = record();
    const ledger = new RetentionLedger(Number.POSITIVE_INFINITY);
    for (let index = 0; index < 100; index += 1)
      hold(ledger, `k${index}`, 1_000_000_000);
    expect(released).toEqual([]);
    expect(ledger.retainedBytes).toBe(100_000_000_000);
  });

  it('never leaves more than the budget held, and its peak is the budget plus the one entry being added', () => {
    const { hold } = record();
    const budget = 1_000;
    const ledger = new RetentionLedger(budget);
    let largest = 0;
    for (let index = 0; index < 500; index += 1) {
      const bytes = 1 + ((index * 7919) % 400);
      largest = Math.max(largest, bytes);
      hold(ledger, `k${index % 37}`, bytes);
      expect(ledger.retainedBytes).toBeLessThanOrEqual(budget);
    }
    expect(ledger.peakBytes).toBeLessThanOrEqual(budget + largest);
  });
});

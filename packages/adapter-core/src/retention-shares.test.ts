import { describe, expect, it } from 'vitest';
import { RetentionLedger } from './retention.js';

/**
 * One document's bytes have two holders: the memo keeps the response, and the
 * provider keeps the objects parsed from it and the same bytes. Counted twice,
 * the memo's entry is the older and is released first, which frees nothing (the
 * provider still has the bytes) and loses the memo's answer, so the provider's
 * next use of a document it still holds goes to the origin. An entry that names
 * the bytes it holds (`shares`) takes in an earlier entry that holds the same:
 * the bytes are counted once, and the two are released together.
 */

const body = () => new Uint8Array(100);

function holders(budget: number) {
  const released: string[] = [];
  const ledger = new RetentionLedger(budget);
  const hold = (key: string, bytes: number, shares?: Uint8Array) =>
    ledger.retain(key, bytes, () => released.push(key), {
      ...(!(shares === undefined) && { shares }),
    });
  return { ledger, released, hold };
}

describe('an entry that holds what an earlier one holds', () => {
  it('counts the bytes once, and releases the two together', () => {
    const { ledger, released, hold } = holders(1000);
    const bytes = body();
    hold('memo', 100, bytes);
    hold('provider', 400, bytes);
    expect(ledger.retainedBytes).toBe(400);
    expect(ledger.has('memo')).toBe(true);
    expect(ledger.entries).toBe(2);
    hold('other', 700);
    expect(released).toEqual(['provider', 'memo']);
    expect(ledger.retainedBytes).toBe(700);
    expect(ledger.has('memo')).toBe(false);
  });

  it('is never released before what took it in, and a use of it is a use of that', () => {
    const { ledger, released, hold } = holders(1000);
    const bytes = body();
    hold('memo', 100, bytes);
    hold('provider', 400, bytes);
    hold('other', 300);
    // The memo's answer is the provider's document used again.
    ledger.touch('memo');
    hold('newest', 400);
    expect(released).toEqual(['other']);
    expect(ledger.has('provider')).toBe(true);
    expect(ledger.has('memo')).toBe(true);
  });

  it('stands on its own again, counted, when what took it in is forgotten', () => {
    const { ledger, released, hold } = holders(1000);
    const bytes = body();
    hold('memo', 100, bytes);
    hold('provider', 400, bytes);
    ledger.forget('provider');
    expect(ledger.retainedBytes).toBe(100);
    expect(ledger.has('memo')).toBe(true);
    expect(released).toEqual([]);
  });

  it('keeps what it took in when it is retained again with the same bytes', () => {
    const { ledger, hold } = holders(1000);
    const bytes = body();
    hold('memo', 100, bytes);
    hold('provider', 400, bytes);
    hold('provider', 400, bytes);
    expect(ledger.retainedBytes).toBe(400);
    expect(ledger.has('memo')).toBe(true);
  });

  it('takes back an entry let go before it, at no cost, when that entry can be had again', () => {
    const ledger = new RetentionLedger(450);
    const bytes = body();
    const events: string[] = [];
    ledger.retain('memo', 100, () => events.push('memo let go'), {
      shares: bytes,
      reclaim: () => {
        events.push('memo taken back');
        return true;
      },
    });
    // Another answer arrives before the provider has parsed this one.
    ledger.retain('other', 400, () => events.push('other let go'));
    expect(events).toEqual(['memo let go']);
    ledger.retain('provider', 400, () => events.push('provider let go'), {
      shares: bytes,
    });
    expect(events).toEqual(['memo let go', 'memo taken back', 'other let go']);
    expect(ledger.has('memo')).toBe(true);
    expect(ledger.retainedBytes).toBe(400);
  });

  it('does not take back an entry whose holder has since answered otherwise', () => {
    const ledger = new RetentionLedger(450);
    const bytes = body();
    ledger.retain('memo', 100, () => undefined, {
      shares: bytes,
      reclaim: () => false,
    });
    ledger.retain('other', 400, () => undefined);
    ledger.retain('provider', 400, () => undefined, { shares: bytes });
    expect(ledger.has('memo')).toBe(false);
  });
});

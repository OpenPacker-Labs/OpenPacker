import { describe, expect, it } from 'vitest';
import { json } from './metadata-json.js';

/**
 * A registry's document read with no cost of its own (every registry but npm's
 * packuments) was bounded by a count of values alone: 200,000. A member named
 * by an array index makes V8 give its object an elements store of up to 40 KB,
 * so 66,600 objects `{"1023":0,"2575":0}` (1.3 MB, 199,800 values) ended a
 * process with a heap of 1 GiB. Every document now has a cost limit too.
 */

const response = (text: string) => ({
  status: 200,
  headers: {},
  body: new TextEncoder().encode(text),
  url: 'https://registry.example.test/x',
});
const list = (count: number, piece: string) =>
  `[${Array<string>(count).fill(piece).join(',')}]`;

describe('a registry document read without a cost limit of its own', () => {
  // `{"0":0}` is charged 40,626 bytes, the elements store V8 may give an
  // object whose first member is named by an index, and keeps about 336: its
  // cost reaches the default in 54 KB, with about 2 MB built.
  it('is refused at the default cost limit, under the value count', () => {
    expect(json<unknown[]>(response(list(6_600, '{"0":0}')))).toHaveLength(
      6_600,
    );
    expect(() => json(response(list(6_700, '{"0":0}')))).toThrow(
      /exceeds 268435456 bytes of parsed size/u,
    );
  });

  it('is read whole when it is ordinary, up to the value count', () => {
    expect(json<unknown[]>(response(list(66_000, '{"a":1}')))).toHaveLength(
      66_000,
    );
    expect(() => json(response(list(200_000, '1')))).toThrow(
      /exceeds 200000 values/u,
    );
  });

  it('is held to the cost a caller states instead', () => {
    expect(() =>
      json(response(list(10, '{"a":1}')), { maximumCost: 1_000 }),
    ).toThrow(/exceeds 1000 bytes of parsed size/u);
  });
});

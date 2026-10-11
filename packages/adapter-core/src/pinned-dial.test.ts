import type { LookupAddress } from 'node:dns';
import { createServer } from 'node:http';
import { Agent } from 'undici';
import { describe, expect, it } from 'vitest';
import {
  type PinnedAddress,
  pinnedFetch,
  pinnedLookup,
} from './pinned-dial.js';

interface Answer {
  readonly error: Error | null;
  readonly address: string | readonly LookupAddress[];
  readonly family: number | undefined;
}

function ask(
  lookup: ReturnType<typeof pinnedLookup>,
  options: { all?: boolean },
): Answer {
  let answer: Answer | undefined;
  lookup('registry.test', options, (error, address, family) => {
    answer = { error, address, family };
  });
  if (answer === undefined) throw new Error('lookup did not call back');
  return answer;
}

describe('pinnedLookup', () => {
  const pin: PinnedAddress = { address: '203.0.113.9', family: 4 };

  it('answers with an array when the dialler asks for every address', () => {
    // Node 20+ dials with autoSelectFamily, which sets `all: true`.
    const answer = ask(
      pinnedLookup(() => pin),
      { all: true },
    );
    expect(answer.error).toBeNull();
    expect(answer.address).toEqual([{ address: '203.0.113.9', family: 4 }]);
  });

  it('answers with the single address otherwise', () => {
    const answer = ask(
      pinnedLookup(() => pin),
      {},
    );
    expect(answer.error).toBeNull();
    expect(answer.address).toBe('203.0.113.9');
    expect(answer.family).toBe(4);
  });

  it('refuses to dial when nothing is pinned', () => {
    const answer = ask(
      pinnedLookup(() => undefined),
      { all: true },
    );
    expect(answer.error?.message).toBe('No pinned address');
  });

  it('reads the pin on every call so a redirect can re-pin', () => {
    let current: PinnedAddress = pin;
    const lookup = pinnedLookup(() => current);
    expect(ask(lookup, {}).address).toBe('203.0.113.9');
    current = { address: '2001:db8::1', family: 6 };
    const next = ask(lookup, { all: true });
    expect(next.address).toEqual([{ address: '2001:db8::1', family: 6 }]);
  });
});

describe('a pinned request over a real socket', () => {
  it('dials the pinned address and never asks DNS for the hostname', async () => {
    const server = createServer((_request, response) => {
      response.end('pinned');
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const bound = server.address();
    if (bound === null || typeof bound === 'string')
      throw new Error('server did not bind a TCP port');
    // `.invalid` never resolves, so only the pin can make this connect.
    const agent = new Agent({
      connect: {
        lookup: pinnedLookup(() => ({ address: '127.0.0.1', family: 4 })),
      },
    });
    try {
      // This is the pair the registry transports use. It failed on Node 22
      // with ERR_INVALID_IP_ADDRESS (lookup shape) and, once that was fixed,
      // UND_ERR_INVALID_ARG (an npm undici Agent handed to Node's own fetch).
      const response = await pinnedFetch(
        `http://pinned.invalid:${bound.port}/package`,
        // SAFETY: undici's fetch accepts its own Agent as `dispatcher`; the DOM
        // RequestInit type does not declare the field.
        { dispatcher: agent } as RequestInit,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('pinned');
    } finally {
      await agent.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});

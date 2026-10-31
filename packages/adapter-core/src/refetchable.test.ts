import { describe, expect, it } from 'vitest';
import { BoundedFetchTransport } from './index.js';

/**
 * A holder lets go of a document only when its transport can be asked for it
 * again. The real network transport can; one built over a `fetch` it was handed
 * is answering from whatever that function is, which may replay a sequence of
 * answers, so it does not say it can.
 */
describe('a network transport that can be asked again', () => {
  const allowedOrigins = ['https://registry.test'];

  it('is the one that fetches from the network itself', () => {
    expect(new BoundedFetchTransport({ allowedOrigins }).refetchable).toBe(
      true,
    );
  });

  it('is not one built over a fetch it was given', () => {
    const fetch = (async () => new Response('{}')) as typeof globalThis.fetch;
    expect(
      new BoundedFetchTransport({ allowedOrigins, fetch }).refetchable,
    ).toBe(false);
  });
});

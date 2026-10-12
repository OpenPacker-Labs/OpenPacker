import { describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse } from '@openpacker/adapter-core';
import { PrexRegistryProvider, RegistryClient } from './index.js';

/**
 * What a message says of text from a PREX registry's reply is one line.
 */

const ESC = '\u001b';
const BEL = '\u0007';
const FORGED = `\nopm: internal error: forged\n  - b: forged\n${ESC}[2K${BEL}\nopm: ok installed 1 package`;
const BASE = 'https://registry.example';

function holdsControl(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028;
  });
}

function client(body: string) {
  return new RegistryClient({
    baseUrl: BASE,
    transport: {
      async request(request: HttpRequest): Promise<HttpResponse> {
        return {
          status: 200,
          headers: {},
          body: new TextEncoder().encode(body),
          url: request.url,
        };
      },
    },
  });
}

async function messageOf<T>(run: () => Promise<T>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  throw new Error('nothing was thrown');
}

describe('a reply that is not JSON', () => {
  it('is one line, whatever the parser quotes of it', async () => {
    const message = await messageOf(() =>
      client(`{"registryDefinitionVersion":${FORGED}`).definition(),
    );
    expect(message).toMatch(/^Registry returned a body that is not JSON: /u);
    expect(holdsControl(message)).toBe(false);
  });
});

describe('a purl that is not one', () => {
  it('is one line', async () => {
    const provider = new PrexRegistryProvider(client('{}'));
    const message = await messageOf(() =>
      provider.inspect(`not a purl${FORGED}`),
    );
    expect(message).toMatch(/^Not a PURL: not a purl/u);
    expect(holdsControl(message)).toBe(false);
  });
});

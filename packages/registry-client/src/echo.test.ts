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

describe('a definition or an entry that leaves out the text a message repeats', () => {
  function registry(definition: string) {
    return new RegistryClient({
      baseUrl: BASE,
      transport: {
        async request(request: HttpRequest): Promise<HttpResponse> {
          return {
            status: 200,
            headers: {},
            body: new TextEncoder().encode(
              request.url.endsWith('prex-registry') ? definition : '{}',
            ),
            url: request.url,
          };
        },
      },
    });
  }

  async function refusal<T>(run: () => Promise<T>) {
    try {
      await run();
    } catch (error) {
      if (error instanceof Error)
        return {
          name: error.constructor.name,
          code: 'code' in error ? error.code : undefined,
          message: error.message,
        };
    }
    throw new Error('nothing was thrown');
  }

  it('keeps PROVIDER_CAPABILITY_MISSING when the definition has no registryId', async () => {
    const definition =
      '{"registryDefinitionVersion":"1","resources":[{"@type":"prex.registry.other/1"}]}';
    const result = await refusal(() => registry(definition).versions('x'));
    expect(result.code).toBe('PROVIDER_CAPABILITY_MISSING');
    expect(result.name).toBe('ProviderError');
    expect(result.message).toMatch(/^Registry undefined does not advertise /u);
  });

  it('keeps DIGEST_MISMATCH when the manifest has no name', async () => {
    // The shape of a registry entry, as a hostile registry could send it.
    const entry = JSON.parse(
      `{"manifest":{"version":"1"},"registryMetadata":{"manifestDigest":` +
        `{"algorithm":"sha256","value":"${'0'.repeat(64)}"}},"signatures":[]}`,
    );
    const definition =
      '{"registryDefinitionVersion":"1","registryId":"r","resources":[{"@type":"x"}]}';
    const result = await refusal(() => registry(definition).verifyEntry(entry));
    expect(result.code).toBe('DIGEST_MISMATCH');
    expect(result.name).toBe('ProviderError');
    expect(result.message).toMatch(/^Registry entry for undefined@1 states /u);
  });
});

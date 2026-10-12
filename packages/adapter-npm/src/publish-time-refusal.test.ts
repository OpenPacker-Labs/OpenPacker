import { describe, expect, it } from 'vitest';
import {
  MetadataLimitError,
  ProviderError,
  ResponseTooLargeError,
  type HttpRequest,
  type HttpResponse,
} from '@openpacker/adapter-core';
import { NpmRegistryProvider } from './index.js';
import { MAXIMUM_FULL_PACKUMENT_BYTES } from './packument-limits.js';

/**
 * The publish time of a recently changed package is in its full packument. If
 * the client refuses that document, "no time" is no longer the whole story: the
 * caller needs to be able to say the document was too large or not usable. A
 * registry that is down, or answers with an error, is still just "no time".
 */

const encoder = new TextEncoder();
const URL = 'https://fixtures.test/demo';
const abbreviated = {
  name: 'demo',
  modified: '2026-07-30T00:00:00.000Z',
  versions: { '1.0.0': { name: 'demo', version: '1.0.0' } },
};
const settledBefore = '2026-07-01T00:00:00.000Z';

type Full = (request: HttpRequest) => HttpResponse | Promise<HttpResponse>;

function registry(full: Full) {
  const fullRequests: HttpRequest[] = [];
  const transport = {
    async request(request: HttpRequest): Promise<HttpResponse> {
      if (request.headers?.accept?.includes('vnd.npm.install-v1') === true)
        return {
          status: 200,
          headers: {},
          body: encoder.encode(JSON.stringify(abbreviated)),
          url: request.url,
        };
      fullRequests.push(request);
      return full(request);
    },
  };
  return {
    provider: new NpmRegistryProvider(
      transport,
      { now: () => '2026-08-02T00:00:00Z' },
      'https://fixtures.test',
    ),
    fullRequests,
  };
}

const ask = (provider: NpmRegistryProvider) =>
  provider.publishTime('pkg:npm/demo@1.0.0', { settledBefore });

const body = (text: string): HttpResponse => ({
  status: 200,
  headers: {},
  body: encoder.encode(text),
  url: URL,
});

describe('a full packument the client refuses', () => {
  it('is a refusal that names the package, the size seen and the limit', async () => {
    const { provider } = registry(() => {
      throw new ResponseTooLargeError(
        MAXIMUM_FULL_PACKUMENT_BYTES,
        MAXIMUM_FULL_PACKUMENT_BYTES + 1,
        'delivered',
        200,
      );
    });
    const error = await ask(provider).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResponseTooLargeError);
    expect((error as Error).message).toBe(
      'The full packument of demo is 100663297 bytes (96.00 MiB) and exceeds the ' +
        'limit of 100663296 bytes (96.00 MiB)',
    );
  });

  it("is a refusal when it is not valid JSON, in the parser's words", async () => {
    const { provider } = registry(() => body('<html>bad gateway</html>'));
    const error = await ask(provider).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'INVALID_PROVIDER_METADATA' });
    expect((error as Error).message).toMatch(
      /^The full packument of demo is not usable: Expected a JSON value/,
    );
  });

  it('is a refusal when it holds more than the parser allows, with how far it got', async () => {
    const { provider } = registry(() => body('['.repeat(100)));
    const error = await ask(provider).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MetadataLimitError);
    expect(error).toMatchObject({
      limit: 'depth',
      maximum: 64,
      message:
        'The full packument of demo is not usable: Provider metadata exceeds depth 64',
    });
  });

  it('is refused once: the same reason, with no second request for the document', async () => {
    const { provider, fullRequests } = registry(() => body('not json'));
    const first = await ask(provider).catch((caught: unknown) => caught);
    const second = await ask(provider).catch((caught: unknown) => caught);
    expect((second as Error).message).toBe((first as Error).message);
    expect(fullRequests).toHaveLength(1);
  });
});

describe('a full packument that could not be had', () => {
  it.each([
    [
      'a registry that is down',
      () => {
        throw new ProviderError('UPSTREAM_ERROR', 'connection refused');
      },
    ],
    [
      'a network failure',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
    [
      'an error status',
      () => ({ status: 503, headers: {}, body: new Uint8Array(), url: URL }),
    ],
  ])('is still no time at all: %s', async (_, respond) => {
    const { provider } = registry(respond);
    expect(await ask(provider)).toBeUndefined();
  });
});

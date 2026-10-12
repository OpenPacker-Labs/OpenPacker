import { describe, expect, it } from 'vitest';
import {
  MetadataLimitError,
  ProviderError,
  ResponseTooLargeError,
  isDocumentRefusal,
  json,
} from './index.js';

/** What `json` throws for a document of more values than it is allowed. */
function tooManyValues(): MetadataLimitError {
  try {
    json(
      {
        status: 200,
        headers: {},
        body: new TextEncoder().encode('[1,1,1,1,1,1]'),
        url: 'https://registry.test/x',
      },
      { maximumNodes: 5 },
    );
  } catch (error) {
    if (error instanceof MetadataLimitError) return error;
    throw error;
  }
  throw new Error('the document was accepted');
}

describe('what counts as a refusal of the document', () => {
  it('is a response too large, or a document that is too big or not JSON', () => {
    expect(isDocumentRefusal(new ResponseTooLargeError(1, 2, 'streamed'))).toBe(
      true,
    );
    expect(tooManyValues()).toBeInstanceOf(MetadataLimitError);
    expect(isDocumentRefusal(tooManyValues())).toBe(true);
    expect(
      isDocumentRefusal(new ProviderError('INVALID_PROVIDER_METADATA', 'x')),
    ).toBe(true);
  });

  it('is not an outage, an error status or a failure that is not a ProviderError', () => {
    expect(isDocumentRefusal(new ProviderError('UPSTREAM_ERROR', 'down'))).toBe(
      false,
    );
    expect(isDocumentRefusal(new ProviderError('OFFLINE', 'offline'))).toBe(
      false,
    );
    expect(isDocumentRefusal(new TypeError('fetch failed'))).toBe(false);
    expect(isDocumentRefusal(undefined)).toBe(false);
  });
});

/** 0xff is never a byte of well-formed UTF-8. */
const NOT_UTF8 = Uint8Array.of(0x5b, 0x22, 0xff, 0xfe, 0x22, 0x5d);

describe('a body that is not text', () => {
  it("is a refused document, not the decoder's own error", () => {
    let caught: unknown;
    try {
      json({ status: 200, headers: {}, body: NOT_UTF8, url: 'https://r.test' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect(caught).toMatchObject({
      code: 'INVALID_PROVIDER_METADATA',
      message: expect.stringMatching(/not valid for encoding utf-8/u) as string,
    });
    expect(isDocumentRefusal(caught)).toBe(true);
  });
});

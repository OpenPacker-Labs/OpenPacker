import { describe, expect, it } from 'vitest';
import { ProviderError } from '@openpacker/adapter-core';
import { parseNugetServiceIndex } from './index.js';

/**
 * A service index is a document the registry wrote, and each resource's `@id`
 * is a URL in it. The adapter caps an `@id` at 4,096 characters, which keeps the
 * URL parser from the half-second it takes on 65,000, so this host is the
 * longest the cap allows: it is not a DNS name, and it is refused by name
 * without the parser reading it or the message repeating it.
 */
const HOST = 'ß.é.'.repeat(1000);

function index(id: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      resources: [{ '@id': id, '@type': 'PackageBaseAddress/3.0.0' }],
    }),
  );
}

describe('a service index with a URL no DNS name could be', () => {
  it.each([
    ['https', `https://${HOST}/flat/`],
    ['a stray bracket', `https://x[${HOST}/flat/`],
    ['userinfo', `https://u:p@${HOST}/flat/`],
  ])('refuses %s', (_name, id) => {
    expect(id.length).toBeLessThanOrEqual(4096);
    let error: unknown;
    try {
      parseNugetServiceIndex(index(id));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProviderError);
    if (!(error instanceof ProviderError)) return;
    expect(error.code).toBe('INVALID_PROVIDER_RESPONSE');
    expect(error.message).toBe(
      'Invalid NuGet service index: resources[0].@id is not a URL',
    );
  });

  it('still accepts the host of an ordinary registry', () => {
    expect(
      parseNugetServiceIndex(index('https://api.nuget.org/v3-flatcontainer/'))
        .resources,
    ).toHaveLength(1);
  });
});

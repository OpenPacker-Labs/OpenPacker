import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  ResponseTooLargeError,
  type CatalogProvider,
} from '@openpacker/adapter-core';
import type { PolicyFacts } from '@openpacker/policy';
import { capturePublishTime } from '../src/supply-chain.js';

/**
 * Capturing a publish time never fails the caller, and it used to say nothing
 * about why it had none. A document the client refused is the reason and is
 * kept on the facts; an outage is not a reason about the document and leaves
 * them as they were.
 */

const facts = (): PolicyFacts => ({
  evidence: [],
  packageId: 'pkg:npm/example-heavy@1.0.0',
  evaluationTime: '2026-10-12T12:00:00Z',
});

const failing = (error: unknown): CatalogProvider =>
  // SAFETY: A provider that can only say when a version was published.
  ({
    async publishTime() {
      throw error;
    },
  }) as unknown as CatalogProvider;

const capture = async (provider: CatalogProvider, signal?: AbortSignal) => {
  const captured = facts();
  await capturePublishTime(captured, provider, 'pkg:npm/example-heavy@1.0.0', {
    minimumReleaseAgeMinutes: 1440,
    ...(signal && { signal }),
  });
  return captured;
};

describe('when the registry document that holds the publish time was refused', () => {
  it.each([
    [
      'too large',
      new ResponseTooLargeError(
        10,
        11,
        'delivered',
        200,
        'The full packument of example-heavy',
      ),
    ],
    [
      'not usable',
      new ProviderError(
        'INVALID_PROVIDER_METADATA',
        'The full packument of example-heavy is not usable: Expected a JSON value',
      ),
    ],
  ])('the reason is kept: %s', async (_, error) => {
    const captured = await capture(failing(error));
    expect(captured.publishTimeUnavailable).toBe(error.message);
    expect(captured.publishedAt).toBeUndefined();
  });
});

describe('when there is no time for any other reason', () => {
  it.each([
    [
      'a provider error that is not about the document',
      new ProviderError('UPSTREAM_ERROR', 'down'),
    ],
    ['a network failure', new TypeError('fetch failed')],
  ])('nothing is said: %s', async (_, error) => {
    const captured = await capture(failing(error));
    expect(captured.publishTimeUnavailable).toBeUndefined();
  });

  it('and an abort is still an abort', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      capture(
        failing(new ProviderError('INVALID_PROVIDER_METADATA', 'x')),
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

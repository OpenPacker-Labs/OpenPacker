import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatchersV3, PactV4 } from '@pact-foundation/pact';
import {
  createOpenPackerClient,
  UnsupportedProtocolVersionError,
} from '@openpacker/sdk';
import { describe, expect, it } from 'vitest';

const digest = '0'.repeat(64);

describe('Epoch consumer Pact chaos', () => {
  it('fails closed across malformed, incomplete, transient, and skewed responses', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openpacker-pact-chaos-'));
    const pact = new PactV4({
      consumer: 'Epoch PREX Chaos Consumer',
      provider: 'OpenPacker PREX Provider',
      dir: directory,
      logLevel: 'error',
    });
    try {
      await pact
        .addInteraction()
        .uponReceiving('malformed PREX discovery JSON')
        .withRequest('GET', '/.well-known/prex')
        .willRespondWith(200, (response) =>
          response.body('application/json', Buffer.from('{')),
        )
        .executeTest(async ({ url }) =>
          expect(
            createOpenPackerClient({ baseUrl: url }).discovery(),
          ).rejects.toBeInstanceOf(SyntaxError),
        );

      await pact
        .addInteraction()
        .uponReceiving('an event page without a checkpoint')
        .withRequest('GET', '/v1/events', (request) =>
          request
            .query({ cursor: '0', limit: '1000' })
            .headers({ accept: 'application/x-ndjson' }),
        )
        .willRespondWith(200, (response) =>
          response.body('application/x-ndjson', Buffer.alloc(0)),
        )
        .executeTest(async ({ url }) =>
          expect(
            createOpenPackerClient({ baseUrl: url }).eventPage(),
          ).rejects.toThrow('omitted a valid next cursor'),
        );

      await pact
        .addInteraction()
        .uponReceiving('a transient receipt outage')
        .withRequest('GET', `/v1/receipts/sha256/${digest}`)
        .willRespondWith(503, (response) =>
          response.jsonBody(
            MatchersV3.like({
              type: 'https://openpacker.dev/problems/upstream-unavailable',
              title: 'Upstream unavailable',
              status: 503,
              code: 'UPSTREAM_UNAVAILABLE',
              retryable: true,
            }),
          ),
        )
        .executeTest(async ({ url }) =>
          expect(
            createOpenPackerClient({ baseUrl: url }).receipt('sha256', digest),
          ).rejects.toMatchObject({
            status: 503,
            problem: { code: 'UPSTREAM_UNAVAILABLE', retryable: true },
          }),
        );

      await pact
        .addInteraction()
        .uponReceiving('an unsupported PREX provider version')
        .withRequest('GET', '/.well-known/prex')
        .willRespondWith(200, (response) =>
          response.jsonBody({
            meta: { protocolVersion: '2.0' },
            protocolVersions: ['2.0'],
          }),
        )
        .executeTest(async ({ url }) =>
          expect(
            createOpenPackerClient({ baseUrl: url }).discovery(),
          ).rejects.toBeInstanceOf(UnsupportedProtocolVersionError),
        );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

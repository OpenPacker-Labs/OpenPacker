import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MatchersV3,
  PactV4,
  SpecificationVersion,
} from '@pact-foundation/pact';
import type { SignedReceipt, SolveRequest } from '@openpacker/contracts';
import { canonicalEventBytes, createCloudEvent } from '@openpacker/events';
import { createOpenPackerClient, PrexClientError } from '@openpacker/sdk';
import { format } from 'prettier';
import { describe, expect, it } from 'vitest';
import { EPOCH_PACT_RECEIPT_DIGEST } from '../src/provider-fixture.js';
import { EpochEventConsumer, InMemoryEpochConsumerPort } from '../src/index.js';

const root = new URL('../../../', import.meta.url);
const committedPact = fileURLToPath(
  new URL('pacts/Epoch PREX Consumer-OpenPacker PREX Provider.json', root),
);
const request = JSON.parse(
  await readFile(new URL('fixtures/protocol/solve/request.json', root), 'utf8'),
) as SolveRequest;
const signed = JSON.parse(
  await readFile(new URL('fixtures/epoch/signed-receipt.json', root), 'utf8'),
) as SignedReceipt;
const digest = (value: string) => ({
  algorithm: 'sha256' as const,
  value: value.repeat(64),
});
const meta = {
  protocolVersion: '1.0-draft',
  provider: {
    id: 'org.openpacker.reference',
    implementation: 'openpackerd',
    version: '0.1.0',
  },
};
const json = {
  'content-type': MatchersV3.regex(
    /^application\/json(?:; charset=utf-8)?$/iu,
    'application/json',
  ),
};

function pact(directory: string): PactV4 {
  return new PactV4({
    consumer: 'Epoch PREX Consumer',
    provider: 'OpenPacker PREX Provider',
    dir: directory,
    spec: SpecificationVersion.SPECIFICATION_VERSION_V4,
    logLevel: 'warn',
  });
}

describe('Epoch consumer Pact V4', () => {
  it('generates the complete real-route consumer contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openpacker-pact-'));
    const contract = pact(directory);
    try {
      await contract
        .addInteraction()
        .given('the PREX reference provider is ready')
        .uponReceiving('PREX capability discovery')
        .withRequest('GET', '/.well-known/prex')
        .willRespondWith(200, (response) =>
          response
            .headers(json)
            .jsonBody(
              MatchersV3.like({ meta, protocolVersions: ['1.0-draft'] }),
            ),
        )
        .executeTest(async ({ url }) =>
          expect(
            (await createOpenPackerClient({ baseUrl: url }).discovery()).data
              .protocolVersions,
          ).toContain('1.0-draft'),
        );

      await contract
        .addInteraction()
        .given('a deterministic PREX solve is available')
        .uponReceiving('a PREX solve request')
        .withRequest('POST', '/v1/solve', (builder) =>
          builder.headers(json).jsonBody(request),
        )
        .willRespondWith(200, (response) =>
          response.headers(json).jsonBody(
            MatchersV3.like({
              meta,
              solution: { solutionDigest: digest('6') },
              signedReceipt: signed,
            }),
          ),
        )
        .executeTest(async ({ url }) =>
          expect(
            (await createOpenPackerClient({ baseUrl: url }).solve(request)).data
              .signedReceipt,
          ).toBeDefined(),
        );

      const verifyRequest = {
        subject: signed,
        checks: ['prex-receipt-signature'],
        evaluationTime: request.evaluationTime,
      };
      await contract
        .addInteraction()
        .given('receipt signature verification is configured')
        .uponReceiving('a signed receipt verification request')
        .withRequest('POST', '/v1/verify', (builder) =>
          builder.headers(json).jsonBody(verifyRequest),
        )
        .willRespondWith(200, (response) =>
          response.headers(json).jsonBody(
            MatchersV3.like({
              meta,
              decision: 'allow',
              evidence: [{ type: 'prex-receipt-signature', status: 'valid' }],
            }),
          ),
        )
        .executeTest(async ({ url }) =>
          expect(
            (
              await createOpenPackerClient({ baseUrl: url }).verify(
                verifyRequest,
              )
            ).data.decision,
          ).toBe('allow'),
        );

      await contract
        .addInteraction()
        .given('a signed receipt exists')
        .uponReceiving('an immutable signed receipt request')
        .withRequest(
          'GET',
          MatchersV3.fromProviderState(
            'receiptPath',
            `/v1/receipts/sha256/${EPOCH_PACT_RECEIPT_DIGEST}`,
          ),
        )
        .willRespondWith(200, (response) =>
          response.headers(json).jsonBody(MatchersV3.like(signed)),
        )
        .executeTest(async ({ url }) =>
          expect(
            (
              await createOpenPackerClient({ baseUrl: url }).receipt(
                'sha256',
                EPOCH_PACT_RECEIPT_DIGEST,
              )
            ).data,
          ).toEqual(signed),
        );

      const event = await createCloudEvent({
        type: 'org.openpacker.receipt.created',
        source: 'urn:openpacker:pact-provider',
        subject: `sha256:${EPOCH_PACT_RECEIPT_DIGEST}`,
        correlationId: 'epoch-pact',
        clock: { now: () => '2026-08-02T00:00:00.000Z' },
        data: { schemaVersion: '1', receiptDigest: signed.receiptDigest },
      });
      await contract
        .addInteraction()
        .given('a canonical OpenPacker event exists')
        .uponReceiving('the OpenPacker NDJSON event feed')
        .withRequest('GET', '/v1/events', (builder) =>
          builder
            .query({ cursor: '0', limit: '1000' })
            .headers({ accept: 'application/x-ndjson' }),
        )
        .willRespondWith(200, (response) =>
          response
            .body(
              'application/json',
              Buffer.concat([canonicalEventBytes(event), Buffer.from('\n')]),
            )
            .headers({
              'content-type': MatchersV3.regex(
                /^application\/x-ndjson(?:; charset=utf-8)?$/iu,
                'application/x-ndjson',
              ),
              'x-openpacker-next-cursor': MatchersV3.regex(
                /^(?:0|[1-9][0-9]*)$/u,
                '1',
              ),
            }),
        )
        .executeTest(async ({ url }) => {
          const port = new InMemoryEpochConsumerPort();
          const consumer = new EpochEventConsumer(port);
          for await (const item of createOpenPackerClient({
            baseUrl: url,
          }).events())
            await consumer.consume(item);
          expect(port.events.get(event.id)?.bytes).toEqual(
            canonicalEventBytes(event),
          );
        });

      await contract
        .addInteraction()
        .given('the PREX reference provider is ready')
        .uponReceiving('an unknown route RFC 9457 error')
        .withRequest('GET', '/v1/not-a-route')
        .willRespondWith(404, (response) =>
          response
            .headers({
              'content-type': MatchersV3.regex(
                /^application\/problem\+json(?:; charset=utf-8)?$/iu,
                'application/problem+json',
              ),
            })
            .jsonBody(
              MatchersV3.like({
                type: 'https://openpacker.dev/problems/package-not-found',
                title: 'Route not found',
                status: 404,
                code: 'PACKAGE_NOT_FOUND',
                retryable: false,
              }),
            ),
        )
        .executeTest(async ({ url }) => {
          const response = await fetch(new URL('/v1/not-a-route', url));
          expect(response.status).toBe(404);
          expect((await response.json()) as { code: string }).toMatchObject({
            code: 'PACKAGE_NOT_FOUND',
          });
        });

      expect(PrexClientError).toBeDefined();
      const generated = await format(
        await readFile(
          join(directory, 'Epoch PREX Consumer-OpenPacker PREX Provider.json'),
          'utf8',
        ),
        { parser: 'json' },
      );
      expect(generated).toBe(await readFile(committedPact, 'utf8'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});

import { readFile } from 'node:fs/promises';
import type { SolveRequest } from '@openpacker/contracts';
import { createOpenPackerClient } from '@openpacker/sdk';
import { Ed25519Verifier } from '@openpacker/trust';
import { describe, expect, it } from 'vitest';
import {
  consumeEvents,
  consumeResolution,
  EpochEventConsumer,
  InMemoryEpochConsumerPort,
} from '../src/index.js';
import { startEpochPactProvider } from '../src/provider-fixture.js';

const root = new URL('../../../', import.meta.url);

describe('real openpackerd Epoch boundary', () => {
  it('preserves SDK receipt and event bytes through the neutral port', async () => {
    const server = await startEpochPactProvider();
    try {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const request = JSON.parse(
        await readFile(
          new URL('fixtures/protocol/solve/request.json', root),
          'utf8',
        ),
      ) as SolveRequest;
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const keys = JSON.parse(
        await readFile(new URL('fixtures/trust/keys.json', root), 'utf8'),
      ) as { root: JsonWebKey };
      const verifier = await Ed25519Verifier.fromJwk('root', keys.root);
      const client = createOpenPackerClient({ baseUrl: server.address });
      const port = new InMemoryEpochConsumerPort();
      const receipt = await consumeResolution({
        client,
        request,
        port,
        receiptVerifiers: new Map([['root', verifier]]),
      });
      const events = await consumeEvents(client, new EpochEventConsumer(port));
      expect(
        port.receipts.get(receipt.openPackerDigest)?.bytes.byteLength,
      ).toBeGreaterThan(0);
      expect(port.events.size).toBe(events.length);
      expect([...port.events.values()].map(({ event }) => event.type)).toEqual(
        expect.arrayContaining([
          'org.openpacker.resolution.completed',
          'org.openpacker.receipt.created',
        ]),
      );
      expect(port.eventCheckpoint).toBeGreaterThanOrEqual(events.length);
      expect(receipt.externalRefs[0]?.locator).toBe(
        `urn:epoch:blob:${receipt.openPackerDigest}`,
      );

      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const replayClient = {
        solve: () => client.solve(request),
        verify: client.verify.bind(client),
        receipt: client.receipt.bind(client),
      } as unknown as typeof client;
      await expect(
        consumeResolution({
          client: replayClient,
          request: {
            ...request,
            evaluationTime: '2026-08-03T00:00:00.000Z',
          },
          port: new InMemoryEpochConsumerPort(),
          receiptVerifiers: new Map([['root', verifier]]),
        }),
      ).rejects.toThrow(/does not bind the requested solve input/u);
    } finally {
      await server.close();
    }
  });
}, 30_000);

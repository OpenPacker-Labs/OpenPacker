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
      const request = JSON.parse(
        await readFile(
          new URL('fixtures/protocol/solve/request.json', root),
          'utf8',
        ),
      ) as SolveRequest;
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
    } finally {
      await server.close();
    }
  });
}, 30_000);

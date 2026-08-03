import { describe, expect, it } from 'vitest';
import { canonicalEventBytes, createCloudEvent } from '@openpacker/events';
import type { OpenPackerClient } from '@openpacker/sdk';
import {
  consumeEvents,
  EpochEventConsumer,
  InMemoryEpochConsumerPort,
} from '../src/index.js';

describe('neutral Epoch consumer boundary', () => {
  it('preserves canonical event bytes and consumes duplicates idempotently', async () => {
    const event = await createCloudEvent({
      type: 'org.openpacker.resolution.completed',
      source: 'urn:openpacker:fixture',
      subject: 'pkg:npm/%40openpacker/demo-tool@1.0.0',
      correlationId: 'epoch-contract',
      clock: { now: () => '2026-08-02T00:00:00.000Z' },
      data: {
        schemaVersion: '1',
        solutionDigest: { algorithm: 'sha256', value: 'a'.repeat(64) },
        requestDigest: { algorithm: 'sha256', value: 'b'.repeat(64) },
        universeDigest: { algorithm: 'sha256', value: 'c'.repeat(64) },
      },
    });
    const bytes = canonicalEventBytes(event);
    const port = new InMemoryEpochConsumerPort();
    const consumer = new EpochEventConsumer(port);
    const first = await consumer.consume({ event, rawBytes: bytes });
    const duplicate = await consumer.consume({ event, rawBytes: bytes });
    expect(port.events.size).toBe(1);
    expect(port.events.get(event.id)?.bytes).toEqual(bytes);
    expect(first.externalRefs).toHaveLength(1);
    expect(duplicate.externalRefs).toHaveLength(0);
    expect(event.externalrefs).toEqual([]);
  });

  it('commits page checkpoints and resumes through the neutral port', async () => {
    const event = await createCloudEvent({
      type: 'org.openpacker.receipt.created',
      source: 'urn:openpacker:fixture',
      subject: `sha256:${'a'.repeat(64)}`,
      correlationId: 'epoch-contract',
      clock: { now: () => '2026-08-02T00:00:00.000Z' },
      data: {
        schemaVersion: '1',
        receiptDigest: { algorithm: 'sha256', value: 'a'.repeat(64) },
      },
    });
    const cursors: number[] = [];
    const client = {
      async eventPage(cursor: number) {
        cursors.push(cursor);
        return cursor === 0
          ? {
              events: [{ event, rawBytes: canonicalEventBytes(event) }],
              nextCursor: 7,
            }
          : { events: [], nextCursor: cursor };
      },
    } as unknown as OpenPackerClient;
    const port = new InMemoryEpochConsumerPort();
    await consumeEvents(client, new EpochEventConsumer(port), undefined, 1);
    await consumeEvents(client, new EpochEventConsumer(port), undefined, 1);
    expect(cursors).toEqual([0, 7, 7]);
    expect(port.eventCheckpoint).toBe(7);
    expect(port.events.size).toBe(1);
  });
});

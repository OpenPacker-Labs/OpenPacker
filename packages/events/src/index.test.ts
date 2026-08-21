import { describe, expect, it } from 'vitest';
import {
  canonicalEventBytes,
  createCloudEvent,
  decodeCloudEvent,
  EVENT_OCCURRENCE_ID_EXTENSION,
  MemoryEventSink,
  verifyCloudEvent,
} from './index.js';
import type { OpenPackerCloudEvent } from '@openpacker/contracts';

const digest = (character: string) => ({
  algorithm: 'sha256' as const,
  value: character.repeat(64),
});
const clock = { now: () => '2026-08-02T00:00:00.000Z' };

describe('OpenPacker CloudEvents', () => {
  it('derives stable IDs and digests and preserves exact canonical bytes', async () => {
    const input = {
      type: 'org.openpacker.resolution.completed' as const,
      source: 'urn:openpacker:test',
      subject: 'pkg:npm/%40openpacker/demo-tool@1.0.0',
      correlationId: 'demo',
      clock,
      data: {
        schemaVersion: '1' as const,
        solutionDigest: digest('a'),
        requestDigest: digest('b'),
        universeDigest: digest('c'),
      },
    };
    const first = await createCloudEvent(input);
    const second = await createCloudEvent(input);
    expect(second).toEqual(first);
    expect(await decodeCloudEvent(canonicalEventBytes(first))).toEqual(first);
  });

  it('uses the JSON transport form for optional undefined data fields', async () => {
    const event = await createCloudEvent({
      type: 'org.openpacker.artifact.packed',
      source: 'urn:openpacker:test',
      subject: 'sha256:subject',
      correlationId: 'demo',
      clock,
      data: {
        schemaVersion: '1',
        descriptor: {
          descriptorId: 'demo',
          digest: digest('d'),
          size: 0,
          mediaType: 'application/octet-stream',
          artifactType: 'demo',
          fileName: undefined,
          nativeRole: 'native-package',
          locations: [],
          referrers: [],
          externalRefs: [],
        },
      },
    });
    expect(() => canonicalEventBytes(event)).not.toThrow();
    expect(event.data.descriptor).not.toHaveProperty('fileName');
  });

  it('requires occurrence identity for observations and deduplicates replay', async () => {
    await expect(
      createCloudEvent({
        type: 'org.openpacker.policy.evaluated',
        source: 'urn:openpacker:test',
        subject: 'sha256:subject',
        correlationId: 'demo',
        clock,
        data: {
          schemaVersion: '1',
          subjectDigest: digest('d'),
          decision: 'allow',
        },
      }),
    ).rejects.toThrow('occurrence ID');
    const event = await createCloudEvent({
      type: 'org.openpacker.policy.evaluated',
      source: 'urn:openpacker:test',
      subject: 'sha256:subject',
      correlationId: 'demo',
      occurrenceId: 'policy-run-1',
      clock,
      data: {
        schemaVersion: '1',
        subjectDigest: digest('d'),
        decision: 'allow',
      },
    });
    const sink = new MemoryEventSink();
    const bytes = canonicalEventBytes(event);
    expect(
      (await sink.publish({ event, canonicalBytes: bytes })).duplicate,
    ).toBe(false);
    expect(
      (await sink.publish({ event, canonicalBytes: bytes })).duplicate,
    ).toBe(true);
    expect(sink.replay('0')).toHaveLength(1);
    expect(event.extensions?.[EVENT_OCCURRENCE_ID_EXTENSION]).toBe(
      'policy-run-1',
    );
  });

  it('rejects schema-invalid data and forged deterministic identities', async () => {
    const event = await createCloudEvent({
      type: 'org.openpacker.resolution.completed',
      source: 'urn:openpacker:test',
      subject: 'pkg:npm/%40openpacker/demo-tool@1.0.0',
      correlationId: 'demo',
      clock,
      data: {
        schemaVersion: '1',
        solutionDigest: digest('a'),
        requestDigest: digest('b'),
        universeDigest: digest('c'),
      },
    });
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const invalidData = structuredClone(event) as {
      data: Record<string, unknown>;
    };
    invalidData.data.solutionDigest = 'not-a-digest';
    await expect(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      verifyCloudEvent(invalidData as OpenPackerCloudEvent),
    ).rejects.toThrow('contract violation');

    const forged = structuredClone(event);
    forged.id = 'forged';
    await expect(verifyCloudEvent(forged)).rejects.toThrow(
      'deterministic identity',
    );
  });

  it('retains event-ID deduplication after replay records are evicted', async () => {
    const make = (character: string) =>
      createCloudEvent({
        type: 'org.openpacker.receipt.created',
        source: 'urn:openpacker:test',
        subject: `sha256:${character.repeat(64)}`,
        correlationId: 'demo',
        clock,
        data: { schemaVersion: '1' as const, receiptDigest: digest(character) },
      });
    const first = await make('a');
    const second = await make('b');
    const sink = new MemoryEventSink(1);
    const publish = (event: OpenPackerCloudEvent) =>
      sink.publish({ event, canonicalBytes: canonicalEventBytes(event) });
    const initial = await publish(first);
    await publish(second);
    const duplicate = await publish(first);
    expect(duplicate).toEqual({ ...initial, duplicate: true });
    expect(sink.replay('0').map(({ event }) => event.id)).toEqual([second.id]);
    expect(() => sink.replay('9007199254740992')).toThrow('safe integer');
  });
});

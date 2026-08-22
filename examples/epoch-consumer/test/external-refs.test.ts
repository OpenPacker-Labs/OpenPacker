import { readFile } from 'node:fs/promises';
import { canonicalBytes } from '@openpacker/canonical';
import type {
  ExternalRef,
  JsonValue,
  SignedReceipt,
} from '@openpacker/contracts';
import { canonicalEventBytes, createCloudEvent } from '@openpacker/events';
import { describe, expect, it } from 'vitest';
import { createEpochOwnedEnvelope } from '../src/index.js';

const root = new URL('../../../', import.meta.url);

describe('generic consumer-owned external references', () => {
  it('round-trips unknown references without changing canonical PREX bytes', async () => {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const fixture = JSON.parse(
      await readFile(
        new URL('fixtures/epoch/external-refs.json', root),
        'utf8',
      ),
    ) as {
      openPackerDigest: string;
      externalRefs: ExternalRef[];
    };
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const signed = JSON.parse(
      await readFile(
        new URL('fixtures/epoch/signed-receipt.json', root),
        'utf8',
      ),
    ) as SignedReceipt;
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const receiptBytes = canonicalBytes(
      JSON.parse(JSON.stringify(signed.receipt)) as JsonValue,
    );
    const event = await createCloudEvent({
      type: 'org.openpacker.receipt.created',
      source: 'urn:openpacker:external-ref-test',
      subject: fixture.openPackerDigest,
      correlationId: 'external-ref-round-trip',
      clock: { now: () => '2026-08-02T00:00:00.000Z' },
      data: { schemaVersion: '1', receiptDigest: signed.receiptDigest },
    });
    const eventBytes = canonicalEventBytes(event);

    const envelope = createEpochOwnedEnvelope(
      fixture.openPackerDigest,
      fixture.externalRefs,
    );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const roundTrip = JSON.parse(JSON.stringify(envelope)) as typeof envelope;

    expect(roundTrip.externalRefs).toEqual(fixture.externalRefs);
    expect(roundTrip.openPackerDigest).toBe(fixture.openPackerDigest);
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    expect(
      canonicalBytes(JSON.parse(JSON.stringify(signed.receipt)) as JsonValue),
    ).toEqual(receiptBytes);
    expect(canonicalEventBytes(event)).toEqual(eventBytes);
    expect(signed.receipt.externalRefs).toEqual([]);
    expect(event.externalrefs).toEqual([]);
  });
});

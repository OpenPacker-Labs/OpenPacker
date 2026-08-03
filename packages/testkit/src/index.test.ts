import { describe, expect, it } from 'vitest';
import { createCloudEvent, MemoryEventSink } from '@openpacker/events';
import {
  assertConforms,
  checkEvidenceVerifier,
  checkEventSink,
  checkExtensionDescriptor,
  type ExtensionDescriptor,
} from './index.js';

const descriptor: ExtensionDescriptor = {
  id: 'dev.openpacker.fixture-events',
  version: '1.0.0',
  capabilities: ['events.publish'],
  configurationSchema: { type: 'object', additionalProperties: false },
  supportedProtocolVersions: ['1.0-draft'],
  determinism: 'input-deterministic',
  securityBoundaries: ['Accepts validated canonical CloudEvents only'],
  diagnostics: [],
};

describe('extension conformance', () => {
  it('rejects incomplete descriptors', () => {
    expect(() =>
      assertConforms(
        checkExtensionDescriptor({ ...descriptor, capabilities: [] }),
      ),
    ).toThrow('capabilities');
  });

  it('checks an event sink with canonical bytes', async () => {
    const event = await createCloudEvent({
      type: 'org.openpacker.receipt.created',
      source: 'urn:openpacker:testkit',
      subject: 'sha256:receipt',
      correlationId: 'testkit',
      clock: { now: () => '2026-08-02T00:00:00.000Z' },
      data: {
        schemaVersion: '1',
        receiptDigest: { algorithm: 'sha256', value: 'a'.repeat(64) },
      },
    });
    const report = await checkEventSink(
      { descriptor, implementation: new MemoryEventSink() },
      event,
    );
    assertConforms(report);
    expect(report.checks.every((check) => check.passed)).toBe(true);
  });

  it('reports missing extension methods before invoking them', async () => {
    const report = await checkEventSink(
      { descriptor, implementation: {} as never },
      {} as never,
    );
    expect(report.checks).toContainEqual({
      name: 'method:publish',
      passed: false,
      detail: 'Extension is missing publish()',
    });
    expect(() => assertConforms(report)).toThrow('method:publish');
  });

  it('exercises deterministic evidence verifier results', async () => {
    let calls = 0;
    const evaluationTime = '2026-08-02T00:00:00.000Z';
    const report = await checkEvidenceVerifier(
      {
        descriptor: {
          ...descriptor,
          id: 'dev.openpacker.fixture-evidence',
          capabilities: ['evidence.verify'],
        },
        implementation: {
          async verify(input) {
            calls += 1;
            return {
              type: 'fixture',
              subjectDigest: {
                algorithm: 'sha256',
                value: 'a'.repeat(64),
              },
              status: 'valid',
              verifier: { implementation: 'fixture', version: '1.0.0' },
              evaluationTime: input.evaluationTime,
              policyRelevant: true,
              diagnostics: [],
            };
          },
        },
      },
      { subject: {}, evidence: {}, evaluationTime },
    );
    assertConforms(report);
    expect(calls).toBe(2);
  });
});

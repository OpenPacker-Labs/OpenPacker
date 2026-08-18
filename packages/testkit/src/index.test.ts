import { describe, expect, it } from 'vitest';
import { createCloudEvent, MemoryEventSink } from '@openpacker/events';
import {
  descriptorForBytes,
  streamFromBytes,
} from '@openpacker/artifact-model';
import {
  assertConforms,
  checkArtifactSink,
  checkArtifactSource,
  checkClock,
  checkCredentialResolver,
  checkEvidenceVerifier,
  checkEventSink,
  checkExtensionDescriptor,
  checkPolicyRule,
  checkReceiptSigner,
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

  it('checks artifact, policy, credential, clock, and signer extensions', async () => {
    const bytes = new TextEncoder().encode('fixture');
    const artifact = await descriptorForBytes({
      bytes,
      descriptorId: 'fixture',
      mediaType: 'application/octet-stream',
      artifactType: 'application/vnd.openpacker.package',
      nativeRole: 'package',
    });
    const extension = (id: string, implementation: object) => ({
      descriptor: { ...descriptor, id },
      implementation,
    });
    assertConforms(
      await checkArtifactSource(
        extension('dev.openpacker.fixture-source', {
          async stat() {
            return { descriptor: artifact, rangeSupported: false };
          },
          async open() {
            return streamFromBytes(bytes);
          },
          async listReferrers() {
            return [];
          },
        }),
        artifact,
        bytes,
      ),
    );
    assertConforms(
      await checkArtifactSink(
        extension('dev.openpacker.fixture-sink', {
          async putBlob() {
            return artifact;
          },
          async putManifest() {
            return artifact;
          },
          async attachReferrer() {},
        }),
        artifact,
        bytes,
      ),
    );
    assertConforms(
      await checkPolicyRule(
        extension('dev.openpacker.fixture-policy', {
          async evaluate() {
            return { status: 'valid' as const, code: 'OK', message: 'ok' };
          },
        }),
        {},
      ),
    );
    assertConforms(
      await checkClock(
        extension('dev.openpacker.fixture-clock', {
          now: () => '2026-08-18T00:00:00Z',
        }),
      ),
    );
    assertConforms(
      await checkCredentialResolver(
        extension('dev.openpacker.fixture-credentials', {
          async resolve() {
            return { token: 'secret' };
          },
        }),
        'secret://fixture',
      ),
    );
    const signer = {
      algorithm: 'fixture',
      keyId: 'fixture',
      async sign(message: Uint8Array) {
        return message;
      },
    };
    assertConforms(
      await checkReceiptSigner(
        extension('dev.openpacker.fixture-signer', signer),
        {
          algorithm: 'fixture',
          keyId: 'fixture',
          async verify(message, signature) {
            return message.every((byte, index) => byte === signature[index]);
          },
        },
      ),
    );
  });
});

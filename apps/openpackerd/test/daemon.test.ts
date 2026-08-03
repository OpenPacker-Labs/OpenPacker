import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as bindings from '@openpacker/embedded/wasm-node';
import { createEmbeddedResolver } from '@openpacker/embedded';
import { Ed25519Signer, Ed25519Verifier } from '@openpacker/trust';
import type {
  JsonValue,
  PackageInstance,
  ResolutionUniverse,
  SolveRequest,
} from '@openpacker/contracts';
import { createOpenPackerDaemon } from '../src/index.js';
import {
  createReferenceOperations,
  OperationError,
} from '../src/operations.js';

const digest = (character: string) => ({
  algorithm: 'sha256' as const,
  value: character.repeat(64),
});
const source = {
  type: 'metadata' as const,
  uri: 'https://fixtures.openpacker.dev/catalog',
};

function packageInstance(character: string, version: string): PackageInstance {
  const nodeId = `sha256:${character.repeat(64)}`;
  return {
    nodeId,
    identity: {
      canonicalPurl: 'pkg:npm/%40openpacker/demo-tool',
      exactPurl: `pkg:npm/%40openpacker/demo-tool@${version}`,
      purlType: 'npm',
      namespace: '@openpacker',
      name: 'demo-tool',
      version,
      qualifiers: {},
      nativeCoordinates: [
        { ecosystem: 'npm', coordinate: '@openpacker/demo-tool', version },
      ],
      aliases: [],
      sourceRefs: [source],
      publisherRefs: [],
      externalRefs: [],
    },
    nativeVersion: version,
    normalizedVersion: version,
    versionSortKey: version,
    requirements: [],
    capabilities: [],
    conflicts: [],
    cardinalityConstraints: [],
    artifacts: [],
    lifecycle: { status: 'published', eligible: true, warnings: [] },
    sourceSnapshots: [digest('c')],
    metadataDigest: digest(character),
    nativeSemantics: { version: 'npm-v1', data: {} },
    semanticLoss: [],
  };
}

const snapshot = {
  snapshotId: `sha256:${'c'.repeat(64)}`,
  providerId: 'fixture',
  providerType: 'npm',
  endpointIdentity: 'urn:fixture:npm',
  retrievedAt: '2026-08-02T00:00:00Z',
  evaluationTime: '2026-08-02T00:00:00Z',
  rootDigest: digest('c'),
  recordsDigest: digest('b'),
  evidenceRefs: [],
};
const universe: ResolutionUniverse = {
  universeVersion: '1',
  packages: [packageInstance('1', '1.0.0'), packageInstance('2', '1.1.0')],
  overlays: [],
  sourceSnapshots: [snapshot],
  lifecycleRoot: digest('d'),
  targetVocabularyVersion: '1',
  canonicalDigest: digest('e'),
};

describe('openpackerd', () => {
  it('runs normalize and a proof-checked WASM solve through real Fastify routes', async () => {
    const keys = JSON.parse(
      await readFile(
        new URL('../../../fixtures/trust/keys.json', import.meta.url),
        'utf8',
      ),
    ) as { leaf: JsonWebKey };
    const signer = await Ed25519Signer.fromJwk('fixture-leaf', keys.leaf);
    const verifier = await Ed25519Verifier.fromJwk('fixture-leaf', keys.leaf);
    const meta = {
      protocolVersion: '1.0-draft',
      provider: {
        id: 'fixture',
        implementation: 'openpackerd',
        version: '0.1.0',
      },
    } as const;
    const operations = createReferenceOperations({
      universe,
      resolver: createEmbeddedResolver(bindings),
      meta,
      resolverBuildDigest: digest('f'),
      receiptSigners: [signer],
      receiptVerifiers: new Map([[verifier.keyId, verifier]]),
      verificationChecks: new Map([
        ['policy', async () => ({ status: 'valid' as const })],
        [
          'slsa-subject',
          async () => {
            throw new Error('fixture provenance is malformed');
          },
        ],
      ]),
      extensions: {
        lifecycleApply: async () => {
          throw new OperationError(
            'PROVIDER_CAPABILITY_MISSING',
            'Lifecycle fixture reducer not supplied',
          );
        },
        pack: async () => {
          throw new OperationError(
            'PROVIDER_CAPABILITY_MISSING',
            'Artifact packer not supplied',
          );
        },
        publish: async () => {
          throw new OperationError(
            'PROVIDER_CAPABILITY_MISSING',
            'Artifact publisher not supplied',
          );
        },
      },
    });
    const app = createOpenPackerDaemon({ operations, meta });
    const capabilities = await app.inject({
      method: 'GET',
      url: '/v1/capabilities',
    });
    expect(capabilities.json().semanticsProfiles).toEqual([
      'native-capture-v1',
      'native-validated-v1',
      'prex-calculus-subset-v1',
    ]);
    expect(capabilities.json().evidenceTypes).toEqual([
      'policy',
      'receipt-signature',
      'slsa',
    ]);
    expect(
      capabilities.json().authenticationSchemes.map(({ type }) => type),
    ).toEqual(['none']);
    const normalized = await app.inject({
      method: 'POST',
      url: '/v1/normalize',
      payload: {
        items: [
          {
            type: 'native-coordinate',
            ecosystem: 'npm',
            value: '@openpacker/demo-tool@1.0.0',
          },
        ],
      },
    });
    expect(normalized.statusCode).toBe(200);
    expect(normalized.headers['prex-version']).toBe('1.0-draft');
    expect(normalized.headers['x-openpacker-provider-id']).toBe('fixture');
    expect(normalized.json().results[0].canonical).toBe(
      'pkg:npm/%40openpacker/demo-tool@1.0.0',
    );

    const request = JSON.parse(
      await readFile(
        new URL(
          '../../../fixtures/protocol/solve/request.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as SolveRequest;
    const solved = await app.inject({
      method: 'POST',
      url: '/v1/solve',
      payload: request,
    });
    expect(solved.statusCode, solved.body).toBe(200);
    const response = solved.json();
    expect(response.solution.selectedNodeIds).toEqual([
      `sha256:${'2'.repeat(64)}`,
    ]);
    expect(response.signedReceipt.signatures).toHaveLength(1);
    for (const profile of [
      'native-capture-v1',
      'native-validated-v1',
    ] as const) {
      const native = await app.inject({
        method: 'POST',
        url: '/v1/solve',
        payload: {
          ...request,
          environment: { installed: [], locked: [`sha256:${'2'.repeat(64)}`] },
          semantics: { ...request.semantics, profile },
        },
      });
      expect(native.statusCode, native.body).toBe(200);
      expect(native.json().solution.selectedNodeIds).toEqual([
        `sha256:${'2'.repeat(64)}`,
      ]);
      expect(native.json().solution.semanticLoss).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'NATIVE_SEMANTICS_NOT_VALIDATED' }),
        ]),
      );
    }
    const receipt = await app.inject({
      method: 'GET',
      url: `/v1/receipts/sha256/${response.signedReceipt.receiptDigest.value}`,
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toEqual(response.signedReceipt);
    const verified = await app.inject({
      method: 'POST',
      url: '/v1/verify',
      payload: {
        subject: response.signedReceipt,
        checks: ['receipt-signature', 'policy'],
        evaluationTime: request.evaluationTime,
      },
    });
    expect(verified.json()).toMatchObject({
      decision: 'allow',
      evidence: [{ status: 'valid' }, { status: 'valid' }],
    });
    const incomplete = await app.inject({
      method: 'POST',
      url: '/v1/verify',
      payload: {
        subject: response.signedReceipt,
        checks: ['receipt-signature', 'tuf-metadata', 'sigstore-bundle'],
        evaluationTime: request.evaluationTime,
      },
    });
    expect(incomplete.statusCode, incomplete.body).toBe(200);
    expect(incomplete.json()).toMatchObject({
      decision: 'indeterminate',
      evidence: [
        { type: 'receipt-signature', status: 'valid' },
        { type: 'sigstore-bundle', status: 'not-provided' },
        { type: 'tuf-metadata', status: 'not-provided' },
      ],
    });
    const invalidEvidence = await app.inject({
      method: 'POST',
      url: '/v1/verify',
      payload: {
        subject: response.signedReceipt,
        checks: ['slsa-subject'],
        evaluationTime: request.evaluationTime,
      },
    });
    expect(invalidEvidence.statusCode, invalidEvidence.body).toBe(200);
    expect(invalidEvidence.json()).toMatchObject({
      decision: 'deny',
      evidence: [
        {
          type: 'slsa-subject',
          status: 'invalid',
          diagnostics: [
            {
              code: 'VERIFICATION_FAILED',
              message: 'fixture provenance is malformed',
            },
          ],
        },
      ],
    });
    const unsatisfiable = await app.inject({
      method: 'POST',
      url: '/v1/solve',
      payload: {
        ...request,
        requirements: request.requirements.map((requirement) => ({
          ...requirement,
          expression: {
            type: 'package',
            purl: 'pkg:npm/%40openpacker/demo-tool',
            vers: 'vers:npm/>=9.0.0',
          },
        })),
      },
    });
    expect(unsatisfiable.statusCode, unsatisfiable.body).toBe(409);
    expect(unsatisfiable.json()).toMatchObject({ code: 'UNSATISFIABLE' });
    await app.close();
  });

  it('rejects duplicate JSON keys before protocol handling', async () => {
    const unavailable = async () => {
      throw new Error('not reached');
    };
    const operations = Object.fromEntries(
      [
        'normalize',
        'identify',
        'enumerate',
        'inspect',
        'solve',
        'materialize',
        'verify',
        'explain',
        'catalogImport',
        'catalogSnapshot',
        'lockImport',
        'lifecycleApply',
        'pack',
        'publish',
      ].map((name) => [name, unavailable]),
    ) as unknown as import('../src/operations.js').PrexOperations;
    const app = createOpenPackerDaemon({ operations });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/normalize',
      headers: { 'content-type': 'application/json' },
      payload: '{"items":[],"items":[]}',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ status: 400 });
    await app.close();
  });

  it('rejects schema-invalid requests before operation dispatch', async () => {
    const operations = new Proxy(
      {},
      {
        get: (_target, property) =>
          property === 'capabilities'
            ? undefined
            : () => {
                throw new Error('operation must not run');
              },
      },
    ) as unknown as Parameters<typeof createOpenPackerDaemon>[0]['operations'];
    const app = createOpenPackerDaemon({ operations });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/normalize',
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('INVALID_REQUEST');
    await app.close();
  });

  it('validates extension requests and responses on the 200 route contract', async () => {
    let calls = 0;
    const operations = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === 'capabilities') return undefined;
          if (property === 'catalogSnapshot')
            return async (input: { providerId?: string }) => {
              calls += 1;
              return input.providerId === 'invalid-response'
                ? { unexpected: true }
                : { snapshots: [] };
            };
          return async () => {
            throw new Error('operation must not run');
          };
        },
      },
    ) as unknown as Parameters<typeof createOpenPackerDaemon>[0]['operations'];
    const app = createOpenPackerDaemon({ operations });

    const invalidRequest = await app.inject({
      method: 'POST',
      url: '/v1/openpacker/catalog/snapshot',
      payload: { providerId: 42 },
    });
    expect(invalidRequest.statusCode).toBe(400);
    expect(calls).toBe(0);

    const valid = await app.inject({
      method: 'POST',
      url: '/v1/openpacker/catalog/snapshot',
      payload: {},
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ snapshots: [] });

    const invalidResponse = await app.inject({
      method: 'POST',
      url: '/v1/openpacker/catalog/snapshot',
      payload: { providerId: 'invalid-response' },
    });
    expect(invalidResponse.statusCode).toBe(500);
    expect(invalidResponse.json().code).toBe('INTERNAL_ERROR');
    expect(invalidResponse.json().detail).toContain(
      "must have required property 'snapshots'",
    );
    await app.close();
  });

  it('enforces the deadline and propagates one generated correlation ID', async () => {
    let correlationId = '';
    const operations = new Proxy(
      {},
      {
        get: (_target, property) =>
          property === 'capabilities'
            ? undefined
            : property === 'catalogSnapshot'
              ? async (_input: unknown, context: { correlationId: string }) => {
                  correlationId = context.correlationId;
                  await new Promise((resolve) => setTimeout(resolve, 50));
                  return { snapshots: [] };
                }
              : async () => {
                  throw new Error('operation must not run');
                },
      },
    ) as unknown as Parameters<typeof createOpenPackerDaemon>[0]['operations'];
    const app = createOpenPackerDaemon({
      operations,
      maximumTimeoutMilliseconds: 5,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/openpacker/catalog/snapshot',
      payload: {},
    });
    expect(response.statusCode).toBe(408);
    expect(response.json().code).toBe('CANCELLED');
    expect(response.headers['x-correlation-id']).toBe(correlationId);
    await app.close();
  });

  it('advertises no evidence types when no verifier is configured', async () => {
    const meta = {
      protocolVersion: '1.0-draft',
      provider: {
        id: 'fixture',
        implementation: 'openpackerd',
        version: '0.1.0',
      },
    } as const;
    const unavailable = async (): Promise<never> => {
      throw new OperationError('PROVIDER_CAPABILITY_MISSING', 'not configured');
    };
    const operations = createReferenceOperations({
      universe,
      resolver: createEmbeddedResolver(bindings),
      meta,
      resolverBuildDigest: digest('f'),
      extensions: {
        lifecycleApply: unavailable,
        pack: unavailable,
        publish: unavailable,
      },
    });
    const app = createOpenPackerDaemon({ operations, meta });
    const capabilities = await app.inject({
      method: 'GET',
      url: '/v1/capabilities',
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json().evidenceTypes).toEqual([]);
    expect(
      capabilities.json().authenticationSchemes.map(({ type }) => type),
    ).toEqual(['none']);
    await app.close();
  });
});

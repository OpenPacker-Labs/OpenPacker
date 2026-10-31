import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import timers from 'node:timers';
import timersPromises from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import * as bindings from '@openpacker/embedded/wasm-node';
import { createEmbeddedResolver } from '@openpacker/embedded';
import { packageNodeId } from '@openpacker/adapter-core';
import { canonicalProjectionDigest } from '@openpacker/canonical';
import { DIGEST_PROJECTIONS } from '@openpacker/contracts';
import { Ed25519Signer, Ed25519Verifier } from '@openpacker/trust';
import type {
  JsonValue,
  PackageInstance,
  ResolutionUniverse,
  SolveRequest,
} from '@openpacker/contracts';
import {
  assertDaemonBindAddress,
  assertDaemonPort,
  createOpenPackerDaemon,
  sourceSnapshotDigest,
  SqliteStateStore,
} from '../src/index.js';
import { runDaemon } from '../src/cli.js';
import {
  createReferenceOperations,
  OperationError,
} from '../src/operations.js';
import { createStandaloneReferenceOperations } from '../src/reference.js';

/**
 * Every timer a backoff could wait on, frozen until the returned function is
 * called. The global setTimeout is vi.useFakeTimers', which never fires: a
 * backoff through it never answers. node:timers' setTimeout and
 * node:timers/promises' setTimeout and scheduler.wait are replaced on the
 * modules' own objects, and syncBuiltinESMExports hands the replacements to
 * every `import { setTimeout } from ...` too; each refuses at once, so the
 * request fails, and is named in `waited`.
 */
function freezeTimers(waited: string[]): () => void {
  const refused = (name: string) => {
    waited.push(name);
    return new Error(`${name} was waited on before answering`);
  };
  const saved = {
    setTimeout: timers.setTimeout,
    promisesSetTimeout: timersPromises.setTimeout,
    wait: timersPromises.scheduler.wait,
  };
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  timers.setTimeout = Object.assign(
    (): never => {
      throw refused('node:timers setTimeout');
    },
    { __promisify__: saved.setTimeout.__promisify__ },
  );
  timersPromises.setTimeout = () =>
    Promise.reject(refused('node:timers/promises setTimeout'));
  timersPromises.scheduler.wait = () =>
    Promise.reject(refused('node:timers/promises scheduler.wait'));
  syncBuiltinESMExports();
  return () => {
    timers.setTimeout = saved.setTimeout;
    timersPromises.setTimeout = saved.promisesSetTimeout;
    timersPromises.scheduler.wait = saved.wait;
    vi.useRealTimers();
    syncBuiltinESMExports();
  };
}

const digest = (character: string) => ({
  algorithm: 'sha256' as const,
  value: character.repeat(64),
});
const source = {
  type: 'metadata' as const,
  uri: 'https://fixtures.openpacker.dev/catalog',
};

async function packageInstance(
  character: string,
  version: string,
): Promise<PackageInstance> {
  const exactPurl = `pkg:npm/%40openpacker/demo-tool@${version}`;
  const nodeId = await packageNodeId({
    exactPurl,
    qualifiers: {},
    nativeSemanticsVersion: 'npm-v1',
  });
  return {
    nodeId,
    identity: {
      canonicalPurl: 'pkg:npm/%40openpacker/demo-tool',
      exactPurl,
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
const universeBody: Omit<ResolutionUniverse, 'canonicalDigest'> = {
  universeVersion: '1',
  packages: await Promise.all([
    packageInstance('1', '1.0.0'),
    packageInstance('2', '1.1.0'),
  ]),
  overlays: [],
  sourceSnapshots: [snapshot],
  lifecycleRoot: digest('d'),
  targetVocabularyVersion: '1',
};
const universe: ResolutionUniverse = {
  ...universeBody,
  canonicalDigest: await canonicalProjectionDigest(
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    JSON.parse(JSON.stringify(universeBody)) as JsonValue,
    DIGEST_PROJECTIONS.projections.find(({ id }) => id === 'universe-v1')!,
  ),
};

describe('openpackerd', () => {
  it('keeps the CLI import-safe for coverage and embedding', () => {
    expect(runDaemon).toBeTypeOf('function');
  });

  it('rejects DNS-rebinding authorities and cross-origin browser requests', async () => {
    const app = createOpenPackerDaemon({
      operations: await createStandaloneReferenceOperations(),
    });
    try {
      const rebound = await app.inject({
        method: 'GET',
        url: '/v1/health',
        headers: { host: '127.0.0.1.attacker.example' },
      });
      expect(rebound.statusCode).toBe(403);

      const crossOrigin = await app.inject({
        method: 'GET',
        url: '/v1/health',
        headers: {
          host: '127.0.0.1:7337',
          origin: 'https://attacker.example',
        },
      });
      expect(crossOrigin.statusCode).toBe(403);

      const loopback = await app.inject({
        method: 'GET',
        url: '/v1/health',
        headers: {
          host: '[::1]:7337',
          origin: 'http://localhost:7337',
        },
      });
      expect(loopback.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('boots the standalone reference operations with an empty universe', async () => {
    const operations = await createStandaloneReferenceOperations();
    const meta = {
      protocolVersion: '1.0-draft' as const,
      provider: {
        id: 'org.openpacker.reference',
        implementation: 'openpackerd',
        version: '0.1.0',
      },
    };
    expect(operations.capabilities?.(meta).protocolVersions).toContain(
      '1.0-draft',
    );
    await expect(
      operations.identify(
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        { query: { alias: 'missing' } } as never,
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        {} as never,
      ),
    ).resolves.toMatchObject({ status: 'not-found', candidates: [] });
    await expect(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      operations.pack({} as never, {} as never),
    ).rejects.toMatchObject({
      code: 'PROVIDER_CAPABILITY_MISSING',
      status: 501,
    });
  });

  it('rejects duplicate keys in a standalone universe before validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openpackerd-universe-'));
    const path = join(root, 'universe.json');
    try {
      await writeFile(
        path,
        '{"universeVersion":"1","universeVersion":"2","packages":[],"overlays":[],"sourceSnapshots":[],"lifecycleRoot":{"algorithm":"sha256","value":"' +
          '0'.repeat(64) +
          '"},"targetVocabularyVersion":"1","canonicalDigest":{"algorithm":"sha256","value":"' +
          '0'.repeat(64) +
          '"}}',
      );
      await expect(createStandaloneReferenceOperations(path)).rejects.toThrow(
        /Duplicate object member/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns deterministic resolver exhaustion as a rate limit', async () => {
    const unavailable = async (): Promise<never> => {
      throw new OperationError('PROVIDER_CAPABILITY_MISSING', 'not configured');
    };
    let solves = 0;
    const resolver = createEmbeddedResolver({
      ...bindings,
      solve_json: () => {
        solves += 1;
        throw new Error(
          'RESOURCE_LIMIT: exhaustive resolution proof requires 2000 work units (limit 1000)',
        );
      },
    });
    const operations = createReferenceOperations({
      universe,
      resolver,
      meta: {
        protocolVersion: '1.0-draft',
        provider: {
          id: 'fixture',
          implementation: 'openpackerd',
          version: '0.1.0',
        },
      },
      resolverBuildDigest: digest('f'),
      extensions: {
        lifecycleApply: unavailable,
        pack: unavailable,
        publish: unavailable,
      },
    });
    const app = createOpenPackerDaemon({ operations });
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const request = JSON.parse(
      await readFile(
        new URL(
          '../../../fixtures/protocol/solve/request.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as SolveRequest;
    // The refusal is the answer, at once: one solve per request, no retry, and
    // no timer to wait on (every timer is frozen for the second request, so a
    // backoff before answering never answers or fails the request). Counted,
    // not timed: a bound of 1000 ms measured the machine's load as much as the
    // answer.
    const first = await app.inject({
      method: 'POST',
      url: '/v1/solve',
      payload: request,
    });
    expect(first.statusCode).toBe(429);
    expect(solves).toBe(1);
    const waited: string[] = [];
    const thaw = freezeTimers(waited);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/solve',
        payload: request,
      });
      expect(waited).toEqual([]);
      expect(response.statusCode).toBe(429);
      expect(response.json()).toMatchObject({
        code: 'RATE_LIMITED',
        retryable: true,
      });
      expect(solves).toBe(2);
    } finally {
      thaw();
    }
    await app.close();
  });

  it('requires forensic intent for every lifecycle-denied artifact subject', async () => {
    const descriptor = {
      descriptorId: 'quarantined-artifact',
      digest: digest('9'),
      size: 1,
      mediaType: 'application/octet-stream',
      artifactType: 'package',
      nativeRole: 'native-package',
      locations: ['https://fixtures.openpacker.dev/quarantined.tgz'],
      rangeSupported: false,
    };
    const denied = {
      ...universe.packages[0]!,
      lifecycle: {
        status: 'quarantined' as const,
        eligible: false,
        warnings: [],
      },
      artifacts: [descriptor],
    };
    const unavailable = async (): Promise<never> => {
      throw new OperationError('PROVIDER_CAPABILITY_MISSING', 'not configured');
    };
    const operations = createReferenceOperations({
      universe: { ...universe, packages: [denied] },
      resolver: createEmbeddedResolver(bindings),
      meta: {
        protocolVersion: '1.0-draft',
        provider: {
          id: 'fixture',
          implementation: 'openpackerd',
          version: '0.1.0',
        },
      },
      resolverBuildDigest: digest('f'),
      extensions: {
        lifecycleApply: unavailable,
        pack: unavailable,
        publish: unavailable,
      },
    });
    const subject = { type: 'artifact' as const, descriptor };
    await expect(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      operations.materialize({ subject } as never, {} as never),
    ).rejects.toMatchObject({ code: 'LIFECYCLE_DENIED' });
    await expect(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      operations.materialize({ subject, forensic: true } as never, {} as never),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const policy = {
      allowYanked: false,
      allowQuarantined: true,
      semanticLossMaximum: 'warning' as const,
      requiredEvidence: [],
      permitForensicDigestMaterialization: true,
    };
    await expect(
      operations.materialize(
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        { subject, forensic: true, policy } as never,
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        {} as never,
      ),
    ).resolves.toMatchObject({ descriptor });
    await expect(
      operations.materialize(
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        {
          subject: {
            type: 'artifact',
            descriptor: { ...descriptor, digest: digest('8') },
          },
          forensic: true,
        } as never,
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('rejects a catalog snapshot whose claimed root was not recomputed', async () => {
    const store = new SqliteStateStore(':memory:');
    const operations = createReferenceOperations({
      universe,
      resolver: createEmbeddedResolver(bindings),
      meta: {
        protocolVersion: '1.0-draft',
        provider: {
          id: 'fixture',
          implementation: 'openpackerd',
          version: '0.1.0',
        },
      },
      resolverBuildDigest: digest('f'),
      extensions: {
        lifecycleApply: async () => {
          throw new Error('not reached');
        },
        pack: async () => {
          throw new Error('not reached');
        },
        publish: async () => {
          throw new Error('not reached');
        },
      },
    });
    const forged = { ...snapshot, providerId: 'attacker' };
    await expect(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      operations.catalogImport(forged, { store } as never),
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
    expect(
      store.getSnapshot('sha256', snapshot.rootDigest.value),
    ).toBeUndefined();

    const rootDigest = await sourceSnapshotDigest(snapshot);
    const wrongId = {
      ...snapshot,
      rootDigest,
      snapshotId: `sha256:${'a'.repeat(64)}`,
    };
    await expect(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      operations.catalogImport(wrongId, { store } as never),
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
  });

  it('enforces materialization policy facts and fails closed when lifecycle is unknown', async () => {
    const descriptor = {
      descriptorId: 'policy-artifact',
      digest: digest('7'),
      size: 2,
      mediaType: 'application/octet-stream',
      artifactType: 'package',
      nativeRole: 'native-package',
      locations: [
        {
          transport: 'https' as const,
          uri: 'https://fixtures.openpacker.dev/package.tgz',
          priority: 0,
          rangeSupported: false,
        },
      ],
      referrers: [],
      externalRefs: [],
    };
    const owner = { ...universe.packages[0]!, artifacts: [descriptor] };
    const unavailable = async (): Promise<never> => {
      throw new Error('not reached');
    };
    const operations = createReferenceOperations({
      universe: { ...universe, packages: [owner] },
      resolver: createEmbeddedResolver(bindings),
      meta: {
        protocolVersion: '1.0-draft',
        provider: {
          id: 'fixture',
          implementation: 'openpackerd',
          version: '0.1.0',
        },
      },
      resolverBuildDigest: digest('f'),
      extensions: {
        lifecycleApply: unavailable,
        pack: unavailable,
        publish: unavailable,
      },
    });
    const basePolicy = {
      allowYanked: false,
      allowQuarantined: false,
      semanticLossMaximum: 'warning' as const,
      requiredEvidence: [],
    };
    const subject = { type: 'artifact' as const, descriptor };
    await expect(
      operations.materialize(
        { subject, policy: { ...basePolicy, maximumArtifactSize: 1 } },
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(
      operations.materialize(
        {
          subject,
          policy: { ...basePolicy, allowedProviderIds: ['other'] },
        },
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(
      operations.materialize(
        {
          subject,
          policy: {
            ...basePolicy,
            allowedArtifactSourceSchemes: ['file'],
          },
        },
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(
      operations.materialize(
        {
          subject: {
            type: 'artifact',
            descriptor: { ...descriptor, digest: digest('6') },
          },
          policy: basePolicy,
        },
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        {} as never,
      ),
    ).rejects.toMatchObject({ code: 'POLICY_INDETERMINATE' });
  });

  it('runs normalize and a proof-checked WASM solve through real Fastify routes', async () => {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
    // Advertised PURL types come from the codec registry, so registering a
    // codec is what makes an ecosystem appear.
    expect(capabilities.json().purlTypes).toEqual([
      'cargo',
      'golang',
      'maven',
      'nix',
      'npm',
      'nuget',
      'packslip',
      'pypi',
    ]);
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

    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
      universe.packages[1]!.nodeId,
    ]);
    expect(response.signedReceipt.signatures).toHaveLength(1);
    const projection = (id: string) => {
      const value = DIGEST_PROJECTIONS.projections.find(
        (candidate) => candidate.id === id,
      );
      if (!value) throw new Error(`missing projection ${id}`);
      return value;
    };
    expect(response.requestDigest).toEqual(
      await canonicalProjectionDigest(
        response.normalizedRequest,
        projection('request-v1'),
      ),
    );
    expect(response.universeDigest).toEqual(
      await canonicalProjectionDigest(universe, projection('universe-v1')),
    );
    expect(response.solution.solutionDigest).toEqual(
      await canonicalProjectionDigest(
        response.solution,
        projection('solution-v1'),
      ),
    );
    expect(response.signedReceipt.receipt.proofDigest).toEqual(
      await canonicalProjectionDigest(response.proof, projection('proof-v1')),
    );
    expect(response.signedReceipt.receipt.explanationDigest).toEqual(
      await canonicalProjectionDigest(
        response.explanation,
        projection('explanation-v1'),
      ),
    );
    expect(response.signedReceipt.receipt.artifactSetDigest).toEqual(
      await canonicalProjectionDigest(
        {
          items: response.selected.flatMap(
            (item: PackageInstance) => item.artifacts,
          ),
        },
        projection('artifact-set-v1'),
      ),
    );
    for (const profile of [
      'native-capture-v1',
      'native-validated-v1',
    ] as const) {
      const native = await app.inject({
        method: 'POST',
        url: '/v1/solve',
        payload: {
          ...request,
          environment: {
            installed: [],
            locked: [universe.packages[1]!.nodeId],
          },
          semantics: { ...request.semantics, profile },
        },
      });
      expect(native.statusCode, native.body).toBe(200);
      expect(native.json().solution.selectedNodeIds).toEqual([
        universe.packages[1]!.nodeId,
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
    ) as import('../src/operations.js').PrexOperations;
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
    ) as Parameters<typeof createOpenPackerDaemon>[0]['operations'];
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
    ) as Parameters<typeof createOpenPackerDaemon>[0]['operations'];
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
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
    ) as Parameters<typeof createOpenPackerDaemon>[0]['operations'];
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

  it('normalizes a nix store path through the registered codec', async () => {
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
    const response = await app.inject({
      method: 'POST',
      url: '/v1/normalize',
      payload: {
        items: [
          {
            type: 'native-coordinate',
            ecosystem: 'nix',
            value: '/nix/store/b3f2q8xr7k1v5m9n0p4s6w2y4z6a8c1d-libgreet-1.0',
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    // A store path becomes an exact PURL whose output selector is explicit.
    expect(response.json().results[0].canonical).toContain('pkg:nix/libgreet');
    await app.close();
  });

  it('normalizes an unregistered PURL type instead of rejecting it', async () => {
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
    const response = await app.inject({
      method: 'POST',
      url: '/v1/normalize',
      payload: {
        items: [{ type: 'purl', value: 'pkg:deb/debian/openssl@3.0.11' }],
      },
    });
    expect(response.statusCode).toBe(200);
    const result = response.json().results[0];
    expect(result.canonical).toBe('pkg:deb/debian/openssl@3.0.11');
    // Canonical encoding happened; ecosystem rules did not, and it says so.
    expect(result.semanticLoss[0].code).toBe('ECOSYSTEM_RULES_NOT_APPLIED');
    expect(result.reversibility).toBe('lossy');

    // Opening the path must not bless a malformed type as canonical: a PURL
    // type is lowercase alphanumerics plus '.', '+', and '-'.
    for (const value of ['pkg:DEB!/x@1', 'pkg:  /x@1', 'pkg:%41%42/x@1']) {
      const rejected = await app.inject({
        method: 'POST',
        url: '/v1/normalize',
        payload: { items: [{ type: 'purl', value }] },
      });
      expect(rejected.statusCode, value).toBeGreaterThanOrEqual(400);
    }
    await app.close();
  });

  it('advertises a registered out-of-tree codec', async () => {
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
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const codec = {
      purlType: 'deb',
      canonicalizePurl: (purl: string) => purl,
    } as Parameters<typeof createReferenceOperations>[0]['codecs'] extends
      | ReadonlyMap<string, infer Codec>
      | undefined
      ? Codec
      : never;
    const operations = createReferenceOperations({
      universe,
      resolver: createEmbeddedResolver(bindings),
      meta,
      resolverBuildDigest: digest('f'),
      codecs: new Map([['deb', codec]]),
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
    expect(capabilities.json().purlTypes).toContain('deb');
    expect(capabilities.json().versSchemes).toContain('deb');
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

describe('openpackerd HTTP surface hardening', () => {
  const meta = {
    protocolVersion: '1.0-draft',
    provider: {
      id: 'fixture',
      implementation: 'openpackerd',
      version: '0.1.0',
    },
  } as const;

  function minimalApp(bodyLimit = 1024) {
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
    return createOpenPackerDaemon({
      operations,
      meta,
      bodyLimit,
      eventPageSize: 10,
    });
  }

  it('refuses non-loopback binds unless allowRemoteBind is set', () => {
    // authenticationSchemes is none — a LAN bind without auth is a footgun.
    expect(() => assertDaemonBindAddress('0.0.0.0')).toThrow(/loopback/i);
    expect(() => assertDaemonBindAddress('::')).toThrow(/loopback/i);
    expect(() => assertDaemonBindAddress('192.168.1.10')).toThrow(/loopback/i);
    expect(() => assertDaemonBindAddress('127.0.0.1')).not.toThrow();
    expect(() => assertDaemonBindAddress('localhost')).not.toThrow();
    expect(() =>
      assertDaemonBindAddress('0.0.0.0', { allowRemoteBind: true }),
    ).not.toThrow();
  });

  it('rejects ports outside 0–65535 (0 is OS-assigned ephemeral)', () => {
    expect(() => assertDaemonPort(-1)).toThrow(/port/i);
    expect(() => assertDaemonPort(65_536)).toThrow(/port/i);
    expect(() => assertDaemonPort(Number.NaN)).toThrow(/port/i);
    expect(assertDaemonPort(0)).toBe(0);
    expect(assertDaemonPort(7337)).toBe(7337);
  });

  it('rejects oversized request bodies at the Fastify limit', async () => {
    const app = minimalApp(64);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/normalize',
      headers: { 'content-type': 'application/json' },
      // Larger than bodyLimit; Fastify must refuse before the operation runs.
      payload: JSON.stringify({ pad: 'x'.repeat(200) }),
    });
    // inject surfaces the limit as 413 in some Fastify versions and as a
    // 400 from the content-type parser in others; either is fail-closed.
    expect([400, 413]).toContain(response.statusCode);
    expect(response.statusCode).not.toBe(200);
    await app.close();
  });

  it('rejects malformed receipt digests instead of querying the store', async () => {
    const app = minimalApp();
    for (const url of [
      '/v1/receipts/md5/not-a-digest',
      `/v1/receipts/sha256/${'g'.repeat(64)}`,
      `/v1/receipts/sha256/${'a'.repeat(63)}`,
      '/v1/receipts/sha256/../etc/passwd',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(400);
    }
    await app.close();
  });

  it('caps event page size and rejects unsafe cursors', async () => {
    const app = minimalApp();
    const oversized = await app.inject({
      method: 'GET',
      url: '/v1/events?limit=999999',
    });
    // limit is clamped; the request itself is still valid.
    expect(oversized.statusCode).toBe(200);

    const badCursor = await app.inject({
      method: 'GET',
      url: `/v1/events?cursor=${'9'.repeat(20)}`,
    });
    expect(badCursor.statusCode).toBe(400);

    const negative = await app.inject({
      method: 'GET',
      url: '/v1/events?limit=-1',
    });
    expect(negative.statusCode).toBe(400);
    await app.close();
  });

  /**
   * A normalize that answers differently per input, so a wrong cache hit is
   * visible in the body rather than only in principle.
   */
  function echoNormalizeApp() {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const operations = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === 'capabilities') return undefined;
          if (property === 'normalize')
            return async (input: {
              items: Array<{ value: string }>;
            }): Promise<JsonValue> => ({
              meta: {
                protocolVersion: '1.0-draft',
                provider: {
                  id: 'fixture',
                  implementation: 'fixture',
                  version: '0.0.0',
                },
              },
              results: [
                {
                  type: 'native-coordinate',
                  original: input.items[0]!.value,
                  canonical: `pkg:npm/${input.items[0]!.value}`,
                  parsed: {},
                  reversibility: 'exact',
                  warnings: [],
                  semanticLoss: [],
                },
              ],
            });
          return async () => {
            throw new Error('operation must not run');
          };
        },
      },
    ) as Parameters<typeof createOpenPackerDaemon>[0]['operations'];
    return createOpenPackerDaemon({ operations });
  }

  const normalizePayload = (value: string) => ({
    items: [{ type: 'native-coordinate', ecosystem: 'npm', value }],
  });

  it('replays a cached response only for the request that produced it', async () => {
    const app = echoNormalizeApp();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/normalize',
      headers: { 'idempotency-key': 'k1' },
      payload: normalizePayload('alpha@1.0.0'),
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().results[0].canonical).toBe('pkg:npm/alpha@1.0.0');

    const replay = await app.inject({
      method: 'POST',
      url: '/v1/normalize',
      headers: { 'idempotency-key': 'k1' },
      payload: normalizePayload('alpha@1.0.0'),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().results[0].canonical).toBe('pkg:npm/alpha@1.0.0');
    await app.close();
  });

  it('refuses an idempotency key reused for a different request body', async () => {
    // Serving the first answer here would hand the caller a result for a
    // request they did not make.
    const app = echoNormalizeApp();
    await app.inject({
      method: 'POST',
      url: '/v1/normalize',
      headers: { 'idempotency-key': 'k1' },
      payload: normalizePayload('alpha@1.0.0'),
    });
    const reused = await app.inject({
      method: 'POST',
      url: '/v1/normalize',
      headers: { 'idempotency-key': 'k1' },
      payload: normalizePayload('beta@2.0.0'),
    });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().code).toBe('INVALID_REQUEST');
    expect(reused.json().detail).toMatch(/different request body/);
    await app.close();
  });

  it('keys the cache per route, not per key alone', async () => {
    const app = echoNormalizeApp();
    const first = await app.inject({
      method: 'POST',
      url: '/v1/normalize',
      headers: { 'idempotency-key': 'shared' },
      payload: normalizePayload('alpha@1.0.0'),
    });
    expect(first.statusCode).toBe(200);
    const other = await app.inject({
      method: 'POST',
      url: '/v1/identify',
      headers: { 'idempotency-key': 'shared' },
      payload: normalizePayload('alpha@1.0.0'),
    });
    // Different route: no cross-route replay, so it reaches the operation.
    expect(other.statusCode).not.toBe(200);
    await app.close();
  });

  it('does not put a non-PREX error code or its message on the wire', async () => {
    // Node attaches codes like ENOENT and puts a local path in the message.
    // Passing that through emits a Problem outside the normative enum and
    // tells an unauthenticated caller where the store lives.
    const leak = Object.assign(
      new Error("ENOENT: no such file or directory, open '/home/op/.opm/db'"),
      { code: 'ENOENT' },
    );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const operations = new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === 'capabilities') return undefined;
          return async () => {
            throw leak;
          };
        },
      },
    ) as Parameters<typeof createOpenPackerDaemon>[0]['operations'];
    const app = createOpenPackerDaemon({ operations });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/normalize',
      payload: normalizePayload('alpha@1.0.0'),
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('/home/op/.opm/db');
    expect(response.body).not.toContain('ENOENT');
    await app.close();
  });

  it('advertises authenticationSchemes none so callers do not invent auth', async () => {
    const app = minimalApp();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/capabilities',
    });
    expect(
      response
        .json()
        .authenticationSchemes.map(({ type }: { type: string }) => type),
    ).toEqual(['none']);
    await app.close();
  });
});

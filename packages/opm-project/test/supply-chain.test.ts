import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { FixtureHttpTransport } from '@openpacker/adapter-core';
import {
  evaluatePolicy,
  policyDocumentFromPolicyInput,
} from '@openpacker/policy';
import type { PolicyInput } from '@openpacker/contracts';
import {
  assertSupplyChainAllowed,
  captureFactsFromCatalog,
  captureFactsFromInspection,
  captureFactsFromSourceUri,
  emptyLockfile,
  parseLockfile,
  parseManifest,
  priorTrustFromLock,
  projectPolicyDocument,
  providerFor,
  serializeLockfile,
  OpmError,
  type OpmLockfile,
} from '../src/index.js';

const TARBALL = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4]);
const TARBALL_SRI = `sha256-${createHash('sha256').update(TARBALL).digest('base64')}`;

const PACKUMENT = {
  name: 'demo',
  'dist-tags': { latest: '1.1.0' },
  time: {
    created: '2020-01-01T00:00:00.000Z',
    modified: '2026-08-04T12:00:00.000Z',
    '1.0.0': '2020-06-01T00:00:00.000Z',
    '1.1.0': '2026-08-04T12:00:00.000Z', // fresh publish
  },
  versions: {
    '1.0.0': {
      name: 'demo',
      version: '1.0.0',
      dist: {
        tarball: 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz',
        integrity: TARBALL_SRI,
      },
    },
    '1.1.0': {
      name: 'demo',
      version: '1.1.0',
      scripts: { postinstall: 'node evil.js' },
      dist: {
        tarball: 'https://registry.npmjs.org/demo/-/demo-1.1.0.tgz',
        integrity: TARBALL_SRI,
      },
    },
  },
};

function npmTransport() {
  return new FixtureHttpTransport(
    new Map([
      [
        'https://registry.npmjs.org/demo',
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify(PACKUMENT)),
        },
      ],
      [
        'https://registry.npmjs.org/demo/-/demo-1.1.0.tgz',
        {
          status: 200,
          headers: {},
          body: TARBALL,
        },
      ],
    ]),
  );
}

describe('supply-chain capture from npm inspect (real provider path)', () => {
  it('captures publishedAt, scripts, source kind from packument', async () => {
    const provider = await providerFor('npm', {
      transport: npmTransport(),
      now: () => '2026-08-04T18:00:00.000Z',
    });
    const { facts } = await captureFactsFromCatalog(
      provider,
      'pkg:npm/demo@1.1.0',
      {
        evaluationTime: '2026-08-04T18:00:00.000Z',
        registryId: 'urn:openpacker:registry:npmjs-org',
      },
    );
    expect(facts.packageId).toContain('demo');
    expect(facts.publishedAt).toBe('2026-08-04T12:00:00.000Z');
    expect(facts.lifecycleScriptsDeclared).toBe(true);
    expect(facts.lifecycleScriptsExecuted).toBe(false);
    expect(facts.sourceKind).toBe('registry');
    expect(facts.registryId).toBe('urn:openpacker:registry:npmjs-org');
    expect(facts.trustLevel).toBe('unsigned');
  });

  it('leaves publishedAt absent honestly when packument has no time', async () => {
    const bare = {
      name: 'demo',
      versions: {
        '1.0.0': {
          name: 'demo',
          version: '1.0.0',
          dist: {
            tarball: 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz',
            integrity: TARBALL_SRI,
          },
        },
      },
    };
    const transport = new FixtureHttpTransport(
      new Map([
        [
          'https://registry.npmjs.org/demo',
          {
            status: 200,
            headers: {},
            body: new TextEncoder().encode(JSON.stringify(bare)),
          },
        ],
      ]),
    );
    const provider = await providerFor('npm', { transport });
    const inspection = await provider.inspect('pkg:npm/demo@1.0.0');
    const facts = captureFactsFromInspection(inspection, {
      evaluationTime: '2026-08-04T00:00:00.000Z',
    });
    expect(facts.publishedAt).toBeUndefined();
    expect(facts.lifecycleScriptsDeclared).toBe(false);
  });
});

describe('project policy governance (committed opm.toml)', () => {
  it('round-trips [policy] supply-chain knobs without env expansion', () => {
    const text = `
[project]
name = "sec"
ecosystems = ["npm"]

[options]
offline = true
layout = "opm"

[policy]
allow_yanked = false
allow_quarantined = false
semantic_loss_maximum = "warning"
minimum_release_age_minutes = 1440
minimum_release_age_strict = true
trust_policy = "no-downgrade"
block_exotic_transitive = true
block_exotic_direct = false
allow_lifecycle_scripts = false
expected_registry_id = "urn:openpacker:registry:npmjs-org"
allowed_lifecycle_script_packages = ["pkg:npm/esbuild"]
`;
    const manifest = parseManifest(text);
    expect(manifest.policy?.minimumReleaseAgeMinutes).toBe(1440);
    expect(manifest.policy?.minimumReleaseAgeStrict).toBe(true);
    expect(manifest.policy?.trustPolicy).toBe('no-downgrade');
    expect(manifest.policy?.blockExoticSources?.transitive).toBe(true);
    expect(manifest.policy?.allowLifecycleScripts).toBe(false);
    expect(manifest.policy?.expectedRegistryId).toBe(
      'urn:openpacker:registry:npmjs-org',
    );
    const document = projectPolicyDocument(manifest);
    expect(document.minimumReleaseAgeMinutes).toBe(1440);
    expect(document.trustPolicy).toBe('no-downgrade');
  });

  it('refuses ${ENV} expansion in expected_registry_id', () => {
    expect(() =>
      parseManifest(`
[project]
name = "x"
ecosystems = ["npm"]
[options]
offline = false
layout = "opm"
[policy]
allow_yanked = false
allow_quarantined = false
semantic_loss_maximum = "warning"
expected_registry_id = "https://\${SECRET_HOST}/npm"
`),
    ).toThrow(/must not contain/);
  });
});

describe('adversarial supply-chain scenarios (shipped evaluatePolicy)', () => {
  const baseInput: PolicyInput = {
    allowYanked: false,
    allowQuarantined: false,
    semanticLossMaximum: 'warning',
    requiredEvidence: [],
  };

  it('denies fresh publish inside minimum release age', async () => {
    const policy = policyDocumentFromPolicyInput({
      ...baseInput,
      minimumReleaseAgeMinutes: 1440,
    });
    const provider = await providerFor('npm', {
      transport: npmTransport(),
      now: () => '2026-08-04T18:00:00.000Z',
    });
    const { facts } = await captureFactsFromCatalog(
      provider,
      'pkg:npm/demo@1.1.0',
      { evaluationTime: '2026-08-04T18:00:00.000Z' },
    );
    await expect(assertSupplyChainAllowed(policy, facts)).rejects.toMatchObject(
      {
        code: 'POLICY_DENIED',
      },
    );
  });

  it('allows aged publish and persists trust on lock', async () => {
    const policy = policyDocumentFromPolicyInput({
      ...baseInput,
      minimumReleaseAgeMinutes: 60,
    });
    const provider = await providerFor('npm', {
      transport: npmTransport(),
    });
    const { facts } = await captureFactsFromCatalog(
      provider,
      'pkg:npm/demo@1.0.0',
      { evaluationTime: '2026-08-04T00:00:00.000Z' },
    );
    // 1.0.0 published 2020 — aged
    expect(facts.publishedAt).toBe('2020-06-01T00:00:00.000Z');
    const result = await assertSupplyChainAllowed(policy, facts);
    expect(result.decision).toBe('allow');

    const lock: OpmLockfile = emptyLockfile();
    lock.packages.demo = {
      alias: 'demo',
      purl: 'pkg:npm/demo@1.0.0',
      version: '1.0.0',
      digest: 'sha256:' + 'a'.repeat(64),
      size: 1,
      format: 'tar+gzip',
      mediaType: 'application/gzip',
      source: 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz',
      storeKey: 'sha256-' + 'a'.repeat(64),
      bins: [],
      reason: 'direct',
      ecosystem: 'npm',
      trustLevel: 'trusted-publisher',
      publishedAt: facts.publishedAt,
      sourceKind: 'registry',
    };
    const text = serializeLockfile(lock);
    const parsed = parseLockfile(text);
    expect(parsed.packages.demo?.trustLevel).toBe('trusted-publisher');
    expect(priorTrustFromLock(parsed, 'pkg:npm/demo@1.1.0')).toBe(
      'trusted-publisher',
    );
  });

  it('denies trust downgrade using prior tier from lock', async () => {
    const lock: OpmLockfile = emptyLockfile();
    lock.packages.demo = {
      alias: 'demo',
      purl: 'pkg:npm/demo@1.0.0',
      version: '1.0.0',
      digest: 'sha256:' + 'b'.repeat(64),
      size: 1,
      format: 'tar+gzip',
      mediaType: 'application/gzip',
      source: 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz',
      storeKey: 'sha256-' + 'b'.repeat(64),
      bins: [],
      reason: 'direct',
      ecosystem: 'npm',
      trustLevel: 'trusted-publisher',
    };
    const prior = priorTrustFromLock(lock, 'pkg:npm/demo@1.1.0');
    expect(prior).toBe('trusted-publisher');

    const policy = policyDocumentFromPolicyInput({
      ...baseInput,
      trustPolicy: 'no-downgrade',
    });
    const provider = await providerFor('npm', { transport: npmTransport() });
    const { facts } = await captureFactsFromCatalog(
      provider,
      'pkg:npm/demo@1.1.0',
      {
        evaluationTime: '2026-08-05T00:00:00.000Z',
        priorTrustLevel: prior,
      },
    );
    // npm capture sets unsigned when no provenance
    expect(facts.trustLevel).toBe('unsigned');
    expect(facts.priorTrustLevel).toBe('trusted-publisher');
    await expect(assertSupplyChainAllowed(policy, facts)).rejects.toMatchObject(
      {
        code: 'POLICY_DENIED',
      },
    );
  });

  it('allows first install under no-downgrade when lock has no prior tier', async () => {
    const policy = policyDocumentFromPolicyInput({
      ...baseInput,
      trustPolicy: 'no-downgrade',
    });
    // Empty lock / undefined priorLock → first install (nothing to compare).
    expect(priorTrustFromLock(emptyLockfile(), 'pkg:npm/demo@1.1.0')).toBe(
      undefined,
    );
    expect(priorTrustFromLock(undefined, 'pkg:npm/demo@1.1.0')).toBe(undefined);

    const provider = await providerFor('npm', { transport: npmTransport() });
    const { facts } = await captureFactsFromCatalog(
      provider,
      'pkg:npm/demo@1.0.0',
      {
        evaluationTime: '2026-08-05T00:00:00.000Z',
        // no priorTrustLevel — mirrors resolveRequirement with priorLock undefined
      },
    );
    expect(facts.priorTrustLevel).toBeUndefined();
    expect(facts.trustLevel).toBe('unsigned');
    const result = await assertSupplyChainAllowed(policy, facts);
    expect(result.decision).toBe('allow');
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'supply-chain.trust-no-downgrade',
          status: 'valid',
        }),
      ]),
    );
  });

  it('blocks exotic transitive git sources', async () => {
    const policy = policyDocumentFromPolicyInput({
      ...baseInput,
      blockExoticSources: { transitive: true, direct: false },
    });
    const facts = captureFactsFromSourceUri(
      'pkg:npm/evil@1.0.0',
      'git+https://github.com/evil/payload.git',
      {
        evaluationTime: '2026-08-04T00:00:00.000Z',
        dependencyDepth: 2,
      },
    );
    expect(facts.sourceKind).toBe('git');
    await expect(assertSupplyChainAllowed(policy, facts)).rejects.toMatchObject(
      {
        code: 'POLICY_DENIED',
      },
    );
  });

  it('denies unallowlisted lifecycle script execution', async () => {
    const policy = policyDocumentFromPolicyInput({
      ...baseInput,
      allowLifecycleScripts: false,
    });
    const facts = captureFactsFromSourceUri(
      'pkg:npm/evil@1.0.0',
      'https://registry.npmjs.org/evil/-/evil-1.0.0.tgz',
      {
        evaluationTime: '2026-08-04T00:00:00.000Z',
        lifecycleScriptsExecuted: true,
      },
    );
    await expect(assertSupplyChainAllowed(policy, facts)).rejects.toMatchObject(
      {
        code: 'POLICY_DENIED',
      },
    );
  });

  it('denies registry pin mismatch', async () => {
    const policy = policyDocumentFromPolicyInput({
      ...baseInput,
      expectedRegistryId: 'urn:openpacker:registry:npmjs-org',
    });
    const facts = {
      evidence: [] as { type: string; status: 'valid' }[],
      lifecycle: {
        status: 'published' as const,
        eligible: true,
        warnings: [] as string[],
      },
      packageId: 'pkg:npm/demo@1.0.0',
      registryId: 'urn:openpacker:registry:evil-mirror',
      evaluationTime: '2026-08-04T00:00:00.000Z',
    };
    await expect(assertSupplyChainAllowed(policy, facts)).rejects.toMatchObject(
      {
        code: 'POLICY_DENIED',
      },
    );
  });

  it('missing publishedAt is indeterminate unless strict', async () => {
    const soft = policyDocumentFromPolicyInput({
      ...baseInput,
      minimumReleaseAgeMinutes: 60,
    });
    const strict = policyDocumentFromPolicyInput({
      ...baseInput,
      minimumReleaseAgeMinutes: 60,
      minimumReleaseAgeStrict: true,
    });
    const facts = {
      evidence: [] as [],
      lifecycle: {
        status: 'published' as const,
        eligible: true,
        warnings: [] as string[],
      },
      packageId: 'pkg:npm/demo@1.0.0',
      evaluationTime: '2026-08-04T00:00:00.000Z',
    };
    await expect(assertSupplyChainAllowed(soft, facts)).rejects.toMatchObject({
      code: 'POLICY_INDETERMINATE',
    });
    await expect(assertSupplyChainAllowed(strict, facts)).rejects.toMatchObject(
      {
        code: 'POLICY_DENIED',
      },
    );
  });

  it('maps PolicyInput schema fields through policyDocumentFromPolicyInput', async () => {
    const input: PolicyInput = {
      allowYanked: false,
      allowQuarantined: false,
      semanticLossMaximum: 'warning',
      requiredEvidence: [],
      minimumReleaseAgeMinutes: 10,
      trustPolicy: 'no-downgrade',
      blockExoticSources: { transitive: true },
      allowLifecycleScripts: false,
      expectedRegistryId: 'urn:openpacker:registry:npmjs-org',
    };
    const document = policyDocumentFromPolicyInput(input);
    const ok = await evaluatePolicy(document, {
      evidence: [],
      lifecycle: { status: 'published', eligible: true, warnings: [] },
      packageId: 'pkg:npm/demo@1.0.0',
      publishedAt: '2020-01-01T00:00:00.000Z',
      evaluationTime: '2026-08-04T00:00:00.000Z',
      trustLevel: 'provenance',
      priorTrustLevel: 'unsigned',
      sourceKind: 'registry',
      dependencyDepth: 1,
      registryId: 'urn:openpacker:registry:npmjs-org',
      lifecycleScriptsExecuted: false,
    });
    expect(ok.decision).toBe('allow');
  });
});

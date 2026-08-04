import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

test('golden protocol corpus contains the mandatory artifact classes', () => {
  const manifest = JSON.parse(
    readFileSync(join(root, 'fixtures/golden/manifest.json'), 'utf8'),
  );
  assert.equal(manifest.schemaVersion, 'org.openpacker.golden-manifest.v1');
  const required = [
    'normalize',
    'identity',
    'enumeration',
    'snapshot',
    'universe',
    'solution',
    'proof',
    'explanation',
    'unsatisfiable',
    'receipt',
    'lockfile',
    'lifecycle',
    'event',
    'oci',
    'ocm',
    'tuf',
    'sigstore',
    'slsa',
    'cyclonedx',
  ];
  assert.equal(
    manifest.entries.length,
    required.length,
    'golden manifest must contain exactly one entry per mandatory class',
  );
  assert.deepEqual(
    [...new Set(manifest.entries.map(({ kind }) => kind))].sort(),
    [...required].sort(),
  );
  for (const entry of manifest.entries) {
    const bytes = readFileSync(join(root, entry.file));
    assert.equal(
      `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      entry.digest,
      `${entry.kind} golden is stale`,
    );
  }
});

test('native artifact fixtures exactly match their deterministic generator', () => {
  const result = spawnSync(
    process.execPath,
    [join(root, 'fixtures/artifacts/generate.mjs'), '--check'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

/** The projection every node identity must equal. */
async function nodeIdProjection() {
  const { canonicalProjectionDigest, formatDigest } = await import(
    '@openpacker/canonical'
  );
  const { DIGEST_PROJECTIONS } = await import('@openpacker/contracts');
  const projection = DIGEST_PROJECTIONS.projections.find(
    (item) => item.id === 'package-node-v1',
  );
  assert.ok(projection, 'package-node-v1 must exist in the registry');
  return async (instance) =>
    formatDigest(await canonicalProjectionDigest(instance, projection));
}

const PROVENANCE = {
  providerId: 'fixture',
  endpoint: 'https://fixtures.test',
  retrievedAt: '2026-08-02T00:00:00Z',
  evaluationTime: '2026-08-02T00:00:00Z',
  metadataDigest: { algorithm: 'sha256', value: '6'.repeat(64) },
};

test('every codec derives node identity as the package-node-v1 projection', async () => {
  // The golden universe covers npm, cargo and nuget, all with empty
  // qualifiers, so it cannot see a codec that forgets to pass qualifiers or
  // its native semantics version. This drives every codec directly, and
  // chooses inputs that produce *non-empty* qualifiers wherever the ecosystem
  // can express them — which is exactly where the two derivations diverge.
  const expectedFor = await nodeIdProjection();
  const [
    { NpmCodec },
    { CargoCodec },
    { NugetCodec },
    { PypiCodec },
    { GolangCodec },
    { MavenCodec },
    { NixCodec },
  ] = await Promise.all([
    import('@openpacker/adapter-npm'),
    import('@openpacker/adapter-cargo'),
    import('@openpacker/adapter-nuget'),
    import('@openpacker/adapter-pypi'),
    import('@openpacker/adapter-golang'),
    import('@openpacker/adapter-maven'),
    import('@openpacker/adapter-nix'),
  ]);

  const pypiProject = JSON.parse(
    await readFile(join(root, 'fixtures/catalogs/pypi/project.json'), 'utf8'),
  );
  const outHash = 'b3f2q8xr7k1v5m9n0p4s6w2y4z6a8c1d';
  const planHash = '97ml2f4h6j8k0n2p4r6v0x2z4b6d8f1s';

  const cases = [
    [
      'npm',
      new NpmCodec(),
      { name: '@openpacker/demo-tool', version: '1.1.0' },
    ],
    [
      'cargo',
      new CargoCodec(),
      {
        name: 'demo-zstd',
        vers: '1.0.0',
        deps: [],
        cksum: 'b'.repeat(64),
        features: {},
      },
    ],
    ['nuget', new NugetCodec(), { id: 'Demo.Tool', version: '1.0.0' }],
    [
      'pypi',
      new PypiCodec(),
      { kind: 'project-version', project: pypiProject, version: '1.0.0' },
    ],
    [
      'golang',
      new GolangCodec(),
      { path: 'github.com/openpacker/demo-zstd', version: 'v1.0.0' },
    ],
    // Non-default packaging and a classifier, so identity.qualifiers is
    // non-empty. Maven shipped a node ID that was the projection of a
    // different identity than the one it labelled, for exactly this input.
    [
      'maven',
      new MavenCodec(),
      {
        groupId: 'org.example',
        artifactId: 'demo-tool',
        version: '1.0.0',
        packaging: 'war',
        classifier: 'sources',
      },
    ],
    [
      'nix',
      new NixCodec(),
      {
        path: `/nix/store/${outHash}-libgreet-1.0`,
        output: 'out',
        deriver: `/nix/store/${planHash}-libgreet-1.0.drv`,
        narHash: `sha256:${'5'.repeat(64)}`,
        narSize: 49152,
        references: [],
      },
    ],
  ];

  let sawQualifiers = false;
  for (const [ecosystem, codec, metadata] of cases) {
    const { instance } = await codec.translateMetadata(metadata, PROVENANCE);
    if (Object.keys(instance.identity.qualifiers ?? {}).length > 0)
      sawQualifiers = true;
    assert.equal(
      instance.nodeId,
      await expectedFor(instance),
      `${ecosystem} nodeId is not the package-node-v1 digest of its own instance`,
    );
  }
  assert.ok(
    sawQualifiers,
    'at least one case must carry non-empty qualifiers, or this proves nothing',
  );
});

test('imported native lockfiles derive node identity through the projection', async () => {
  // Lock import builds instances without going through a codec, and had its
  // own derivation. It ships as `npm run demo:lock-import` across all six
  // ecosystems, so every one of them is checked here.
  const expectedFor = await nodeIdProjection();
  const { planNativeLockImport } = await import('@openpacker/lock-import');
  const fixtures = [
    'npm/package-lock.json',
    'cargo/Cargo.lock',
    'nuget/project.assets.json',
    'pypi/uv.lock.json',
    'golang/go.sum',
    'maven/gradle.lockfile',
  ];

  for (const fixture of fixtures) {
    const raw = await readFile(join(root, 'fixtures/locks', fixture), 'utf8');
    const plan = await planNativeLockImport(raw);
    assert.ok(
      plan.universe.packages.length > 0,
      `${fixture} produced no packages`,
    );
    for (const instance of plan.universe.packages)
      assert.equal(
        instance.nodeId,
        await expectedFor(instance),
        `${fixture}: ${instance.identity.exactPurl} nodeId is not its package-node-v1 digest`,
      );
  }
});

test('every golden node identity is the package-node-v1 projection', async () => {
  // Node identity is normative, not a convenient hash of whatever was handy.
  // Six codecs, the nix codec, and the demo each derived it differently once;
  // this pins them to the projection so they cannot drift apart again.
  const { canonicalProjectionDigest, formatDigest } = await import(
    '@openpacker/canonical'
  );
  const { DIGEST_PROJECTIONS } = await import('@openpacker/contracts');
  const projection = DIGEST_PROJECTIONS.projections.find(
    (item) => item.id === 'package-node-v1',
  );
  assert.ok(projection, 'package-node-v1 must exist in the registry');

  const universe = JSON.parse(
    await readFile(join(root, 'fixtures/golden/universe.json'), 'utf8'),
  );
  assert.ok(universe.packages.length > 0, 'universe must contain packages');
  for (const instance of universe.packages) {
    const expected = formatDigest(
      await canonicalProjectionDigest(instance, projection),
    );
    assert.equal(
      instance.nodeId,
      expected,
      `${instance.identity.exactPurl} nodeId is not its package-node-v1 digest`,
    );
  }
});

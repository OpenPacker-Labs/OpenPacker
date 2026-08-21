#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  canonicalize,
  parseCanonicalJson,
  sha256,
} from '@openpacker/canonical';
import { NpmCodec } from '@openpacker/adapter-npm';
import { CargoCodec } from '@openpacker/adapter-cargo';
import { NugetCodec } from '@openpacker/adapter-nuget';
import {
  firstPartyOriginPolicy,
  normalizePinnedOrigin,
  parseHttpsOriginList,
  parseVers,
  redactUrl,
} from '@openpacker/adapter-core';
import {
  createChunkIndex,
  reconstruct,
  validateChunkIndex,
} from '@openpacker/chunking';
import { createPrexValidator, validateContract } from '@openpacker/conformance';
import { validateArchivePath } from '@openpacker/materializer';
import { validateOciDescriptor, validateManifest } from '@openpacker/oci';
import { validateOcmDescriptor } from '@openpacker/ocm';
import { createEmbeddedResolver } from '@openpacker/embedded';
import * as wasmBindings from '@openpacker/embedded/wasm-node';

const root = resolve(import.meta.dirname, '..');
const seed = '0x5eed1234';
let state = Number(seed);
const random = () =>
  (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const integer = (maximum) => Math.floor(random() * maximum);
const pick = (values) => values[integer(values.length)];
const clone = (value) => structuredClone(value);
const classes = Object.create(null);
const count = (name, amount = 1) => {
  classes[name] = (classes[name] ?? 0) + amount;
};
const rejects = (action, message) => {
  assert.throws(action, undefined, message);
};

const codecs = [
  {
    codec: new NpmCodec(),
    purl: (index, version) =>
      `pkg:npm/%40scope${index % 11}/package-${index}@${version}`,
    metadata: (index, version) => ({
      name: `@scope${index % 11}/package-${index}`,
      version,
      dependencies: { dependency: '^1.0.0' },
    }),
    versionField: 'version',
    range: (version) =>
      pick([`>=${version}`, `^${version}`, `~${version}`, version]),
  },
  {
    codec: new CargoCodec(),
    purl: (index, version) => `pkg:cargo/package-${index}@${version}`,
    metadata: (index, version) => ({
      name: `package-${index}`,
      vers: version,
      deps: [{ name: 'dependency', req: '^1.0.0' }],
      cksum: 'a'.repeat(64),
      features: {},
      yanked: false,
    }),
    versionField: 'vers',
    range: (version) =>
      pick([`>=${version}`, `^${version}`, `~${version}`, version]),
  },
  {
    codec: new NugetCodec(),
    purl: (index, version) => `pkg:nuget/Package.${index}@${version}`,
    metadata: (index, version) => ({
      id: `Package.${index}`,
      version,
      dependencyGroups: [
        { dependencies: [{ id: 'Dependency', range: '[1.0.0,2.0.0)' }] },
      ],
    }),
    versionField: 'version',
    range: (version) =>
      pick([
        `[${version},)`,
        `[${version},99.0.0)`,
        version,
        `${version.split('.')[0]}.*`,
      ]),
  },
];

for (let index = 0; index < 2_000; index += 1) {
  const object = {
    a: integer(1_000_000),
    b: Array.from({ length: integer(8) }, () =>
      pick([null, true, false, integer(10_000), `s${integer(10_000)}`]),
    ),
    c: { [`k${integer(100)}`]: `v${integer(100)}` },
  };
  const first = canonicalize(object);
  assert.equal(canonicalize(parseCanonicalJson(first)), first);
  rejects(
    () => parseCanonicalJson(`{"duplicate":${index},"duplicate":0}`),
    'canonical JSON accepted duplicate keys',
  );
  count('canonical-json', 2);
}

const hostLabels = ['a.example', 'cdn.example', 'registry.internal'];
for (let index = 0; index < 400; index += 1) {
  const host = pick(hostLabels);
  const valid = `https://${host}`;
  assert.equal(normalizePinnedOrigin(valid), valid);
  assert.equal(normalizePinnedOrigin(`${valid}/`), valid);
  const poisoned = pick([
    `http://${host}`,
    `https://user:secret@${host}`,
    `https://${host}/path`,
    `https://${host}/?q=${index}`,
    `https://${host}/#${index}`,
    'not-a-url',
  ]);
  assert.throws(
    () => normalizePinnedOrigin(poisoned),
    (error) => {
      assert.equal(error.code, 'INVALID_PROVIDER_ENDPOINT');
      assert.doesNotMatch(error.message, /user:secret/u);
      return true;
    },
    'malformed host-fetch pin accepted',
  );
  const extras = parseHttpsOriginList(
    `${valid}, https://files.pythonhosted.org`,
    'fuzz extras',
  );
  assert.deepEqual(extras, [valid, 'https://files.pythonhosted.org']);
  const policy = firstPartyOriginPolicy({
    endpoint: `https://${host}/pypi`,
    namedOrOverride: true,
    artifactOrigins: ['https://files.pythonhosted.org'],
    extraOrigins: extras,
  });
  assert.ok(!policy.allowedOrigins.includes('https://pypi.org'));
  assert.deepEqual(policy.pinnedOrigins, [valid]);
  assert.equal(
    redactUrl(new URL(`https://user:secret@${host}/artifacts/x?token=1#h`)),
    `https://${host}/artifacts/x`,
  );
  count('host-fetch-pins', 4);
}

for (const { codec, purl, range } of codecs) {
  for (let index = 0; index < 1_000; index += 1) {
    const version = `${integer(20)}.${integer(30)}.${integer(50)}${
      integer(5) === 0 ? `-${pick(['alpha', 'beta', 'rc'])}.${integer(10)}` : ''
    }`;
    const normalized = codec.parseNativeVersion(version).normalized;
    assert.equal(codec.parseNativeVersion(normalized).normalized, normalized);
    const nativeRange = range(version);
    const first = codec.satisfies(version, nativeRange);
    assert.equal(codec.satisfies(version, nativeRange), first);
    count('native-ranges', 2);

    const vers = codec.toVers(nativeRange);
    assert.deepEqual(codec.toVers(nativeRange), vers);
    if (vers.vers) {
      assert.match(vers.vers, new RegExp(`^vers:${codec.purlType}/`));
      assert.equal(parseVers(vers.vers).vers, vers.vers);
      rejects(() => parseVers(`${vers.vers}|`), 'malformed VERS accepted');
    } else {
      assert.equal(vers.reversible, false);
      assert.ok(vers.semanticLoss.length > 0);
    }
    count('vers', 2);

    const canonicalPurl = codec.canonicalizePurl(purl(index, version));
    assert.equal(codec.canonicalizePurl(canonicalPurl), canonicalPurl);
    rejects(
      () => codec.canonicalizePurl(`not-a-purl-${index}`),
      'malformed PURL accepted',
    );
    count('purl', 2);
  }
}

const provenance = {
  providerId: 'fuzz-fixture',
  endpoint: 'https://fixtures.openpacker.dev',
  retrievedAt: '2026-08-03T00:00:00Z',
  evaluationTime: '2026-08-03T00:00:00Z',
  metadataDigest: { algorithm: 'sha256', value: 'b'.repeat(64) },
};
for (const { codec, metadata, versionField } of codecs) {
  for (let index = 0; index < 100; index += 1) {
    const version = `${integer(20)}.${integer(30)}.${integer(50)}`;
    const value = metadata(index, version);
    const first = await codec.translateMetadata(value, provenance);
    const second = await codec.translateMetadata(clone(value), provenance);
    assert.equal(canonicalize(first.instance), canonicalize(second.instance));
    await assert.rejects(
      codec.translateMetadata(
        { ...value, [versionField]: 'not a version' },
        provenance,
      ),
      undefined,
      'malformed provider metadata accepted',
    );
    count('provider-metadata', 2);
  }
}

const digestString = (character = 'a') => `sha256:${character.repeat(64)}`;
for (let index = 0; index < 500; index += 1) {
  const descriptor = {
    mediaType: `application/vnd.openpacker.fuzz-${index % 7}+json`,
    digest: digestString(pick(['a', 'b', 'c', 'd'])),
    size: integer(1_000_000),
  };
  validateOciDescriptor(descriptor);
  const manifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    artifactType: 'application/vnd.openpacker.fuzz.v1',
    config: descriptor,
    layers: [descriptor],
  };
  validateManifest(manifest);
  const malformed = clone(manifest);
  pick([
    () => (malformed.schemaVersion = 1),
    () => (malformed.config.digest = 'sha256:bad'),
    () => (malformed.layers[0].size = -1),
  ])();
  rejects(() => validateManifest(malformed), 'malformed OCI manifest accepted');
  count('oci-manifests', 2);
}

const ocmDescriptors = JSON.parse(
  readFileSync(join(root, 'fixtures/golden/ocm.json'), 'utf8'),
);
for (let index = 0; index < 500; index += 1) {
  const descriptor = clone(pick(ocmDescriptors));
  validateOcmDescriptor(descriptor);
  const malformed = clone(descriptor);
  pick([
    () => (malformed.meta.schemaVersion = 'v1'),
    () => (malformed.component.name = 'invalid component name'),
    () => (malformed.component.version = ''),
  ])();
  rejects(
    () => validateOcmDescriptor(malformed),
    'malformed OCM descriptor accepted',
  );
  count('ocm-descriptors', 2);
}

const artifactBytes = Uint8Array.from({ length: 2_048 }, () => integer(256));
const artifactDigest = await sha256(artifactBytes);
const chunkBytes = new Map();
const chunkIndex = await createChunkIndex(
  new Blob([artifactBytes]).stream(),
  { digest: artifactDigest, size: artifactBytes.byteLength },
  { minimumSize: 32, averageSize: 64, maximumSize: 128 },
  (bytes, record) => chunkBytes.set(record.offset, bytes),
);
assert.deepEqual(
  await reconstruct(chunkIndex, async (record) =>
    chunkBytes.get(record.offset),
  ),
  artifactBytes,
);
count('chunk-indexes');
for (let index = 0; index < 500; index += 1) {
  validateChunkIndex(chunkIndex);
  const malformed = clone(chunkIndex);
  pick([
    () => (malformed.chunks[0].offset += 1),
    () => (malformed.chunks[0].length = 0),
    () => (malformed.chunks[0].digest.value = 'bad'),
    () => (malformed.subject.size += 1),
  ])();
  rejects(
    () => validateChunkIndex(malformed),
    'malformed chunk index accepted',
  );
  count('chunk-indexes', 2);
}

for (let index = 0; index < 2_000; index += 1) {
  const parts = Array.from({ length: 1 + integer(6) }, () =>
    pick(['bin', 'lib', 'share', `x${integer(100)}`, '..', '.']),
  );
  const path = `${integer(20) === 0 ? '/' : ''}${parts.join(pick(['/', '\\']))}`;
  let accepted = true;
  try {
    validateArchivePath(path);
  } catch {
    accepted = false;
  }
  if (/^(?:\/|\\\\|[A-Za-z]:)|(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(path))
    assert.equal(accepted, false, `unsafe path accepted: ${path}`);
  count('archive-entries');
}

const schema =
  'https://openpacker.dev/spec/prex/v1/schemas/resolution.schema.json#/$defs/';
const validator = createPrexValidator();
const contracts = [
  {
    name: 'resolver-universe',
    definition: 'ResolutionUniverse',
    value: JSON.parse(
      readFileSync(join(root, 'fixtures/golden/universe.json'), 'utf8'),
    ),
    mutate: [
      (value) => (value.universeVersion = '2'),
      (value) => (value.packages = null),
      (value) => (value.lifecycleRoot.value = 'bad'),
      (value) => delete value.canonicalDigest,
    ],
  },
  {
    name: 'proof-object',
    definition: 'ResolutionProof',
    value: JSON.parse(
      readFileSync(join(root, 'fixtures/golden/proof.json'), 'utf8'),
    ),
    mutate: [
      (value) => (value.proofVersion = '2'),
      (value) => (value.selectedAssignments = null),
      (value) => (value.universeDigest.value = 'bad'),
      (value) => delete value.targetChecks,
    ],
  },
  {
    name: 'receipt-envelope',
    definition: 'SignedReceipt',
    value: JSON.parse(
      readFileSync(join(root, 'fixtures/golden/receipt.json'), 'utf8'),
    ),
    mutate: [
      (value) => (value.receipt.protocolVersion = '0'),
      (value) => (value.signatures = []),
      (value) => (value.receiptDigest.algorithm = 'md5'),
      (value) => delete value.receipt,
    ],
  },
];
for (const contract of contracts) {
  assert.equal(
    validateContract(schema + contract.definition, contract.value, validator)
      .valid,
    true,
    `${contract.name} golden is invalid`,
  );
  for (let index = 0; index < 500; index += 1) {
    const stable = canonicalize(contract.value);
    assert.equal(canonicalize(parseCanonicalJson(stable)), stable);
    const malformed = clone(contract.value);
    pick(contract.mutate)(malformed);
    assert.equal(
      validateContract(schema + contract.definition, malformed, validator)
        .valid,
      false,
      `malformed ${contract.name} accepted`,
    );
    count(contract.name, 2);
  }
}

const resolver = createEmbeddedResolver(wasmBindings);
const solveInput = {
  request: JSON.parse(
    readFileSync(join(root, 'fixtures/protocol/solve/request.json'), 'utf8'),
  ),
  universe: JSON.parse(
    readFileSync(join(root, 'fixtures/golden/universe.json'), 'utf8'),
  ),
};
for (let index = 0; index < 64; index += 1) {
  const input = clone(solveInput);
  for (let right = input.universe.packages.length - 1; right > 0; right -= 1) {
    const left = integer(right + 1);
    [input.universe.packages[left], input.universe.packages[right]] = [
      input.universe.packages[right],
      input.universe.packages[left],
    ];
  }
  const output = resolver.solve(input);
  assert.deepEqual(resolver.check(input, output), {
    valid: true,
    diagnostics: [],
  });
  assert.deepEqual(
    resolver.bruteForceOracle(input).selectedNodeIds,
    output.solution.selectedNodeIds,
  );
  const malformed = clone(output);
  pick([
    () =>
      (malformed.proof.selectedAssignments[0].selected =
        !malformed.proof.selectedAssignments[0].selected),
    () => (malformed.proof.universeDigest.value = 'f'.repeat(64)),
    () => (malformed.proof.requirementWitnesses[0].witnessNodeIds = []),
    () => (malformed.solution.objectiveTuple[0] = 999),
  ])();
  assert.equal(resolver.check(input, malformed).valid, false);
  count('resolver-universe', 3);
  count('proof-object');
}

const rustManifest = join(root, 'tests/rust-fuzz/Cargo.toml');
for (const [name, args] of [
  ['format', ['fmt', '--manifest-path', rustManifest, '--', '--check']],
  [
    'clippy',
    [
      'clippy',
      '--manifest-path',
      rustManifest,
      '--all-targets',
      '--locked',
      '--',
      '-D',
      'warnings',
    ],
  ],
  [
    'proptest',
    ['test', '--manifest-path', rustManifest, '--locked', '--quiet'],
  ],
]) {
  const rust = spawnSync('cargo', args, { cwd: root, stdio: 'inherit' });
  if (rust.error) throw rust.error;
  assert.equal(rust.status, 0, `bounded Rust ${name} gate failed`);
}
count('rust-proptest', 5 * 128);

const cases = Object.values(classes).reduce((sum, value) => sum + value, 0);
mkdirSync(join(root, '.demo-output'), { recursive: true });
writeFileSync(
  join(root, '.demo-output/fuzz-report.json'),
  `${JSON.stringify({ seed, cases, classes, status: 'passed' }, null, 2)}\n`,
);
console.log(
  `bounded deterministic fuzz smoke: ${cases} cases passed across ${Object.keys(classes).length} classes (seed ${seed})`,
);

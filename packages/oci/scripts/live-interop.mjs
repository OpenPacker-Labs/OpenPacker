import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  descriptorForBytes,
  streamFromBytes,
} from '@openpacker/artifact-model';
import { canonicalBytes } from '@openpacker/canonical';
import { createOcmDescriptor, ocmDescriptorBytes } from '@openpacker/ocm';
import {
  OCI_EMPTY_CONFIG_BYTES,
  OCI_MEDIA_TYPES,
  OciRegistryClient,
  ociDescriptor,
} from '../dist/esm/index.js';

if (process.env.OPENPACKER_LIVE_TESTS !== '1')
  throw new Error('set OPENPACKER_LIVE_TESTS=1 to run live interoperability');

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const zotImage = required('OPENPACKER_ZOT_IMAGE');
assert.match(
  zotImage,
  /^ghcr\.io\/project-zot\/[^@]+@sha256:[0-9a-f]{64}$/u,
  'OPENPACKER_ZOT_IMAGE must pin Zot by sha256 image digest',
);
const registry = new URL(required('OPENPACKER_LIVE_REGISTRY'));
const repository = required('OPENPACKER_LIVE_REPOSITORY');
const oras = process.env.OPENPACKER_ORAS ?? 'oras';
const ocm = process.env.OPENPACKER_OCM ?? 'ocm';
const orasVersion = required('OPENPACKER_ORAS_VERSION');
const ocmVersion = required('OPENPACKER_OCM_VERSION');

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return `${result.stdout}\n${result.stderr}`;
};

assert.match(
  run(oras, ['version']),
  new RegExp(`\\b${orasVersion.replaceAll('.', '\\.')}\\b`, 'u'),
);
assert.match(
  run(ocm, ['version']),
  new RegExp(`\\b${ocmVersion.replaceAll('.', '\\.')}\\b`, 'u'),
);

const client = new OciRegistryClient({
  registry,
  repository,
  retryDelayMilliseconds: 100,
  monolithicUploadMaximumBytes: 16,
});
const nativeBytes = new TextEncoder().encode('openpacker-live-native-bytes\n');
const native = await ociDescriptor(
  nativeBytes,
  'application/vnd.npm.package+gzip',
);
const config = await ociDescriptor(
  OCI_EMPTY_CONFIG_BYTES,
  OCI_MEDIA_TYPES.emptyConfig,
);
await client.pushBlob(native, streamFromBytes(nativeBytes));
await client.pushBlob(config, streamFromBytes(OCI_EMPTY_CONFIG_BYTES));
const manifest = {
  schemaVersion: 2,
  mediaType: OCI_MEDIA_TYPES.manifest,
  artifactType: 'application/vnd.openpacker.package',
  config,
  layers: [native],
  annotations: {
    'org.opencontainers.image.ref.name': 'pkg:npm/openpacker-live@1.0.0',
  },
};
const manifestBytes = canonicalBytes(manifest);
const manifestDescriptor = await ociDescriptor(
  manifestBytes,
  OCI_MEDIA_TYPES.manifest,
  { artifactType: manifest.artifactType },
);
await client.pushManifest('openpacker-live', manifestBytes, manifestDescriptor);

const referrerPayload = canonicalBytes({ receiptVersion: '1', fixture: true });
const referrerLayer = await ociDescriptor(referrerPayload, 'application/json');
await client.pushBlob(referrerLayer, streamFromBytes(referrerPayload));
const referrerManifest = {
  schemaVersion: 2,
  mediaType: OCI_MEDIA_TYPES.manifest,
  artifactType: 'application/vnd.openpacker.prex.receipt.v1+json',
  config,
  layers: [referrerLayer],
  subject: manifestDescriptor,
};
const referrerBytes = canonicalBytes(referrerManifest);
const referrerDescriptor = await ociDescriptor(
  referrerBytes,
  OCI_MEDIA_TYPES.manifest,
  { artifactType: referrerManifest.artifactType },
);
await client.pushManifest(
  referrerDescriptor.digest,
  referrerBytes,
  referrerDescriptor,
);

assert.deepEqual(await client.pullBlob(native), nativeBytes);
assert.equal(
  (await client.pullManifest('openpacker-live')).descriptor.digest,
  manifestDescriptor.digest,
);
assert.ok(
  (await client.listReferrers(manifestDescriptor)).some(
    ({ digest }) => digest === referrerDescriptor.digest,
  ),
  'registry did not return the pushed OCI 1.1 referrer',
);

const registryReference = `${registry.host}/${repository}:openpacker-live`;
const copiedReference = `${registry.host}/${repository}:oras-copy`;
const plainHttp = registry.protocol === 'http:' ? ['--plain-http'] : [];
run(oras, ['manifest', 'fetch', ...plainHttp, registryReference]);
run(oras, ['copy', ...plainHttp, registryReference, copiedReference]);
assert.equal(
  (await client.pullManifest('oras-copy')).descriptor.digest,
  manifestDescriptor.digest,
);

const artifact = await descriptorForBytes({
  bytes: nativeBytes,
  descriptorId: 'pkg:npm/openpacker-live@1.0.0',
  mediaType: native.mediaType,
  artifactType: manifest.artifactType,
  nativeRole: 'native-package',
  fileName: 'openpacker-live.tgz',
});
const component = await createOcmDescriptor({
  name: 'openpacker.dev/live/openpacker-live',
  version: '1.0.0',
  provider: 'org.openpacker.live-test',
  exactPurl: artifact.descriptorId,
  resources: [{ name: artifact.fileName, artifact }],
});
const temporary = await mkdtemp(join(tmpdir(), 'openpacker-ocm-live-'));
try {
  const descriptorPath = join(temporary, 'component-descriptor.json');
  await writeFile(descriptorPath, ocmDescriptorBytes(component));
  const args = JSON.parse(required('OPENPACKER_OCM_VALIDATE_ARGS'));
  assert.ok(
    Array.isArray(args),
    'OPENPACKER_OCM_VALIDATE_ARGS must be a JSON array',
  );
  assert.ok(
    args.includes('{descriptor}'),
    'OCM validation arguments need {descriptor}',
  );
  run(
    ocm,
    args.map((argument) =>
      argument === '{descriptor}' ? descriptorPath : String(argument),
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log(
  JSON.stringify({
    registry: registry.origin,
    repository,
    manifestDigest: manifestDescriptor.digest,
    nativeDigest: native.digest,
    referrerDigest: referrerDescriptor.digest,
    orasVersion,
    ocmVersion,
    zotImage,
  }),
);

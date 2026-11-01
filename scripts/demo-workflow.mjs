import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  canonicalBytes,
  canonicalDigest,
  canonicalProjectionDigest,
  formatDigest,
  sha256,
} from '@openpacker/canonical';
import { DIGEST_PROJECTIONS } from '@openpacker/contracts';
import {
  descriptorForBytes,
  streamFromBytes,
} from '@openpacker/artifact-model';
import {
  FixtureHttpTransport,
  formatPurl,
  packageNodeId,
  parsePurl,
} from '@openpacker/adapter-core';
import { NpmRegistryProvider } from '@openpacker/adapter-npm';
import { CargoSparseProvider } from '@openpacker/adapter-cargo';
import { NugetV3Provider } from '@openpacker/adapter-nuget';
import { FilesystemArtifactStore } from '@openpacker/artifact-store';
import { captureCatalogSnapshot } from '@openpacker/catalog';
import { createChunkIndex, validateChunkIndex } from '@openpacker/chunking';
import { createEmbeddedResolver } from '@openpacker/embedded';
import { loadNativeEmbeddedResolver } from '@openpacker/embedded/native';
import * as wasmBindings from '@openpacker/embedded/wasm-node';
import { createCloudEvent, verifyCloudEvent } from '@openpacker/events';
import { reduceLifecycle } from '@openpacker/lifecycle';
import { materialize } from '@openpacker/materializer';
import { OciImageLayout } from '@openpacker/oci';
import {
  mapSolutionToOcm,
  ocmDescriptorBytes,
  validateOcmDescriptor,
} from '@openpacker/ocm';
import { evaluatePolicy } from '@openpacker/policy';
import { verifySignedReceipt } from '@openpacker/receipts';
import {
  createReferenceOperations,
  OperationError,
  SqliteStateStore,
  startOpenPackerDaemon,
} from '@openpacker/openpackerd';
import { createOpenPackerClient } from '@openpacker/sdk';
import {
  Ed25519Signer,
  Ed25519Verifier,
  cycloneDxEvidenceStatus,
  extractCycloneDxEvidence,
  verifyOfflineSigstoreBundle,
  verifySlsaProvenance,
  verifyTufTarget,
} from '@openpacker/trust';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from './chromium.mjs';

const root = resolve(import.meta.dirname, '..');
/** Where the universe says the demo's output is; generate-goldens.mjs uses it too. */
const PORTABLE_OUTPUT = 'file:///OPENPACKER_DEMO_OUTPUT';

/** A materialization with the portable output location made the real one. */
function realLocations(materialized, output) {
  const real = pathToFileURL(output).href;
  return {
    ...materialized,
    descriptor: {
      ...materialized.descriptor,
      locations: materialized.descriptor.locations.map((location) =>
        typeof location !== 'string' &&
        location.uri.startsWith(`${PORTABLE_OUTPUT}/`)
          ? {
              ...location,
              uri: real + location.uri.slice(PORTABLE_OUTPUT.length),
            }
          : location,
      ),
    },
  };
}
const require = createRequire(import.meta.url);
const text = new TextEncoder();
const source = {
  type: 'overlay',
  uri: 'https://openpacker.dev/fixtures/overlay',
};
const meta = {
  protocolVersion: '1.0-draft',
  provider: {
    id: 'org.openpacker.reference',
    implementation: 'openpackerd',
    version: '0.1.0',
  },
};

const json = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));
const writeJson = (path, value) =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

function tar(entries) {
  const blocks = [];
  const octal = (value, length) =>
    text.encode(`${value.toString(8).padStart(length - 1, '0')}\0`);
  for (const entry of entries) {
    const data = text.encode(entry.data ?? '');
    const type = entry.type ?? '0';
    const mode = entry.mode ?? (type === '5' ? 0o755 : 0o644);
    const header = new Uint8Array(512);
    header.set(text.encode(entry.name), 0);
    header.set(octal(mode, 8), 100);
    header.set(octal(0, 8), 108);
    header.set(octal(0, 8), 116);
    header.set(octal(data.byteLength, 12), 124);
    header.set(octal(0, 12), 136);
    header.fill(32, 148, 156);
    header[156] = type.charCodeAt(0);
    header.set(text.encode('ustar\0'), 257);
    header.set(
      text.encode(
        `${[...header]
          .reduce((sum, byte) => sum + byte, 0)
          .toString(8)
          .padStart(6, '0')}\0 `,
      ),
      148,
    );
    blocks.push(
      header,
      data,
      new Uint8Array((512 - (data.byteLength % 512)) % 512),
    );
  }
  blocks.push(new Uint8Array(1024));
  const result = new Uint8Array(
    blocks.reduce((sum, block) => sum + block.byteLength, 0),
  );
  let offset = 0;
  for (const block of blocks) {
    result.set(block, offset);
    offset += block.byteLength;
  }
  return result;
}

async function artifact(
  bytes,
  descriptorId,
  mediaType,
  artifactType,
  fileName,
  nativeRole = 'native-package',
) {
  return descriptorForBytes({
    bytes,
    descriptorId,
    mediaType,
    artifactType,
    fileName,
    nativeRole,
  });
}

function completeExpression(input) {
  if (input.type === 'package') return { qualifiers: {}, ...input };
  if (input.type === 'capability') return { attributes: {}, ...input };
  if (input.type === 'allOf' || input.type === 'anyOf')
    return {
      ...input,
      expressions: input.expressions.map(completeExpression),
    };
  if (input.type === 'not')
    return { ...input, expression: completeExpression(input.expression) };
  if (input.type === 'conditional')
    return {
      ...input,
      // eslint-disable-next-line unicorn/no-thenable -- PREX uses `then` as a schema field.
      then: completeExpression(input.then),
      else:
        input.else === undefined ? undefined : completeExpression(input.else),
    };
  return input;
}

async function refreshUniverseDigest(universe) {
  const projection = DIGEST_PROJECTIONS.projections.find(
    ({ id }) => id === 'universe-v1',
  );
  assert.ok(projection);
  const transportUniverse = JSON.parse(JSON.stringify(universe));
  universe.canonicalDigest = await canonicalProjectionDigest(
    transportUniverse,
    projection,
  );
}

async function instance({
  exactPurl,
  purlType,
  name,
  version,
  artifacts = [],
  requirements = [],
  capabilities = [],
  conflicts = [],
  cardinalityConstraints = [],
  status = 'published',
}) {
  const parsed = parsePurl(exactPurl);
  assert.equal(parsed.type, purlType);
  assert.equal(parsed.version, version);
  const canonicalPurl = formatPurl({ ...parsed, version: undefined });
  // Node identity is the package-node-v1 projection, the same helper every
  // codec uses, so a universe built here is indistinguishable from one a codec
  // produced.
  const nodeId = await packageNodeId({
    exactPurl,
    nativeSemanticsVersion: `${purlType}-v1`,
  });
  const identity = {
    canonicalPurl,
    exactPurl,
    purlType: parsed.type,
    namespace: parsed.namespace,
    name: parsed.name,
    version: parsed.version,
    qualifiers: parsed.qualifiers,
    subpath: parsed.subpath,
    nativeCoordinates: [{ ecosystem: purlType, coordinate: name, version }],
    aliases: [],
    sourceRefs: [source],
    publisherRefs: [],
    externalRefs: [],
  };
  return {
    nodeId,
    identity,
    nativeVersion: version,
    normalizedVersion: version,
    versionSortKey: version,
    requirements: requirements.map((requirement, index) => ({
      id: `${nodeId}:r${index}`,
      dependerNodeId: nodeId,
      kind: requirement.optional ? 'optional' : 'runtime',
      optional: false,
      source,
      authority: requirement.authority ?? 'native',
      semanticLoss: [],
      ...requirement,
      expression: completeExpression(requirement.expression),
    })),
    capabilities: capabilities.map((capability) => ({
      providerNodeId: nodeId,
      source,
      attributes: {},
      ...capability,
    })),
    conflicts: conflicts.map((expression, index) => ({
      id: `${nodeId}:c${index}`,
      expression: completeExpression(expression),
      scope: 'solution',
      source,
    })),
    cardinalityConstraints: cardinalityConstraints.map((constraint, index) => ({
      id: `${nodeId}:k${index}`,
      scope: 'solution',
      source,
      ...constraint,
      selector: completeExpression(constraint.selector),
    })),
    artifacts,
    lifecycle: { status, eligible: status === 'published', warnings: [] },
    sourceSnapshots: [],
    metadataDigest: await canonicalDigest({ exactPurl, version }),
    nativeSemantics: {
      version: `${purlType}-v1`,
      data: { lifecycleScriptsExecuted: false },
    },
    semanticLoss: [],
  };
}

async function fixtureUniverse(output) {
  const manifest = json('fixtures/artifacts/upstream/manifest.json');
  const upstream = new Map(
    manifest.artifacts.map((entry) => [
      entry.exactPurl,
      {
        ...entry,
        bytes: readFileSync(
          join(root, 'fixtures/artifacts/upstream', entry.file),
        ),
      },
    ]),
  );
  for (const value of upstream.values())
    assert.equal(
      formatDigest(await sha256(value.bytes)),
      value.digest,
      `${value.file} digest mismatch`,
    );
  const toolBytes = gzipSync(
    tar([
      { name: 'bin/', type: '5' },
      {
        name: 'bin/openpacker-demo',
        mode: 0o755,
        data: "#!/bin/sh\nprintf 'openpacker-demo-ok\\n'\n",
      },
    ]),
    { level: 9 },
  );
  const toolArchive = join(output, 'openpacker-demo.tar.gz');
  writeFileSync(toolArchive, toolBytes);
  const tool = await artifact(
    toolBytes,
    'fixture-tool',
    'application/gzip',
    'application/vnd.openpacker.tool.v1+tar+gzip',
    'openpacker-demo.tar.gz',
    'tool-payload',
  );
  // The universe names the archive by a location that is the same in every
  // checkout: the solve, the proof and everything digested from them hold it.
  // A client that fetches the archive is handed the real file (realLocations).
  tool.locations = [
    {
      transport: 'file',
      uri: `${PORTABLE_OUTPUT}/${basename(toolArchive)}`,
      priority: 0,
      rangeSupported: false,
    },
  ];
  tool.extensions = {
    'org.openpacker.mise': { executables: ['bin/openpacker-demo'] },
  };
  const npmNative = upstream.get('pkg:npm/%40openpacker/demo-tool@1.0.0');
  const cargoNative = upstream.get('pkg:cargo/openpacker-zstd-wasm@1.0.0');
  const nugetNative = upstream.get('pkg:nuget/OpenPacker.Zstd.Tool@1.0.0');
  assert.ok(npmNative && cargoNative && nugetNative);
  const npmArtifact = await artifact(
    npmNative.bytes,
    npmNative.exactPurl,
    npmNative.mediaType,
    'application/vnd.openpacker.npm.package.v1',
    npmNative.file,
  );
  const cargoArtifact = await artifact(
    cargoNative.bytes,
    cargoNative.exactPurl,
    cargoNative.mediaType,
    'application/vnd.openpacker.cargo.package.v1',
    cargoNative.file,
  );
  const nugetArtifact = await artifact(
    nugetNative.bytes,
    nugetNative.exactPurl,
    nugetNative.mediaType,
    'application/vnd.openpacker.nuget.package.v1',
    nugetNative.file,
  );
  const cross = {
    expression: {
      type: 'package',
      purl: 'pkg:cargo/openpacker-zstd-wasm',
      vers: 'vers:cargo/>=1.0.0',
    },
    authority: 'publisher',
  };
  const capability = {
    expression: {
      type: 'capability',
      name: 'compression/zstd',
      vers: 'vers:generic/>=1',
    },
  };
  const nativeNpm = {
    expression: {
      type: 'package',
      purl: 'pkg:npm/openpacker-native-helper',
      vers: 'vers:npm/>=1.0.0',
    },
  };
  const optional = {
    expression: { type: 'package', purl: 'pkg:npm/optional-demo' },
    kind: 'optional',
    optional: true,
  };
  const conflict = { type: 'package', purl: 'pkg:npm/conflicting-demo' };
  const cardinality = {
    selector: { type: 'capability', name: 'compression/zstd' },
    minimum: 1,
    maximum: 1,
  };
  const common = {
    purlType: 'npm',
    name: '@openpacker/demo-tool',
    artifacts: [tool, npmArtifact],
    requirements: [cross, capability, nativeNpm, optional],
    conflicts: [conflict],
    cardinalityConstraints: [cardinality],
  };
  const packages = [
    await instance({
      ...common,
      exactPurl: 'pkg:npm/%40openpacker/demo-tool@1.0.0',
      version: '1.0.0',
    }),
    await instance({
      ...common,
      exactPurl: 'pkg:npm/%40openpacker/demo-tool@0.9.0',
      version: '0.9.0',
    }),
    await instance({
      ...common,
      exactPurl: 'pkg:npm/%40openpacker/demo-tool@1.0.0-beta.1',
      version: '1.0.0-beta.1',
    }),
    await instance({
      exactPurl: 'pkg:npm/openpacker-native-helper@1.0.0',
      purlType: 'npm',
      name: 'openpacker-native-helper',
      version: '1.0.0',
    }),
    await instance({
      exactPurl: 'pkg:cargo/openpacker-zstd-wasm@1.0.0',
      purlType: 'cargo',
      name: 'openpacker-zstd-wasm',
      version: '1.0.0',
      artifacts: [cargoArtifact],
      requirements: [
        {
          expression: {
            type: 'package',
            purl: 'pkg:cargo/openpacker-native-helper',
            vers: 'vers:cargo/>=1.0.0',
          },
        },
      ],
      capabilities: [
        {
          name: 'compression/zstd',
          version: '1',
          targetPredicate: {
            type: 'equals',
            path: 'architecture',
            value: 'arm64',
          },
        },
      ],
    }),
    await instance({
      exactPurl: 'pkg:cargo/openpacker-native-helper@1.0.0',
      purlType: 'cargo',
      name: 'openpacker-native-helper',
      version: '1.0.0',
    }),
    await instance({
      exactPurl: 'pkg:nuget/openpacker.zstd.tool@1.0.0',
      purlType: 'nuget',
      name: 'openpacker.zstd.tool',
      version: '1.0.0',
      artifacts: [nugetArtifact],
      requirements: [
        {
          expression: {
            type: 'package',
            purl: 'pkg:nuget/openpacker.native.helper',
            vers: 'vers:nuget/>=1.0.0',
          },
        },
      ],
      capabilities: [
        {
          name: 'compression/zstd',
          version: '1',
          targetPredicate: { type: 'equals', path: 'os', value: 'windows' },
        },
      ],
    }),
    await instance({
      exactPurl: 'pkg:nuget/openpacker.native.helper@1.0.0',
      purlType: 'nuget',
      name: 'openpacker.native.helper',
      version: '1.0.0',
    }),
    await instance({
      exactPurl: 'pkg:npm/conflicting-demo@1.0.0',
      purlType: 'npm',
      name: 'conflicting-demo',
      version: '1.0.0',
    }),
  ];
  const catalogBundles = await fixtureCatalogBundles();
  const snapshots = catalogBundles.map(({ snapshot }) => snapshot);
  const snapshot = snapshots[0];
  assert.ok(snapshot);
  for (const item of packages) {
    const matching = snapshots.find(({ providerType }) =>
      providerType.startsWith(item.identity.purlType),
    );
    assert.ok(matching);
    item.sourceSnapshots = [matching.rootDigest];
  }
  const lifecycleRoot = await canonicalDigest([]);
  const body = {
    universeVersion: '1',
    packages,
    overlays: [
      {
        overlayVersion: '1',
        subject: packages[0].identity,
        requirements: [packages[0].requirements[0]],
        capabilities: [],
        conflicts: [],
        cardinalityConstraints: [],
        artifactAnnotations: [],
        sourceRefs: [source],
        authority: 'publisher',
        evidenceRefs: [],
        externalRefs: [],
      },
    ],
    sourceSnapshots: snapshots,
    lifecycleRoot,
    targetVocabularyVersion: '1',
  };
  const universe = { ...body };
  await refreshUniverseDigest(universe);
  const cas = new FilesystemArtifactStore(join(output, 'cas'));
  await cas.initialize();
  for (const [descriptor, bytes] of [
    [tool, toolBytes],
    [npmArtifact, npmNative.bytes],
    [cargoArtifact, cargoNative.bytes],
    [nugetArtifact, nugetNative.bytes],
  ]) {
    await cas.putBlob(streamFromBytes(bytes), descriptor);
  }
  return {
    universe,
    snapshot,
    snapshots,
    catalogBundles,
    cas,
    upstream,
    tool,
    toolBytes,
  };
}

async function fixtureCatalogBundles() {
  const clock = { now: () => '2026-08-02T00:00:00Z' };
  const npmPackument = await readFile(
    join(root, 'fixtures/catalogs/npm/packument.json'),
  );
  const cargoIndex = await readFile(
    join(root, 'fixtures/catalogs/cargo/index/demo-zstd'),
  );
  const nugetService = await readFile(
    join(root, 'fixtures/catalogs/nuget/service-index.json'),
  );
  const nugetRegistration = await readFile(
    join(root, 'fixtures/catalogs/nuget/registration-demo.tool.json'),
  );
  const nugetPage = await readFile(
    join(root, 'fixtures/catalogs/nuget/registration-demo.tool-page-1.json'),
  );
  const providers = [
    [
      new NpmRegistryProvider(
        new FixtureHttpTransport(
          new Map([
            [
              'https://fixtures.test/%40openpacker%2Fdemo-tool',
              {
                status: 200,
                headers: { etag: '"fixture-1"' },
                body: npmPackument,
              },
            ],
          ]),
        ),
        clock,
        'https://fixtures.test',
      ),
      'pkg:npm/%40openpacker/demo-tool@1.0.0',
    ],
    [
      new CargoSparseProvider(
        new FixtureHttpTransport(
          new Map([
            [
              'https://fixtures.test/de/mo/demo-zstd',
              {
                status: 200,
                headers: { etag: '"cargo-1"' },
                body: cargoIndex,
              },
            ],
          ]),
        ),
        clock,
        'https://fixtures.test',
        'https://fixtures.test/crates',
      ),
      'pkg:cargo/demo-zstd@1.0.0',
    ],
    [
      new NugetV3Provider(
        new FixtureHttpTransport(
          new Map([
            [
              'https://fixtures.openpacker.invalid/nuget/service-index.json',
              { status: 200, headers: {}, body: nugetService },
            ],
            [
              'https://fixtures.openpacker.invalid/nuget/registration/demo.tool/index.json',
              {
                status: 200,
                headers: { etag: '"nuget-1"' },
                body: nugetRegistration,
              },
            ],
            [
              'https://fixtures.openpacker.invalid/nuget/registration/demo.tool/page/1.json',
              {
                status: 200,
                headers: { etag: '"nuget-1"' },
                body: nugetPage,
              },
            ],
          ]),
        ),
        clock,
        'https://fixtures.openpacker.invalid/nuget/service-index.json',
      ),
      'pkg:nuget/demo.tool@1.0.0',
    ],
  ];
  const bundles = [];
  for (const [provider, exactPurl] of providers) {
    const basePurl = exactPurl.slice(0, exactPurl.lastIndexOf('@'));
    assert.ok((await provider.enumerate(basePurl)).includes(exactPurl));
    bundles.push(
      await captureCatalogSnapshot(
        provider,
        [exactPurl],
        '2026-08-02T00:00:00Z',
      ),
    );
  }
  return bundles;
}

function solveRequest(evaluationTime) {
  return {
    requirements: [
      {
        id: 'root-tool',
        expression: {
          type: 'package',
          purl: 'pkg:npm/%40openpacker/demo-tool',
          vers: 'vers:npm/>=0.0.0|<2.0.0',
        },
        kind: 'runtime',
        optional: false,
        source,
        authority: 'test-fixture',
        semanticLoss: [],
      },
      {
        id: 'root-capability',
        expression: {
          type: 'capability',
          name: 'compression/zstd',
          vers: 'vers:generic/>=1',
        },
        kind: 'runtime',
        optional: false,
        source,
        authority: 'publisher',
        semanticLoss: [],
      },
      {
        id: 'root-nuget',
        expression: {
          type: 'package',
          purl: 'pkg:nuget/openpacker.zstd.tool',
          vers: 'vers:nuget/>=1.0.0',
        },
        kind: 'tool',
        optional: false,
        source,
        authority: 'test-fixture',
        semanticLoss: [],
      },
    ],
    target: {
      os: 'linux',
      architecture: 'arm64',
      libc: 'glibc',
      runtimes: { node: '24' },
      abi: {},
      capabilities: [],
      variables: {},
    },
    environment: { installed: [], locked: [] },
    policy: {
      allowYanked: false,
      allowQuarantined: false,
      semanticLossMaximum: 'warning',
      requiredEvidence: [],
      acceptedOverlayAuthorities: ['publisher', 'test-fixture'],
    },
    semantics: {
      profile: 'prex-calculus-subset-v1',
      nativeCompatibility: ['npm', 'cargo', 'nuget'],
    },
    objectives: [
      'satisfy-hard-constraints',
      'minimize-package-count',
      'exclude-lifecycle-denied',
      'prefer-stable',
      'prefer-highest-native-version',
      'canonical-lexical-tie-break',
    ],
    mode: 'closure',
    evaluationTime,
  };
}

function modeDigest(solved, receiptDigest) {
  return {
    request: formatDigest(solved.requestDigest),
    universe: formatDigest(solved.universeDigest),
    solution: formatDigest(solved.solution.solutionDigest),
    unsignedReceipt: formatDigest(receiptDigest),
  };
}

export async function browserSolve(
  input,
  receipt,
  launch = () => chromium.launch(chromiumLaunchOptions()),
) {
  const directory = join(root, 'packages/embedded/dist/esm');
  const server = createServer((request, response) => {
    const file =
      request.url === '/openpacker_wasm.js'
        ? 'openpacker_wasm.js'
        : request.url === '/openpacker_wasm_bg.wasm'
          ? 'openpacker_wasm_bg.wasm'
          : undefined;
    if (!file) {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>OpenPacker demo</title>');
      return;
    }
    response.setHeader(
      'content-type',
      file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
    );
    createReadStream(join(directory, file)).pipe(response);
  });
  await new Promise((resolve, reject) =>
    server.listen(0, '127.0.0.1', resolve).once('error', reject),
  );
  const address = server.address();
  let browser;
  try {
    // Inside the try: a browser that cannot start must still close the server,
    // or the listening socket keeps the process alive after the error is printed.
    browser = await launch();
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    return await page.evaluate(
      async ({ input, receipt }) => {
        const wasm = await import('/openpacker_wasm.js');
        await wasm.default();
        return {
          solved: JSON.parse(wasm.solve_json(JSON.stringify(input))),
          receiptDigest: JSON.parse(wasm.digest_json(JSON.stringify(receipt))),
        };
      },
      { input, receipt },
    );
  } finally {
    try {
      await browser?.close();
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}

async function sigstoreFixture(bytes, keys, evaluationTime) {
  const digest = await sha256(bytes);
  const rootSigner = await Ed25519Signer.fromJwk('root', keys.root);
  const leafSigner = await Ed25519Signer.fromJwk('leaf', keys.leaf);
  const logSigner = await Ed25519Signer.fromJwk('log', keys.log);
  const leafPayload = canonicalBytes(digest);
  const leaf = new Uint8Array(leafPayload.length + 1);
  leaf.set(leafPayload, 1);
  const leafDigest = await sha256(leaf);
  const certificate = {
    publicKey: keys.leaf.x,
    issuer: 'https://issuer.example',
    identity: 'release@example.test',
    notBefore: '2025-01-01T00:00:00Z',
    notAfter: '2027-01-01T00:00:00Z',
    signature: '',
  };
  certificate.signature = await rootSigner.sign(
    canonicalBytes({
      publicKey: certificate.publicKey,
      issuer: certificate.issuer,
      identity: certificate.identity,
      notBefore: certificate.notBefore,
      notAfter: certificate.notAfter,
    }),
  );
  const entry = {
    logId: 'fixture-log',
    bodyDigest: digest,
    integratedTime: evaluationTime,
    inclusionProof: {
      rootHash: leafDigest.value,
      logIndex: 0,
      treeSize: 1,
      hashes: [],
    },
    checkpointSignature: '',
  };
  entry.checkpointSignature = await logSigner.sign(
    canonicalBytes({
      logId: entry.logId,
      bodyDigest: entry.bodyDigest,
      integratedTime: entry.integratedTime,
      inclusionProof: entry.inclusionProof,
    }),
  );
  const bundle = {
    mediaType: 'application/vnd.openpacker.offline-sigstore-fixture.v1+json',
    messageSignature: {
      messageDigest: digest,
      signature: await leafSigner.sign(text.encode(`sha256:${digest.value}`)),
    },
    verificationMaterial: { certificate, tlogEntry: entry },
  };
  await verifyOfflineSigstoreBundle(
    bundle,
    bytes,
    {
      certificateAuthority: { keyId: 'root', publicKey: keys.root.x },
      transparencyLog: { logId: 'fixture-log', publicKey: keys.log.x },
    },
    { issuer: certificate.issuer, identity: certificate.identity },
    evaluationTime,
  );
  return bundle;
}

async function tufFixture(bytes, keys, evaluationTime) {
  const signer = await Ed25519Signer.fromJwk('root', keys.root);
  const signed = async (value) => ({
    signed: value,
    signatures: [
      { keyid: 'root', sig: await signer.sign(canonicalBytes(value)) },
    ],
  });
  const file = async (value, version) => {
    const encoded = text.encode(JSON.stringify(value));
    return {
      bytes: encoded,
      meta: {
        version,
        length: encoded.length,
        hashes: { sha256: (await sha256(encoded)).value },
      },
    };
  };
  const targetDigest = await sha256(bytes);
  const targets = await signed({
    _type: 'targets',
    spec_version: '1.0.31',
    version: 1,
    expires: '2027-01-01T00:00:00Z',
    targets: {
      'tools/openpacker-demo.tar.gz': {
        length: bytes.length,
        hashes: { sha256: targetDigest.value },
      },
    },
  });
  const targetsFile = await file(targets, 1);
  const snapshot = await signed({
    _type: 'snapshot',
    spec_version: '1.0.31',
    version: 1,
    expires: '2027-01-01T00:00:00Z',
    meta: { 'targets.json': targetsFile.meta },
  });
  const snapshotFile = await file(snapshot, 1);
  const timestamp = await signed({
    _type: 'timestamp',
    spec_version: '1.0.31',
    version: 1,
    expires: '2027-01-01T00:00:00Z',
    meta: { 'snapshot.json': snapshotFile.meta },
  });
  const key = {
    keytype: 'ed25519',
    scheme: 'ed25519',
    keyval: { public: keys.root.x },
  };
  const rootMetadata = await signed({
    _type: 'root',
    spec_version: '1.0.31',
    version: 1,
    expires: '2028-01-01T00:00:00Z',
    consistent_snapshot: true,
    keys: { root: key },
    roles: Object.fromEntries(
      ['root', 'timestamp', 'snapshot', 'targets'].map((role) => [
        role,
        { keyids: ['root'], threshold: 1 },
      ]),
    ),
  });
  const files = {
    timestamp: text.encode(JSON.stringify(timestamp)),
    snapshot: snapshotFile.bytes,
    targets: targetsFile.bytes,
    targetsFileName: '1.targets.json',
    delegated: {},
    delegatedFileNames: {},
  };
  const verified = await verifyTufTarget(
    {
      root: rootMetadata,
      timestampVersion: 0,
      snapshotVersion: 0,
      metadataVersions: {},
    },
    files,
    'tools/openpacker-demo.tar.gz',
    bytes,
    evaluationTime,
  );
  return {
    root: rootMetadata,
    timestamp,
    snapshot,
    targets,
    verified: { role: verified.role, target: verified.target },
  };
}

async function emit(store, type, subject, data, time, occurrenceId) {
  const event = await createCloudEvent({
    type,
    source: 'urn:openpacker:demo',
    subject,
    data,
    correlationId: 'openpacker-demo',
    clock: { now: () => time },
    occurrenceId,
  });
  await verifyCloudEvent(event, canonicalBytes(event));
  store.appendEvent(event);
  return event;
}

export async function runOpenPackerDemo({ output, evaluationTime, offline }) {
  if (!offline)
    throw new Error('the mandatory OpenPacker demo must run with --offline');
  // Process entry: register adapters (demo never hardcodes ecosystem codecs).
  const { configureDefaultAdapters } = await import(
    '@openpacker/adapters-default'
  );
  const { tryGetAdapterRegistry } = await import('@openpacker/adapter-host');
  if (!tryGetAdapterRegistry()) configureDefaultAdapters();
  await mkdir(output, { recursive: true });
  const fixture = await fixtureUniverse(output);
  const keys = json('fixtures/trust/keys.json');
  const signer = await Ed25519Signer.fromJwk('root', keys.root);
  const verifier = await Ed25519Verifier.fromJwk('root', keys.root);
  const embedded = createEmbeddedResolver(wasmBindings);
  const store = new SqliteStateStore(':memory:');
  const layout = new OciImageLayout(join(output, 'oci-layout'));
  let serviceEvidence;
  const unavailable = async () => {
    throw new OperationError(
      'UPSTREAM_UNAVAILABLE',
      'publishing is disabled in the offline demo',
    );
  };
  const operations = createReferenceOperations({
    universe: fixture.universe,
    resolver: embedded,
    meta,
    resolverBuildDigest: await canonicalDigest({
      crate: 'openpacker-resolver',
      version: '0.1.0',
    }),
    artifactSource: fixture.cas,
    receiptSigners: [signer],
    receiptVerifiers: new Map([[verifier.keyId, verifier]]),
    verificationChecks: new Map(
      [
        'tuf-metadata',
        'sigstore-bundle',
        'slsa-subject',
        'cyclonedx-sbom',
        'oci-descriptors',
        'ocm-integrity',
        'lifecycle-eligibility',
        'policy',
      ].map((check) => [
        check,
        async () => {
          if (!serviceEvidence) return { status: 'not-provided' };
          await serviceEvidence.verify(check);
          return { status: 'valid' };
        },
      ]),
    ),
    extensions: {
      lifecycleApply: async (input) => ({ applied: input }),
      pack: async ({ exactPurl, artifact, reference }) => {
        const bytes = fixture.upstream.get(artifact.descriptorId)?.bytes;
        if (!bytes)
          throw new OperationError(
            'ARTIFACT_NOT_FOUND',
            `No fixture bytes for ${artifact.descriptorId}`,
          );
        assert.equal(bytes.byteLength, artifact.size);
        assert.equal(
          formatDigest(await sha256(bytes)),
          formatDigest(artifact.digest),
        );
        return layout.packNative({
          bytes,
          exactPurl,
          nativeMediaType: artifact.mediaType,
          artifactType: artifact.artifactType,
          fileName: artifact.fileName ?? 'package.native',
          reference,
        });
      },
      publish: unavailable,
    },
  });
  const daemon = await startOpenPackerDaemon({
    operations: {
      ...operations,
      materialize: async (...input) =>
        realLocations(await operations.materialize(...input), output),
    },
    store,
    port: 0,
    clock: { now: () => evaluationTime },
  });
  const client = createOpenPackerClient({
    baseUrl: daemon.address,
    headers: { 'x-openpacker-offline': 'true' },
  });
  try {
    const discovery = (await client.discovery()).data;
    assert.ok(discovery.conformanceLevels.length >= 10);
    const normalized = (
      await client.normalize({
        items: [
          {
            type: 'native-coordinate',
            ecosystem: 'npm',
            value: '@OpenPacker/Demo-Tool@1.0.0',
          },
          { type: 'native-range', ecosystem: 'npm', value: '^1.0.0' },
          { type: 'native-range', ecosystem: 'cargo', value: '^1.0' },
          { type: 'native-range', ecosystem: 'nuget', value: '[1.0,2.0)' },
        ],
      })
    ).data;
    assert.equal(normalized.results.length, 4);
    const identified = (
      await client.identify({
        query: { purl: 'pkg:npm/%40openpacker/demo-tool' },
      })
    ).data;
    assert.equal(identified.status, 'identified');
    const enumerated = (
      await client.enumerate({
        canonicalPurl: 'pkg:npm/%40openpacker/demo-tool',
        target: {},
        lifecyclePolicy: { includeYanked: false, includeDelisted: false },
        page: { size: 20 },
      })
    ).data;
    assert.equal(enumerated.versions.length, 3);
    assert.equal(
      (
        await client.inspect({
          exact: { exactPurl: 'pkg:cargo/openpacker-zstd-wasm@1.0.0' },
        })
      ).data.package.identity.purlType,
      'cargo',
    );
    for (const snapshot of fixture.snapshots)
      await client.catalogImport(snapshot);

    const request = solveRequest(evaluationTime);
    const goldenUniverse = structuredClone(fixture.universe);
    for (const { artifacts } of goldenUniverse.packages)
      for (const { locations } of artifacts)
        for (const location of locations)
          if (location.uri.startsWith(pathToFileURL(output).href))
            location.uri = location.uri.replace(
              pathToFileURL(output).href,
              PORTABLE_OUTPUT,
            );
    await refreshUniverseDigest(goldenUniverse);
    const sdkSolved = (await client.solve(request)).data;
    assert.equal(
      embedded.check(
        { request, universe: fixture.universe },
        embedded.solve({ request, universe: fixture.universe }),
      ).valid,
      true,
    );
    assert.deepEqual(
      embedded.bruteForceOracle({ request, universe: fixture.universe })
        .selectedNodeIds,
      sdkSolved.solution.selectedNodeIds,
    );
    const initial = sdkSolved.selected.find(
      (item) =>
        item.identity.canonicalPurl === 'pkg:npm/%40openpacker/demo-tool',
    );
    assert.equal(initial?.normalizedVersion, '1.0.0');
    const selectedPurls = new Set(
      sdkSolved.selected.map((item) => item.identity.exactPurl),
    );
    for (const exactPurl of [
      'pkg:npm/%40openpacker/demo-tool@1.0.0',
      'pkg:npm/openpacker-native-helper@1.0.0',
      'pkg:cargo/openpacker-zstd-wasm@1.0.0',
      'pkg:cargo/openpacker-native-helper@1.0.0',
      'pkg:nuget/openpacker.zstd.tool@1.0.0',
      'pkg:nuget/openpacker.native.helper@1.0.0',
    ])
      assert.ok(
        selectedPurls.has(exactPurl),
        `required demo edge did not select ${exactPurl}`,
      );
    assert.ok(!selectedPurls.has('pkg:npm/optional-demo@1.0.0'));
    assert.ok(!selectedPurls.has('pkg:npm/conflicting-demo@1.0.0'));
    const apiArtifact = initial.artifacts.find(
      ({ nativeRole }) => nativeRole === 'native-package',
    );
    assert.ok(apiArtifact);
    const apiPacked = (
      await client.pack({
        exactPurl: initial.identity.exactPurl,
        artifact: apiArtifact,
        reference: initial.identity.exactPurl,
      })
    ).data;
    assert.equal(apiPacked.nativeBlob.digest, formatDigest(apiArtifact.digest));
    const unsatisfiableRequest = structuredClone(request);
    unsatisfiableRequest.requirements.push({
      id: 'root-conflict',
      expression: {
        type: 'package',
        purl: 'pkg:npm/conflicting-demo',
        vers: 'vers:npm/>=1.0.0',
      },
      kind: 'runtime',
      optional: false,
      source,
      authority: 'test-fixture',
      semanticLoss: [],
    });
    let unsatisfiableError;
    try {
      embedded.solve({
        request: unsatisfiableRequest,
        universe: fixture.universe,
      });
    } catch (error) {
      unsatisfiableError = error;
    }
    assert.notEqual(unsatisfiableError, undefined);
    const unsatisfiable = {
      request: unsatisfiableRequest,
      problem: {
        code: 'UNSATISFIABLE',
        message:
          unsatisfiableError instanceof Error
            ? unsatisfiableError.message
            : String(unsatisfiableError),
      },
    };
    assert.ok(sdkSolved.signedReceipt);
    await verifySignedReceipt(
      sdkSolved.signedReceipt,
      new Map([[verifier.keyId, verifier]]),
    );
    assert.equal(
      (
        await client.verify({
          subject: sdkSolved.signedReceipt,
          checks: ['receipt-signature'],
          evaluationTime,
        })
      ).data.decision,
      'allow',
    );
    const explained = (
      await client.explain({
        solutionDigest: sdkSolved.solution.solutionDigest,
        format: 'both',
      })
    ).data;
    assert.ok(explained.text && explained.graph);

    const directResponse = await fetch(`${daemon.address}/v1/solve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openpacker-offline': 'true',
      },
      body: canonicalBytes(request),
    });
    assert.equal(directResponse.status, 200);
    const directHttp = await directResponse.json();
    const cjsClient = require('@openpacker/sdk').createOpenPackerClient({
      baseUrl: daemon.address,
      headers: { 'x-openpacker-offline': 'true' },
    });
    const cjsSolved = (await cjsClient.solve(request)).data;
    const directOperations = await operations.solve(request, {
      signal: new AbortController().signal,
      correlationId: 'direct',
      offline: true,
      store,
    });
    const embeddedSolved = embedded.solve({
      request,
      universe: fixture.universe,
    });
    const receiptDigest = await canonicalDigest(sdkSolved.unsignedReceipt);
    const browser = await browserSolve(
      { request, universe: fixture.universe },
      sdkSolved.unsignedReceipt,
    );
    const nativeResolver = await loadNativeEmbeddedResolver();
    const nativeInput = { request, universe: fixture.universe };
    const nativeSolved = nativeResolver.solve(nativeInput);
    const native = {
      solved: nativeSolved,
      check: nativeResolver.check(nativeInput, nativeSolved),
      oracle: nativeResolver.bruteForceOracle(nativeInput),
      canonicalDigests: {
        unsignedReceipt: nativeResolver.digest(sdkSolved.unsignedReceipt),
      },
    };
    assert.equal(
      browser.solved.solution.solutionDigest.value,
      sdkSolved.solution.solutionDigest.value,
    );
    assert.equal(native.check.valid, true);
    assert.deepEqual(
      native.oracle.selectedNodeIds,
      embedded.bruteForceOracle({ request, universe: fixture.universe })
        .selectedNodeIds,
    );
    for (const digest of Object.values(native.canonicalDigests))
      assert.match(formatDigest(digest), /^sha256:[0-9a-f]{64}$/u);
    const modes = {
      'daemon-http': modeDigest(
        directHttp,
        await canonicalDigest(directHttp.unsignedReceipt),
      ),
      'sdk-esm': modeDigest(sdkSolved, receiptDigest),
      'sdk-cjs': modeDigest(
        cjsSolved,
        await canonicalDigest(cjsSolved.unsignedReceipt),
      ),
      'direct-operations': modeDigest(
        directOperations,
        await canonicalDigest(directOperations.unsignedReceipt),
      ),
      'embedded-native-rust': modeDigest(
        native.solved,
        native.canonicalDigests.unsignedReceipt,
      ),
      'embedded-wasm-node': modeDigest(
        embeddedSolved,
        embedded.digest(sdkSolved.unsignedReceipt),
      ),
      'embedded-wasm-browser': modeDigest(
        browser.solved,
        browser.receiptDigest,
      ),
    };
    for (const field of ['request', 'universe', 'solution', 'unsignedReceipt'])
      assert.equal(
        new Set(Object.values(modes).map((mode) => mode[field])).size,
        1,
        `${field} differs across modes`,
      );

    const materialized = (
      await client.materialize({
        subject: { type: 'purl', exactPurl: initial.identity.exactPurl },
      })
    ).data;
    assert.equal(
      formatDigest(materialized.descriptor.digest),
      formatDigest(fixture.tool.digest),
    );
    assert.equal(
      (
        await client.verify({
          subject: materialized.descriptor,
          checks: ['artifact-digest'],
          evaluationTime,
        })
      ).data.decision,
      'allow',
    );
    const prefix = join(output, 'prefix');
    const materialization = await materialize({
      source: fixture.cas,
      descriptor: fixture.tool,
      destination: prefix,
      format: 'tar+gzip',
    });
    assert.equal(materialization.lifecycleScriptsExecuted, false);
    const executed = spawnSync(join(prefix, 'bin/openpacker-demo'), [], {
      encoding: 'utf8',
    });
    assert.equal(executed.status, 0);
    assert.equal(executed.stdout, 'openpacker-demo-ok\n');

    const miseCommand = process.env.OPENPACKER_MISE ?? 'mise';
    const miseRoot = join(output, 'mise');
    for (const directory of ['bin', 'cache', 'config', 'data', 'state'])
      await mkdir(join(miseRoot, directory), { recursive: true });
    // The plugin runs OPENPACKER_BIN as a program. The built CLI is a .js file
    // that `tsc` writes without the executable bit (npm sets it only on an
    // installed bin), so on a fresh checkout the shell refused it (exit 126).
    // A launcher of the demo's own runs it with this Node.
    const openpackerBin = join(miseRoot, 'bin', 'openpacker');
    const quoted = (text) => `'${text.replaceAll("'", `'\\''`)}'`;
    await writeFile(
      openpackerBin,
      `#!/bin/sh\nexec ${quoted(process.execPath)} ${quoted(join(root, 'apps/openpacker-cli/dist/main.js'))} "$@"\n`,
      { mode: 0o755 },
    );
    const miseEnv = {
      ...process.env,
      MISE_DATA_DIR: join(miseRoot, 'data'),
      MISE_CACHE_DIR: join(miseRoot, 'cache'),
      MISE_CONFIG_DIR: join(miseRoot, 'config'),
      MISE_STATE_DIR: join(miseRoot, 'state'),
      OPENPACKER_BIN: openpackerBin,
      OPENPACKER_URL: daemon.address,
      OPENPACKER_OFFLINE: 'true',
      OPENPACKER_TOOL_DEMO_PURL: 'pkg:npm/%40openpacker/demo-tool',
    };
    const runMise = (args) =>
      new Promise((resolve, reject) => {
        const invocation = spawn(miseCommand, args, {
          cwd: root,
          env: miseEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        invocation.stdout.setEncoding('utf8').on('data', (chunk) => {
          stdout += chunk;
        });
        invocation.stderr.setEncoding('utf8').on('data', (chunk) => {
          stderr += chunk;
        });
        invocation.once('error', reject);
        invocation.once('close', (status) =>
          status === 0
            ? resolve(stdout)
            : reject(
                new Error(`mise ${args.join(' ')} failed: ${stderr || stdout}`),
              ),
        );
      });
    const miseVersion = await runMise(['--version']);
    assert.match(miseVersion, /2026\.7\.13/u);
    await runMise([
      'plugins',
      'link',
      'openpacker',
      join(root, 'integrations/mise'),
      '--force',
    ]);
    const miseVersions = await runMise(['ls-remote', 'openpacker:demo']);
    assert.match(miseVersions, /(?:^|\s)1\.0\.0(?:\s|$)/u);
    await runMise(['install', '-f', 'openpacker:demo@1.0.0']);
    const misePrefix = (
      await runMise(['where', 'openpacker:demo@1.0.0'])
    ).trim();
    const miseManifest = JSON.parse(
      await readFile(join(misePrefix, '.openpacker-mise.json'), 'utf8'),
    );
    assert.equal(
      miseManifest.descriptorDigest,
      formatDigest(fixture.tool.digest),
    );
    assert.deepEqual(miseManifest.executables, ['bin/openpacker-demo']);
    assert.equal(miseManifest.lifecycleScriptsExecuted, false);
    const miseExecuted = await runMise([
      'exec',
      'openpacker:demo@1.0.0',
      '--',
      'openpacker-demo',
    ]);
    assert.equal(miseExecuted, 'openpacker-demo-ok\n');

    const packed = [];
    for (const selected of sdkSolved.selected) {
      const native = selected.artifacts.find(
        ({ nativeRole }) => nativeRole === 'native-package',
      );
      if (!native) continue;
      const bytes = fixture.upstream.get(native.descriptorId)?.bytes;
      assert.ok(bytes);
      assert.equal(
        formatDigest(await sha256(bytes)),
        formatDigest(native.digest),
      );
      packed.push(
        await layout.packNative({
          bytes,
          exactPurl: selected.identity.exactPurl,
          nativeMediaType: native.mediaType,
          artifactType: native.artifactType,
          fileName: native.fileName,
          reference: selected.identity.exactPurl,
        }),
      );
    }
    assert.ok(packed.length >= 2);
    const subject = packed[0];
    const chunk = await createChunkIndex(
      streamFromBytes(
        fixture.upstream.get(subject.artifact.descriptorId).bytes,
      ),
      subject.artifact,
    );
    validateChunkIndex(chunk);
    const sbomRefs = new Map(
      sdkSolved.selected.map((item) => [
        item.nodeId,
        item.identity.exactPurl ?? `urn:openpacker:component:${item.nodeId}`,
      ]),
    );
    const sbom = {
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      version: 1,
      components: sdkSolved.selected.map((item) => ({
        type: 'library',
        name: item.identity.name,
        version: item.normalizedVersion,
        purl: item.identity.exactPurl,
        licenses: [{ expression: 'MIT' }],
        hashes: item.artifacts.map((artifact) => ({
          alg: 'SHA-256',
          content: artifact.digest.value,
        })),
      })),
      dependencies: sdkSolved.selected.map((item) => ({
        ref: sbomRefs.get(item.nodeId),
        dependsOn: sdkSolved.solution.dependencyEdges
          .filter((edge) => edge.fromNodeId === item.nodeId)
          .map((edge) => sbomRefs.get(edge.toNodeId))
          .filter(Boolean)
          .sort(),
      })),
    };
    const slsa = {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [
        {
          name: subject.artifact.fileName,
          digest: { sha256: subject.artifact.digest.value },
        },
      ],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: {
        buildDefinition: {
          buildType: 'https://openpacker.dev/fixtures/build',
          externalParameters: {},
          internalParameters: {},
          resolvedDependencies: [],
        },
        runDetails: {
          builder: { id: 'https://openpacker.dev/fixtures/builder' },
        },
      },
    };
    verifySlsaProvenance(slsa, subject.artifact.digest);
    const cycloneEvidence = extractCycloneDxEvidence(sbom);
    assert.equal(cycloneDxEvidenceStatus(sbom), 'valid');
    assert.ok(cycloneEvidence.purls.length > 0);
    assert.ok(cycloneEvidence.hashes.length > 0);
    const sigstore = await sigstoreFixture(
      fixture.upstream.get(subject.artifact.descriptorId).bytes,
      keys,
      evaluationTime,
    );
    const tuf = await tufFixture(fixture.toolBytes, keys, evaluationTime);
    const overlay = fixture.universe.overlays[0];
    for (const [value, artifactType, mediaType] of [
      [
        sdkSolved.signedReceipt,
        'application/vnd.openpacker.prex.receipt.v1+json',
        'application/json',
      ],
      [
        overlay,
        'application/vnd.openpacker.overlay.v1+json',
        'application/json',
      ],
      [
        chunk,
        'application/vnd.openpacker.chunk-index.v1+json',
        'application/json',
      ],
      [sbom, 'application/vnd.cyclonedx+json', 'application/json'],
      [slsa, 'application/vnd.in-toto+json', 'application/json'],
      [
        sigstore,
        'application/vnd.openpacker.offline-sigstore-fixture.v1+json',
        'application/json',
      ],
    ])
      await layout.attachReferrer(
        subject.manifest,
        canonicalBytes(JSON.parse(JSON.stringify(value))),
        artifactType,
        mediaType,
      );
    assert.equal((await layout.listReferrers(subject.manifest)).length, 6);

    const ocm = await mapSolutionToOcm({
      packages: sdkSolved.selected,
      solution: sdkSolved.solution,
      provider: 'org.openpacker.reference',
      receiptDigest: sdkSolved.signedReceipt.receiptDigest,
    });
    for (const descriptor of ocm) validateOcmDescriptor(descriptor);
    const policy = await evaluatePolicy(
      {
        allowYanked: false,
        allowQuarantined: false,
        requiredEvidence: ['receipt', 'sigstore', 'slsa', 'sbom'],
        semanticLossMaximum: 'warning',
        acceptedIdentities: ['release@example.test'],
        acceptedIssuers: ['https://issuer.example'],
        deniedLicenses: ['GPL-3.0'],
        allowedTargets: [{ os: 'linux', architecture: 'arm64' }],
        maximumArtifactSize: 1024 * 1024,
        requireExactSourceSnapshot: true,
      },
      {
        evidence: ['receipt', 'sigstore', 'slsa', 'sbom'].map((type) => ({
          type,
          status: 'valid',
        })),
        lifecycle: initial.lifecycle,
        signerIdentity: 'release@example.test',
        sigstoreIssuer: 'https://issuer.example',
        licenses: cycloneEvidence.licenses,
        target: request.target,
        artifactSize: subject.artifact.size,
        exactSourceSnapshot: true,
      },
    );
    assert.equal(policy.decision, 'allow');
    serviceEvidence = {
      verify: async (check) => {
        if (check === 'tuf-metadata')
          await tufFixture(
            fixture.upstream.get(subject.artifact.descriptorId).bytes,
            keys,
            evaluationTime,
          );
        else if (check === 'sigstore-bundle')
          await verifyOfflineSigstoreBundle(
            sigstore,
            fixture.upstream.get(subject.artifact.descriptorId).bytes,
            {
              certificateAuthority: {
                keyId: 'root',
                publicKey: keys.root.x,
              },
              transparencyLog: {
                logId: 'fixture-log',
                publicKey: keys.log.x,
              },
            },
            {
              issuer: 'https://issuer.example',
              identity: 'release@example.test',
            },
            evaluationTime,
          );
        else if (check === 'slsa-subject')
          verifySlsaProvenance(slsa, subject.artifact.digest);
        else if (check === 'cyclonedx-sbom') extractCycloneDxEvidence(sbom);
        else if (check === 'oci-descriptors')
          await layout.readManifest(subject.manifest);
        else if (check === 'ocm-integrity')
          for (const descriptor of ocm) validateOcmDescriptor(descriptor);
        else if (check === 'lifecycle-eligibility')
          assert.equal(initial.lifecycle.eligible, true);
        else if (check === 'policy') assert.equal(policy.decision, 'allow');
        else
          throw new Error(`Unsupported service verification check: ${check}`);
      },
    };
    assert.equal(
      (
        await client.verify({
          subject: subject.artifact,
          checks: [
            'artifact-digest',
            'tuf-metadata',
            'sigstore-bundle',
            'slsa-subject',
            'cyclonedx-sbom',
            'oci-descriptors',
            'ocm-integrity',
            'lifecycle-eligibility',
            'policy',
          ],
          evaluationTime,
        })
      ).data.decision,
      'allow',
    );

    const yank = json('fixtures/protocol/lifecycle/yank.json');
    const reduction = await reduceLifecycle(
      [yank],
      {
        packagePurl: initial.identity.canonicalPurl,
        exactPurl: initial.identity.exactPurl,
      },
      '2026-08-02T02:00:00Z',
      [
        {
          authority: 'publisher',
          scopes: ['exact-version'],
          actions: ['yanked'],
        },
      ],
      new Map([[yank.eventId, 'publisher']]),
    );
    const universeInitial = fixture.universe.packages.find(
      ({ nodeId }) => nodeId === initial.nodeId,
    );
    assert.ok(universeInitial);
    universeInitial.lifecycle = reduction.state;
    fixture.universe.lifecycleRoot = reduction.root;
    await refreshUniverseDigest(fixture.universe);
    await client.lifecycleApply(yank);
    await assert.rejects(
      () =>
        client.materialize({
          subject: { type: 'purl', exactPurl: initial.identity.exactPurl },
        }),
      /yanked/i,
    );
    const forensic = (
      await client.materialize({
        subject: { type: 'purl', exactPurl: initial.identity.exactPurl },
        forensic: true,
        policy: {
          ...request.policy,
          allowYanked: true,
          permitForensicDigestMaterialization: true,
        },
      })
    ).data;
    assert.equal(
      formatDigest(forensic.descriptor.digest),
      formatDigest(fixture.tool.digest),
    );
    const reselected = (
      await client.solve(solveRequest('2026-08-02T02:00:00Z'))
    ).data;
    assert.equal(
      reselected.selected.find(
        (item) =>
          item.identity.canonicalPurl === initial.identity.canonicalPurl,
      )?.normalizedVersion,
      '0.9.0',
    );

    const events = [];
    events.push(
      await emit(
        store,
        'org.openpacker.catalog.snapshot.created',
        fixture.snapshot.snapshotId,
        { schemaVersion: '1', snapshot: fixture.snapshot },
        evaluationTime,
      ),
    );
    events.push(
      await emit(
        store,
        'org.openpacker.lifecycle.changed',
        initial.identity.exactPurl,
        { schemaVersion: '1', lifecycleEvent: yank },
        '2026-08-02T02:00:00Z',
        yank.eventId,
      ),
    );
    events.push(
      await emit(
        store,
        'org.openpacker.resolution.completed',
        formatDigest(sdkSolved.solution.solutionDigest),
        {
          schemaVersion: '1',
          solutionDigest: sdkSolved.solution.solutionDigest,
          requestDigest: sdkSolved.requestDigest,
          universeDigest: sdkSolved.universeDigest,
        },
        evaluationTime,
      ),
    );
    events.push(
      await emit(
        store,
        'org.openpacker.receipt.created',
        formatDigest(sdkSolved.signedReceipt.receiptDigest),
        {
          schemaVersion: '1',
          receiptDigest: sdkSolved.signedReceipt.receiptDigest,
        },
        evaluationTime,
      ),
    );
    events.push(
      await emit(
        store,
        'org.openpacker.artifact.packed',
        subject.manifest.digest,
        { schemaVersion: '1', descriptor: subject.artifact },
        evaluationTime,
      ),
    );
    events.push(
      await emit(
        store,
        'org.openpacker.artifact.verified',
        formatDigest(subject.artifact.digest),
        { schemaVersion: '1', descriptor: subject.artifact },
        evaluationTime,
      ),
    );
    writeFileSync(
      join(output, 'events.ndjson'),
      `${events.map((event) => new TextDecoder().decode(canonicalBytes(event))).join('\n')}\n`,
    );

    const epochModule = await import(
      pathToFileURL(join(root, 'examples/epoch-consumer/dist/src/index.js'))
    );
    const port = new epochModule.InMemoryEpochConsumerPort();
    const epochEnvelope = await epochModule.consumeResolution({
      client,
      request,
      port,
      receiptVerifiers: new Map([[verifier.keyId, verifier]]),
    });
    for await (const event of client.events(0))
      await new epochModule.EpochEventConsumer(port).consume(event);
    assert.equal(port.receipts.size, 1);
    assert.ok(port.receipts.has(epochEnvelope.openPackerDigest));
    const pactModule = await import(
      pathToFileURL(
        join(root, 'examples/epoch-consumer/dist/src/pact-provider.js'),
      )
    );
    const pactProviderModule = await import(
      pathToFileURL(
        join(root, 'examples/epoch-consumer/dist/src/provider-fixture.js'),
      )
    );
    const pactProvider = await pactProviderModule.startEpochPactProvider(root);
    try {
      await pactModule.verifyEpochPact({
        providerBaseUrl: pactProvider.address,
      });
    } finally {
      await pactProvider.close();
    }

    const lock = {
      schemaVersion: '1',
      protocolVersion: '1.0-draft',
      rootRequirements: request.requirements,
      target: request.target,
      semanticsProfile: request.semantics.profile,
      objectiveOrdering: request.objectives,
      selectedExactPurls: sdkSolved.selected
        .map((item) => item.identity.exactPurl)
        .sort(),
      dependencyEdges: sdkSolved.solution.dependencyEdges,
      artifactDescriptors: sdkSolved.selected.flatMap((item) => item.artifacts),
      ocmReferences: [],
      sourceSnapshotDigests: sdkSolved.solution.sourceSnapshotDigests,
      lifecycleRoot: sdkSolved.unsignedReceipt.lifecycleRoot,
      policyDigest: sdkSolved.unsignedReceipt.policyDigest,
      solutionDigest: sdkSolved.solution.solutionDigest,
      receiptDigest: sdkSolved.signedReceipt.receiptDigest,
      externalRefs: [],
    };
    writeJson(join(output, 'openpacker.lock.json'), lock);
    writeJson(join(output, 'explanation.json'), explained.graph);
    writeJson(join(output, 'receipt.json'), sdkSolved.signedReceipt);
    writeJson(join(output, 'ocm-graph.json'), ocm);
    writeJson(join(output, 'solution.cdx.json'), sbom);
    writeJson(join(output, 'trust-evidence.json'), {
      tuf,
      sigstore,
      slsa,
      policy,
    });
    for (let index = 0; index < ocm.length; index += 1)
      writeFileSync(
        join(output, `ocm-${index + 1}.json`),
        ocmDescriptorBytes(ocm[index]),
      );

    const goldenSources = {
      normalize: normalized,
      identity: identified,
      enumeration: enumerated,
      snapshot: fixture.snapshot,
      universe: goldenUniverse,
      solution: sdkSolved.solution,
      proof: sdkSolved.proof,
      explanation: explained,
      unsatisfiable,
      receipt: sdkSolved.signedReceipt,
      lockfile: lock,
      lifecycle: { event: yank, reduction },
      event: events,
      oci: JSON.parse(
        await readFile(join(output, 'oci-layout/index.json'), 'utf8'),
      ),
      ocm,
      tuf,
      sigstore,
      slsa,
      cyclonedx: sbom,
    };
    const goldenSourceDirectory = join(output, 'golden-source');
    await mkdir(goldenSourceDirectory, { recursive: true });
    for (const [kind, value] of Object.entries(goldenSources))
      writeJson(join(goldenSourceDirectory, `${kind}.json`), value);

    const result = {
      success: true,
      offline: true,
      evaluationTime,
      modeDigests: modes,
      proof: {
        valid: true,
        oracleSelectedNodeIds: embedded.bruteForceOracle({
          request,
          universe: fixture.universe,
        }).selectedNodeIds,
      },
      lifecycle: {
        yanked: initial.identity.exactPurl,
        replacement: reselected.selected.find(
          (item) =>
            item.identity.canonicalPurl === initial.identity.canonicalPurl,
        ).identity.exactPurl,
        forensicDigest: formatDigest(forensic.descriptor.digest),
      },
      interoperability: {
        ociReferrers: 6,
        ocmComponents: ocm.length,
        epochReceipts: port.receipts.size,
        epochEvents: port.events.size,
        pact: 'verified',
        mise: {
          version: miseVersion.trim(),
          versions: miseVersions.trim().split(/\s+/u),
          prefix: relative(output, misePrefix).replaceAll('\\', '/'),
        },
      },
      verification: {
        receipt: 'valid',
        artifact: 'valid',
        tuf: 'valid',
        sigstore: 'valid',
        slsa: 'valid',
        sbom: 'valid',
        policy: policy.decision,
        materializedCommand: executed.stdout.trim(),
        miseCommand: miseExecuted.trim(),
        miseLifecycleScriptsExecuted: miseManifest.lifecycleScriptsExecuted,
      },
    };
    writeJson(join(output, 'demo-result.json'), result);
    return result;
  } finally {
    await daemon.close();
  }
}

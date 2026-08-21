import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterRegistry, type AdapterModule } from '@openpacker/adapter-host';
import type {
  DelegatedAdapterManifest,
  DelegatedAdapterOperation,
  JsonValue,
} from '@openpacker/contracts';
import {
  stableStoreTreeDigest,
  writeStableFile,
} from '@openpacker/opm-project';
import {
  createMockBackend,
  createNativeBackend,
  findTrustedSandboxHelper,
  runInSandbox,
  SandboxBackendError,
  type RunInSandboxInput,
  type SandboxOutcome,
} from '@openpacker/sandbox';
import type { DelegatedExecutableIdentity } from '@openpacker/pack-provider';
import {
  delegatedAdapterModule,
  registerInstalledPlugins,
  registerPlugin,
  validateOperationResult,
  verifyPluginBindings,
  type DelegatedPluginExecutor,
} from '../src/index.js';
import { listPlugins } from '@openpacker/plugin-store';
import { parseCanonicalJson } from '@openpacker/canonical';

/**
 * Plugin host behaviour against a hand-built store: pins and entries are
 * written exactly like `opm plugin add` leaves them (validated index,
 * tree-digest-pinned entry), so loading here exercises the real pin
 * verification — and nothing touches a registry or the network.
 */

const NOW = '2026-01-01T00:00:00.000Z';
const DIGEST = 'a'.repeat(64);

const DEFINITION = {
  registryDefinitionVersion: '1',
  registryId: 'urn:openpacker:registry:acme-fixture',
  displayName: 'Acme fixture registry',
  purlTypes: ['acme'],
  resources: [
    { '@id': '#metadata', '@type': 'prex.registry.package-metadata/1' },
    { '@id': '#enumerate', '@type': 'prex.registry.enumerate-versions/1' },
  ],
};

const IDENTITY = {
  canonicalPurl: 'pkg:acme/demo',
  purlType: 'acme',
  name: 'demo',
  qualifiers: {},
  nativeCoordinates: [],
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  aliases: [] as string[],
  sourceRefs: [],
  publisherRefs: [],
  externalRefs: [],
};

const WIRE_RECORD = {
  key: 'pkg:acme/demo@1.0.0',
  endpoint: 'https://plugins.fixture.test',
  body: { artifact: true },
  retrievedAt: '2026-01-01T00:00:00Z',
};

const PACKAGE_INSTANCE = {
  nodeId: `sha256:${DIGEST}`,
  identity: { ...IDENTITY, exactPurl: 'pkg:acme/demo@1.0.0' },
  nativeVersion: '1.0.0',
  normalizedVersion: '1.0.0',
  versionSortKey: '1.0.0',
  requirements: [],
  capabilities: [],
  conflicts: [],
  cardinalityConstraints: [],
  artifacts: [],
  lifecycle: { status: 'published', eligible: true, warnings: [] },
  sourceSnapshots: [],
  metadataDigest: { algorithm: 'sha256', value: DIGEST },
  nativeSemantics: { version: 'acme-1', data: {} },
  semanticLoss: [],
};

const SNAPSHOT = {
  snapshotId: 'snap-1',
  providerId: 'dev.example.acme-adapter',
  providerType: 'registry',
  endpointIdentity: 'https://plugins.fixture.test',
  retrievedAt: '2026-01-01T00:00:00Z',
  evaluationTime: '2026-01-02T00:00:00Z',
  rootDigest: { algorithm: 'sha256', value: DIGEST },
  recordsDigest: { algorithm: 'sha256', value: DIGEST },
  evidenceRefs: [],
};

function okResponse(result: JsonValue): string {
  return JSON.stringify({
    delegatedAdapterResponseVersion: '1',
    ok: true,
    result,
  });
}

/** Canned plugin answers keyed by the operation word in argv. */
function cannedAnswer(operation: string, query: string): string {
  switch (operation) {
    case 'registry-definition':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return okResponse(JSON.parse(JSON.stringify(DEFINITION)) as JsonValue);
    case 'identify':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return okResponse(
        JSON.parse(
          JSON.stringify([{ ...IDENTITY, aliases: [query] }]),
        ) as JsonValue,
      );
    case 'enumerate':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return okResponse(
        JSON.parse(JSON.stringify(['pkg:acme/demo@1.0.0'])) as JsonValue,
      );
    case 'inspect':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return okResponse(
        JSON.parse(
          JSON.stringify({
            package: PACKAGE_INSTANCE,
            record: WIRE_RECORD,
            warnings: [],
          }),
        ) as JsonValue,
      );
    case 'fetch-artifact-record':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return okResponse(JSON.parse(JSON.stringify(WIRE_RECORD)) as JsonValue);
    case 'snapshot':
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      return okResponse(JSON.parse(JSON.stringify(SNAPSHOT)) as JsonValue);
    default:
      return JSON.stringify({
        delegatedAdapterResponseVersion: '1',
        ok: false,
        error: {
          code: 'UNSUPPORTED',
          message: `unknown operation ${operation}`,
        },
      });
  }
}

/**
 * The fixture executable: a standalone POSIX sh script answering the bounded
 * stdio protocol. `identify` echoes the request's query and the two
 * environment names the manifest declares, so tests can observe what crossed
 * the sandbox boundary.
 */
function fixtureScript(): string {
  const staticAnswer = (operation: string) =>
    `'${cannedAnswer(operation, '')}'`;
  return `#!/bin/sh
op="$1"
request="$(cat)"
case "$op" in
  registry-definition) printf '%s' ${staticAnswer('registry-definition')} ;;
  enumerate) printf '%s' ${staticAnswer('enumerate')} ;;
  inspect) printf '%s' ${staticAnswer('inspect')} ;;
  fetch-artifact-record) printf '%s' ${staticAnswer('fetch-artifact-record')} ;;
  snapshot) printf '%s' ${staticAnswer('snapshot')} ;;
  identify)
    query=$(printf '%s' "$request" | sed -n 's/.*"query":"\\([^"]*\\)".*/\\1/p')
    case "$query" in
      malformed) printf 'this is not json{' ;;
      bad-shape) printf '%s' '{"delegatedAdapterResponseVersion":"1","ok":true,"result":{"not":"an array"}}' ;;
      plugin-error) printf '%s' '{"delegatedAdapterResponseVersion":"1","ok":false,"error":{"code":"NOT_FOUND","message":"no such package"}}' ;;
      *) printf '%s' "{\\"delegatedAdapterResponseVersion\\":\\"1\\",\\"ok\\":true,\\"result\\":[{\\"canonicalPurl\\":\\"pkg:acme/demo\\",\\"purlType\\":\\"acme\\",\\"name\\":\\"demo\\",\\"qualifiers\\":{},\\"nativeCoordinates\\":[],\\"aliases\\":[\\"$query\\",\\"\${ACME_TOKEN:-unset}\\",\\"\${ACME_ADAPTER_LOG:-unset}\\"],\\"sourceRefs\\":[],\\"publisherRefs\\":[],\\"externalRefs\\":[]}]}" ;;
    esac
    ;;
  *) exit 9 ;;
esac
`;
}

function fixtureManifest(
  overrides: Partial<DelegatedAdapterManifest> = {},
): DelegatedAdapterManifest {
  return {
    delegatedAdapterVersion: '1',
    id: 'dev.example.acme-adapter',
    purlTypes: ['acme'],
    capabilities: ['registry-definition', 'catalog'],
    executable: 'acme-adapter',
    commands: {
      'registry-definition': { arguments: ['registry-definition'] },
      identify: { arguments: ['identify'] },
      enumerate: { arguments: ['enumerate'] },
      inspect: { arguments: ['inspect'] },
      'fetch-artifact-record': { arguments: ['fetch-artifact-record'] },
      snapshot: { arguments: ['snapshot'] },
    },
    environment: { ACME_ADAPTER_LOG: 'warn' },
    authority: { network: 'never', environment: ['ACME_TOKEN'] },
    ...overrides,
  };
}

interface FixturePlugin {
  storeRoot: string;
  storePath: string;
  executablePath: string;
  /** sha256 hex of the installed script, as registration computes it. */
  executableDigest: string;
  manifest: DelegatedAdapterManifest;
}

async function installFixturePlugin(
  root: string,
  options: {
    name?: string;
    manifest?: DelegatedAdapterManifest;
    executable?: string;
  } = {},
): Promise<FixturePlugin> {
  const name = options.name ?? 'acme';
  const manifest = options.manifest ?? fixtureManifest();
  const script = options.executable ?? fixtureScript();
  const storeRoot = join(root, 'plugins');
  const storeDigest = `sha256:${createHash('sha256')
    .update(manifest.id)
    .update(script)
    .digest('hex')}`;
  const storePath = join(storeRoot, `sha256-${storeDigest.slice(7)}`);
  await writeStableFile(
    join(storePath, 'plugin.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeStableFile(join(storePath, manifest.executable), script, 0o755);
  const treeDigest = await stableStoreTreeDigest(storePath);
  await writeStableFile(
    join(storeRoot, 'plugins.json'),
    `${JSON.stringify(
      {
        pluginStoreVersion: 1,
        plugins: {
          [name]: {
            id: manifest.id,
            name,
            exactPurl: `pkg:opm-plugin/${name}@1.0.0`,
            storeDigest,
            treeDigest,
            manifestPath: 'plugin.json',
            installedAt: NOW,
            format: 'tar',
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return {
    storeRoot,
    storePath,
    executablePath: join(storePath, manifest.executable),
    executableDigest: createHash('sha256').update(script).digest('hex'),
    manifest,
  };
}

function sandboxOutcome(stdout: string): SandboxOutcome {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    backend: 'mock',
    profile: 'package-exec',
    enforced: true,
    containmentLimited: false,
    policyDigest: { algorithm: 'sha256', value: DIGEST },
    losses: [],
    degraded: false,
  };
}

function fakeIdentity(
  path: string,
  digest: string = DIGEST,
): DelegatedExecutableIdentity {
  return {
    path,
    digest: { algorithm: 'sha256', value: digest },
    device: 1n,
    inode: 2n,
    size: 3n,
    ctimeNanoseconds: 4n,
    mtimeNanoseconds: 5n,
  };
}

/**
 * Registration with the protocol short-circuited: the executable authority is
 * a stub (no fd) and the sandbox run answers from the canned table while
 * capturing every input. Runs on any platform.
 */
async function registerWithCannedAnswers(
  root: string,
  options: {
    manifest?: DelegatedAdapterManifest;
    registry?: AdapterRegistry;
    answer?: (
      operation: string,
      input: RunInSandboxInput,
      canned: SandboxOutcome,
    ) => SandboxOutcome;
    allowEnvironment?: readonly string[];
    hostFetchTokenEnvNames?: readonly string[];
    environment?: Readonly<Record<string, string | undefined>>;
    allowNetwork?: boolean;
    limits?: {
      timeoutMs?: number;
      responseBytes?: number;
      stderrBytes?: number;
    };
  } = {},
): Promise<{
  fixture: FixturePlugin;
  registry: AdapterRegistry;
  calls: RunInSandboxInput[];
  result: Awaited<ReturnType<typeof registerInstalledPlugins>>;
}> {
  const fixture = await installFixturePlugin(root, {
    ...(!(options.manifest === undefined) && { manifest: options.manifest }),
  });
  const registry = options.registry ?? new AdapterRegistry();
  const calls: RunInSandboxInput[] = [];
  const result = await registerInstalledPlugins({
    storeRoot: fixture.storeRoot,
    registry,
    // The stub authority must answer with the digest registration pinned.
    inspectExecutable: async (path) =>
      fakeIdentity(path, fixture.executableDigest),
    sandboxRun: async (input) => {
      calls.push(input);
      const operation = input.argv[1] ?? '';
      const query =
        input.stdin === undefined
          ? ''
          : // SAFETY: The surrounding boundary establishes the asserted domain contract.
            // SAFETY: The surrounding boundary establishes the asserted domain contract.
            ((
              parseCanonicalJson(Buffer.from(input.stdin).toString('utf8')) as {
                params?: { query?: string };
              }
            ).params?.query ?? '');
      return options.answer !== undefined
        ? options.answer(
            operation,
            input,
            sandboxOutcome(cannedAnswer(operation, query)),
          )
        : sandboxOutcome(cannedAnswer(operation, query));
    },
    ...(!(options.allowEnvironment === undefined) && {
      allowEnvironment: options.allowEnvironment,
    }),
    ...(!(options.hostFetchTokenEnvNames === undefined) && {
      hostFetchTokenEnvNames: options.hostFetchTokenEnvNames,
    }),
    ...(!(options.environment === undefined) && {
      environment: options.environment,
    }),
    ...(!(options.allowNetwork === undefined) && {
      allowNetwork: options.allowNetwork,
    }),
    ...(!(options.limits === undefined) && { limits: options.limits }),
  });
  return { fixture, registry, calls, result };
}

const roots: string[] = [];

afterEach(async () => {
  delete process.env.OPM_HOST_FETCH_TOKEN_ENVS;
  delete process.env.OPM_HOST_FETCH_HEADER_ENVS;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'opm-plugin-host-'));
  roots.push(root);
  return root;
}

describe('registerInstalledPlugins', () => {
  it('treats a never-created store as empty without creating it', async () => {
    const root = await fixtureRoot();
    const storeRoot = join(root, 'plugins');
    const registry = new AdapterRegistry();
    const result = await registerInstalledPlugins({ storeRoot, registry });
    expect(result).toEqual({ registered: [], refused: [] });
    await expect(stat(storeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('propagates store-level failures instead of guessing', async () => {
    const root = await fixtureRoot();
    const storeRoot = join(root, 'plugins');
    // A regular file where the store directory belongs is not a store.
    await writeFile(storeRoot, 'not a store');
    await expect(
      registerInstalledPlugins({
        storeRoot,
        registry: new AdapterRegistry(),
      }),
    ).rejects.toThrow();
  });

  it('registers every pinned plugin as an adapter module', async () => {
    const root = await fixtureRoot();
    const { registry, result } = await registerWithCannedAnswers(root);
    expect(result).toEqual({
      registered: ['dev.example.acme-adapter'],
      refused: [],
    });
    expect(registry.has('acme')).toBe(true);
    expect(registry.moduleFor('acme').id).toBe('dev.example.acme-adapter');
    // Capabilities that are not delegatable stay absent.
    const module = registry.moduleFor('acme');
    expect(module.codec).toBeUndefined();
    expect(module.installer).toBeUndefined();
    expect(module.project).toBeUndefined();
    expect(module.packer).toBeUndefined();
  });

  it('answers registry-definition and catalog operations over the protocol', async () => {
    const root = await fixtureRoot();
    const { registry, calls } = await registerWithCannedAnswers(root);

    const definition = await registry.definitionFor('acme');
    expect(definition).toEqual(DEFINITION);
    // The definition is cached per registration: one plugin invocation.
    await registry.definitionFor('acme');
    expect(
      calls.filter((call) => call.argv[1] === 'registry-definition'),
    ).toHaveLength(1);

    const catalog = await registry.catalogFor('acme');
    const identities = await catalog.identify('demo');
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      canonicalPurl: 'pkg:acme/demo',
      aliases: ['demo'],
    });
    // The canonical request travelled on stdin; argv carries literals only.
    const identifyCall = calls.find((call) => call.argv[1] === 'identify')!;
    expect(identifyCall.argv).toHaveLength(2);
    expect(
      parseCanonicalJson(Buffer.from(identifyCall.stdin!).toString('utf8')),
    ).toEqual({
      delegatedAdapterRequestVersion: '1',
      operation: 'identify',
      params: { query: 'demo', offline: false },
    });

    await expect(catalog.enumerate('pkg:acme/demo')).resolves.toEqual([
      'pkg:acme/demo@1.0.0',
    ]);
    const inspection = await catalog.inspect('pkg:acme/demo@1.0.0');
    expect(inspection.package.identity.exactPurl).toBe('pkg:acme/demo@1.0.0');
    expect(inspection.record.body).toEqual({ artifact: true });
    // rawBody is reconstructed as the canonical bytes of the answered body.
    expect(Buffer.from(inspection.record.rawBody).toString('utf8')).toBe(
      '{"artifact":true}',
    );
    const record = await catalog.fetchArtifactRecord('pkg:acme/demo@1.0.0');
    expect(record.key).toBe('pkg:acme/demo@1.0.0');
    const snapshot = await catalog.snapshot('2026-01-02T00:00:00Z');
    expect(snapshot.snapshotId).toBe('snap-1');
  });

  it('fails closed on a malformed response document', async () => {
    const root = await fixtureRoot();
    const { registry } = await registerWithCannedAnswers(root, {
      answer: (operation, _input, canned) =>
        operation === 'identify' ? sandboxOutcome('this is not json{') : canned,
    });
    const catalog = await registry.catalogFor('acme');
    await expect(catalog.identify('demo')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('fails closed on a schema-invalid result payload', async () => {
    const root = await fixtureRoot();
    const { registry } = await registerWithCannedAnswers(root, {
      answer: (operation, _input, canned) =>
        operation === 'identify'
          ? sandboxOutcome(
              // SAFETY: The surrounding boundary establishes the asserted domain contract.
              okResponse(
                JSON.parse(JSON.stringify({ not: 'an array' })) as JsonValue,
              ),
            )
          : canned,
    });
    const catalog = await registry.catalogFor('acme');
    await expect(catalog.identify('demo')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    // And for the definition: a well-formed document of the wrong schema.
    const second = await fixtureRoot();
    const wrong = await registerWithCannedAnswers(second, {
      answer: (operation, _input, canned) =>
        operation === 'registry-definition'
          ? sandboxOutcome(
              // SAFETY: The surrounding boundary establishes the asserted domain contract.
              okResponse(
                JSON.parse(
                  JSON.stringify({ purlTypes: ['acme'] }),
                ) as JsonValue,
              ),
            )
          : canned,
    });
    await expect(wrong.registry.definitionFor('acme')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('maps plugin error responses to a fail-closed plugin error', async () => {
    const root = await fixtureRoot();
    const { registry } = await registerWithCannedAnswers(root, {
      answer: (operation, _input, canned) =>
        operation === 'identify'
          ? sandboxOutcome(
              JSON.stringify({
                delegatedAdapterResponseVersion: '1',
                ok: false,
                error: { code: 'NOT_FOUND', message: 'no such package' },
              }),
            )
          : canned,
    });
    const catalog = await registry.catalogFor('acme');
    await expect(catalog.identify('demo')).rejects.toMatchObject({
      code: 'PLUGIN_ERROR',
      message: expect.stringContaining('NOT_FOUND'),
    });
  });

  it('bounds oversized stdout both at the sandbox and before parsing', async () => {
    const root = await fixtureRoot();
    const limited = await registerWithCannedAnswers(root, {
      // Large enough for the registry definition, smaller than the flood.
      limits: { responseBytes: 1024 },
      answer: (operation, _input, canned) =>
        operation === 'identify' ? sandboxOutcome('x'.repeat(4096)) : canned,
    });
    const catalog = await limited.registry.catalogFor('acme');
    await expect(catalog.identify('demo')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.stringContaining('exceeds'),
    });

    const second = await fixtureRoot();
    const killed = await registerWithCannedAnswers(second, {
      answer: (operation, _input, canned) =>
        operation === 'identify'
          ? {
              ...sandboxOutcome(''),
              exitCode: 125,
              outputLimitExceeded: 'stdout' as const,
            }
          : canned,
    });
    const killedCatalog = await killed.registry.catalogFor('acme');
    await expect(killedCatalog.identify('demo')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.stringContaining('budget'),
    });
  });

  it('fails closed when the executable identity changes around a run', async () => {
    const root = await fixtureRoot();
    const fixture = await installFixturePlugin(root);
    let revision = 0n;
    const registry = new AdapterRegistry();
    await registerInstalledPlugins({
      storeRoot: fixture.storeRoot,
      registry,
      inspectExecutable: async (path) => ({
        ...fakeIdentity(path, fixture.executableDigest),
        inode: revision,
      }),
      sandboxRun: async (input) => {
        revision += 1n;
        return sandboxOutcome(cannedAnswer(input.argv[1] ?? '', ''));
      },
    });
    await expect(registry.definitionFor('acme')).rejects.toMatchObject({
      code: 'AUTHORITY_NOT_DECLARED',
    });
  });

  it('refuses to invoke when the store executable changed after registration', async () => {
    const root = await fixtureRoot();
    const fixture = await installFixturePlugin(root);
    const registry = new AdapterRegistry();
    const calls: RunInSandboxInput[] = [];
    const result = await registerInstalledPlugins({
      storeRoot: fixture.storeRoot,
      registry,
      // An honest inspector: hashes whatever bytes sit at the path right now.
      inspectExecutable: async (path) =>
        fakeIdentity(
          path,
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        ),
      sandboxRun: async (input) => {
        calls.push(input);
        return sandboxOutcome(cannedAnswer(input.argv[1] ?? '', ''));
      },
    });
    expect(result.refused).toEqual([]);
    // Swap the executable after registration; the digest pinned at
    // registration must refuse the drifted bytes before any sandbox run.
    await writeFile(fixture.executablePath, '#!/bin/sh\nexit 0\n');
    await expect(registry.definitionFor('acme')).rejects.toMatchObject({
      code: 'AUTHORITY_NOT_DECLARED',
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses identify results outside the declared purl types', async () => {
    const root = await fixtureRoot();
    const { registry } = await registerWithCannedAnswers(root, {
      answer: (operation, _input, canned) =>
        operation === 'identify'
          ? sandboxOutcome(
              // SAFETY: The surrounding boundary establishes the asserted domain contract.
              okResponse(
                JSON.parse(
                  JSON.stringify([
                    {
                      ...IDENTITY,
                      canonicalPurl: 'pkg:other/demo',
                      purlType: 'other',
                    },
                  ]),
                ) as JsonValue,
              ),
            )
          : canned,
    });
    const catalog = await registry.catalogFor('acme');
    await expect(catalog.identify('demo')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('refuses an inspect answer for a different package than asked', async () => {
    const root = await fixtureRoot();
    const { registry } = await registerWithCannedAnswers(root, {
      answer: (operation, _input, canned) =>
        operation === 'inspect'
          ? sandboxOutcome(
              // SAFETY: The surrounding boundary establishes the asserted domain contract.
              okResponse(
                JSON.parse(
                  JSON.stringify({
                    package: {
                      ...PACKAGE_INSTANCE,
                      identity: {
                        ...PACKAGE_INSTANCE.identity,
                        exactPurl: 'pkg:acme/demo@2.0.0',
                      },
                    },
                    record: WIRE_RECORD,
                  }),
                ) as JsonValue,
              ),
            )
          : canned,
    });
    const catalog = await registry.catalogFor('acme');
    await expect(catalog.inspect('pkg:acme/demo@1.0.0')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('refuses an inspect answer whose exact purl type was never declared', async () => {
    const root = await fixtureRoot();
    const { registry } = await registerWithCannedAnswers(root, {
      // The plugin echoes the asked-for foreign purl exactly; equality with
      // the request is not enough when the type was never declared.
      answer: (operation, _input, canned) =>
        operation === 'inspect'
          ? sandboxOutcome(
              // SAFETY: The surrounding boundary establishes the asserted domain contract.
              okResponse(
                JSON.parse(
                  JSON.stringify({
                    package: {
                      ...PACKAGE_INSTANCE,
                      identity: {
                        ...PACKAGE_INSTANCE.identity,
                        exactPurl: 'pkg:other/demo@1.0.0',
                      },
                    },
                    record: WIRE_RECORD,
                  }),
                ) as JsonValue,
              ),
            )
          : canned,
    });
    const catalog = await registry.catalogFor('acme');
    await expect(catalog.inspect('pkg:other/demo@1.0.0')).rejects.toMatchObject(
      { code: 'INVALID_RESPONSE' },
    );
  });

  it('refuses a record whose retrievedAt is not an RFC 3339 timestamp', async () => {
    const root = await fixtureRoot();
    const { registry } = await registerWithCannedAnswers(root, {
      answer: (operation, _input, canned) =>
        operation === 'fetch-artifact-record'
          ? sandboxOutcome(
              // SAFETY: The surrounding boundary establishes the asserted domain contract.
              okResponse(
                JSON.parse(
                  JSON.stringify({
                    ...WIRE_RECORD,
                    retrievedAt: '2026-01-01',
                  }),
                ) as JsonValue,
              ),
            )
          : canned,
    });
    const catalog = await registry.catalogFor('acme');
    await expect(
      catalog.fetchArtifactRecord('pkg:acme/demo@1.0.0'),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('fails closed on an operation the protocol does not know', () => {
    let caught: unknown;
    try {
      validateOperationResult(
        fixtureManifest(),
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        'bogus' as DelegatedAdapterOperation,
        {},
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  });

  it('maps a sandbox backend failure to a fail-closed ProviderError', async () => {
    const root = await fixtureRoot();
    const fixture = await installFixturePlugin(root);
    const registry = new AdapterRegistry();
    await registerInstalledPlugins({
      storeRoot: fixture.storeRoot,
      registry,
      inspectExecutable: async (path) =>
        fakeIdentity(path, fixture.executableDigest),
      sandboxRun: async () => {
        throw new SandboxBackendError(
          'UNAVAILABLE',
          'mxc backend is not available',
        );
      },
    });
    await expect(registry.definitionFor('acme')).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'UNAVAILABLE',
    });
  });

  it('maps an unexpected sandbox run failure to PLUGIN_FAILED', async () => {
    const root = await fixtureRoot();
    const fixture = await installFixturePlugin(root);
    const registry = new AdapterRegistry();
    await registerInstalledPlugins({
      storeRoot: fixture.storeRoot,
      registry,
      inspectExecutable: async (path) =>
        fakeIdentity(path, fixture.executableDigest),
      sandboxRun: async () => {
        throw new Error('spawn exploded');
      },
    });
    await expect(registry.definitionFor('acme')).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'PLUGIN_FAILED',
    });
  });

  it('refuses operations the manifest does not declare', async () => {
    const root = await fixtureRoot();
    // catalog capability without snapshot: snapshot stays fail-closed.
    const withoutSnapshot = fixtureManifest();
    delete withoutSnapshot.commands['snapshot'];
    const { registry, result } = await registerWithCannedAnswers(root, {
      manifest: withoutSnapshot,
    });
    expect(result.registered).toEqual(['dev.example.acme-adapter']);
    const catalog = await registry.catalogFor('acme');
    await expect(
      catalog.snapshot('2026-01-02T00:00:00Z'),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });

    // No catalog capability at all: the module has no catalog export.
    const second = await fixtureRoot();
    const definitionOnly = fixtureManifest({
      capabilities: ['registry-definition'],
      commands: {
        'registry-definition': { arguments: ['registry-definition'] },
      },
    });
    const registered = await registerWithCannedAnswers(second, {
      manifest: definitionOnly,
    });
    expect(registered.result.registered).toEqual(['dev.example.acme-adapter']);
    expect(registered.registry.moduleFor('acme').catalog).toBeUndefined();
    await expect(registered.registry.catalogFor('acme')).rejects.toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
    });
  });

  it('refuses a manifest whose capabilities and commands disagree', async () => {
    const root = await fixtureRoot();
    const lying = fixtureManifest();
    delete lying.commands['inspect'];
    const { result } = await registerWithCannedAnswers(root, {
      manifest: lying,
    });
    expect(result.registered).toEqual([]);
    expect(result.refused).toEqual([
      expect.objectContaining({
        name: 'acme',
        code: 'INVALID_PLUGIN_MANIFEST',
      }),
    ]);
  });

  it('fails closed in offline mode before any execution', async () => {
    const root = await fixtureRoot();
    const { registry, calls } = await registerWithCannedAnswers(root);
    // catalogFor resolves the definition first; offline refuses there already.
    await expect(
      registry.catalogFor('acme', { offline: true }),
    ).rejects.toMatchObject({ code: 'OFFLINE' });
    // A catalog obtained online refuses every operation when its context is
    // offline, before the plugin executable is ever opened.
    const module = registry.moduleFor('acme');
    const offlineCatalog = module.catalog!({ offline: true });
    await expect(offlineCatalog.identify('demo')).rejects.toMatchObject({
      code: 'OFFLINE',
    });
    await expect(
      offlineCatalog.fetchArtifactRecord('pkg:acme/demo@1.0.0'),
    ).rejects.toMatchObject({ code: 'OFFLINE' });
    expect(calls).toHaveLength(0);
    // registry-definition may answer from a validated cache without invoking.
    await registry.definitionFor('acme');
    await expect(
      registry.definitionFor('acme', { offline: true }),
    ).resolves.toEqual(DEFINITION);
    expect(
      calls.filter((call) => call.argv[1] === 'registry-definition'),
    ).toHaveLength(1);
  });

  it('refuses --allow-env of OPM_HOST_FETCH_ names', async () => {
    const root = await fixtureRoot();
    for (const name of [
      'OPM_HOST_FETCH_BEARER',
      'OPM_HOST_FETCH_TOKEN_ENVS',
      'OPM_HOST_FETCH_ORIGINS',
    ]) {
      const { result } = await registerWithCannedAnswers(root, {
        allowEnvironment: [name],
        environment: { [name]: 'tok68value' },
      });
      expect(result.registered).toEqual([]);
      expect(result.refused).toEqual([
        expect.objectContaining({
          name: 'acme',
          code: 'UNSAFE_ENV',
          message: expect.stringContaining(name),
        }),
      ]);
      expect(result.refused[0]?.message).not.toMatch(/tok68value/u);
    }
  });

  it('refuses --allow-env of OPM_HOST_FETCH_TOKEN_ENVS names even without the prefix', async () => {
    process.env.OPM_HOST_FETCH_TOKEN_ENVS = 'ACME_TOKEN';
    const root = await fixtureRoot();
    const { result } = await registerWithCannedAnswers(root, {
      allowEnvironment: ['ACME_TOKEN'],
      environment: { ACME_TOKEN: 'tok68value' },
    });
    expect(result.registered).toEqual([]);
    expect(result.refused).toEqual([
      expect.objectContaining({
        name: 'acme',
        code: 'UNSAFE_ENV',
        message: expect.stringContaining('ACME_TOKEN'),
      }),
    ]);
    expect(result.refused[0]?.message).not.toMatch(/tok68value/u);
  });

  it('refuses --allow-env of OPM_HOST_FETCH_HEADER_ENVS names even without the prefix', async () => {
    process.env.OPM_HOST_FETCH_HEADER_ENVS = 'JFROG_API_KEY';
    const root = await fixtureRoot();
    const { result } = await registerWithCannedAnswers(root, {
      allowEnvironment: ['JFROG_API_KEY'],
      environment: { JFROG_API_KEY: 'jfrog-key' },
    });
    expect(result.registered).toEqual([]);
    expect(result.refused).toEqual([
      expect.objectContaining({
        name: 'acme',
        code: 'UNSAFE_ENV',
        message: expect.stringContaining('JFROG_API_KEY'),
      }),
    ]);
    expect(result.refused[0]?.message).not.toMatch(/jfrog-key/u);
  });

  it('refuses --allow-env of a plugin token env name from hostFetchTokenEnvNames', async () => {
    const root = await fixtureRoot();
    const { result } = await registerWithCannedAnswers(root, {
      allowEnvironment: ['ACME_TOKEN'],
      hostFetchTokenEnvNames: ['ACME_TOKEN'],
      environment: { ACME_TOKEN: 'tok68value' },
    });
    expect(result.registered).toEqual([]);
    expect(result.refused).toEqual([
      expect.objectContaining({
        name: 'acme',
        code: 'UNSAFE_ENV',
      }),
    ]);
  });

  it('forwards only allowlisted declared environment', async () => {
    const root = await fixtureRoot();
    const run = await registerWithCannedAnswers(root, {
      allowEnvironment: ['ACME_TOKEN', 'NOT_DECLARED'],
      environment: { ACME_TOKEN: 's3cr3t', NOT_DECLARED: 'x' },
    });
    const catalog = await run.registry.catalogFor('acme');
    await catalog.identify('demo');
    const call = run.calls.find((item) => item.argv[1] === 'identify')!;
    // ACME_TOKEN is declared and allowlisted: forwarded with a grant.
    // ACME_ADAPTER_LOG is declared but not allowlisted: withheld.
    // NOT_DECLARED is allowlisted but undeclared: never forwarded.
    expect(call.env).toEqual({ ACME_TOKEN: 's3cr3t' });
    expect(call.grants?.env).toEqual(['ACME_TOKEN']);
    expect(call.network).toBe(false);
  });

  it('forwards static manifest environment only when allowlisted', async () => {
    const root = await fixtureRoot();
    const run = await registerWithCannedAnswers(root, {
      allowEnvironment: ['ACME_ADAPTER_LOG', 'ACME_TOKEN'],
      environment: { ACME_TOKEN: 's3cr3t' },
    });
    const catalog = await run.registry.catalogFor('acme');
    await catalog.identify('demo');
    const call = run.calls.find((item) => item.argv[1] === 'identify')!;
    expect(call.env).toEqual({
      ACME_ADAPTER_LOG: 'warn',
      ACME_TOKEN: 's3cr3t',
    });
  });

  it('first-party adapters win: a colliding plugin is refused, not registered', async () => {
    const root = await fixtureRoot();
    const firstParty: AdapterModule = {
      id: 'org.openpacker.adapter.acme',
      purlTypes: ['acme'],
      registryDefinition: () => DEFINITION,
    };
    const registry = new AdapterRegistry();
    registry.register(firstParty);
    const { result } = await registerWithCannedAnswers(root, { registry });
    expect(result.registered).toEqual([]);
    expect(result.refused).toEqual([
      expect.objectContaining({ name: 'acme', code: 'PLUGIN_CONFLICT' }),
    ]);
    expect(registry.moduleFor('acme')).toBe(firstParty);
  });

  it('refuses a plugin claiming the reserved opm-plugin purl type', async () => {
    const root = await fixtureRoot();
    const { result } = await registerWithCannedAnswers(root, {
      manifest: fixtureManifest({ purlTypes: ['opm-plugin'] }),
    });
    expect(result.registered).toEqual([]);
    expect(result.refused).toEqual([
      expect.objectContaining({
        name: 'acme',
        code: 'INVALID_PLUGIN_MANIFEST',
      }),
    ]);
  });

  it('refuses a pinned entry whose tree no longer digests to the pin', async () => {
    const root = await fixtureRoot();
    const fixture = await installFixturePlugin(root);
    await writeFile(join(fixture.storePath, 'plugin.json'), '{}\n');
    const registry = new AdapterRegistry();
    const result = await registerInstalledPlugins({
      storeRoot: fixture.storeRoot,
      registry,
      inspectExecutable: async (path) => fakeIdentity(path),
      sandboxRun: async () => sandboxOutcome(''),
    });
    expect(result.registered).toEqual([]);
    expect(result.refused).toEqual([
      expect.objectContaining({ name: 'acme', code: 'DIGEST_MISMATCH' }),
    ]);
    expect(registry.has('acme')).toBe(false);
  });
});

// Host-side executables validation (spec Executables section): the schema
// bounds shape; this pass enforces the prose rules and re-asserts the safety
// invariants at the trust boundary, failing closed as INVALID_RESPONSE.
describe('inspect executables', () => {
  const inspect = (executables: unknown) =>
    validateOperationResult(
      fixtureManifest(),
      'inspect',
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      JSON.parse(
        JSON.stringify({
          package: PACKAGE_INSTANCE,
          record: WIRE_RECORD,
          ...(!(executables === undefined) && { executables }),
        }),
      ) as JsonValue,
      { exactPurl: 'pkg:acme/demo@1.0.0' },
    );

  it('accepts valid declarations across every interpreter', () => {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const inspection = inspect([
      { name: 'demo', path: 'bin/demo.js' },
      {
        name: 'demo.py',
        path: 'lib/demo/main.py',
        interpreter: 'python',
        entry: 'demo.cli:main',
      },
      { name: 'demo-net', path: 'tools/demo.dll', interpreter: 'dotnet' },
      { name: 'demo-native', path: 'bin/demo', interpreter: 'native' },
    ]) as { executables?: readonly unknown[] };
    expect(inspection.executables).toHaveLength(4);
  });

  it('omits executables when the plugin answered none', () => {
    expect(inspect(undefined)).not.toHaveProperty('executables');
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    expect((inspect([]) as { executables: unknown[] }).executables).toEqual([]);
  });

  const invalidBins: [string, unknown][] = [
    ['an unsafe name', [{ name: 'a/b', path: 'bin/a' }]],
    ['an absolute path', [{ name: 'a', path: '/bin/a' }]],
    ['a .. path segment', [{ name: 'a', path: 'bin/../a' }]],
    ['a backslash path', [{ name: 'a', path: 'bin\\a' }]],
    ['a drive-prefixed path', [{ name: 'a', path: 'C:/bin/a' }]],
    [
      'an unknown interpreter',
      [{ name: 'a', path: 'bin/a', interpreter: 'ruby' }],
    ],
    [
      'an entry without the python interpreter',
      [{ name: 'a', path: 'bin/a.js', entry: 'demo.cli:main' }],
    ],
    [
      'python without an entry',
      [{ name: 'a', path: 'bin/a.py', interpreter: 'python' }],
    ],
    [
      'python with a malformed entry',
      [{ name: 'a', path: 'bin/a.py', interpreter: 'python', entry: 'broken' }],
    ],
    [
      'duplicate names',
      [
        { name: 'a', path: 'bin/a' },
        { name: 'a', path: 'bin/b' },
      ],
    ],
  ];
  for (const [label, executables] of invalidBins)
    it(`fails closed on ${label}`, () => {
      expect(() => inspect(executables)).toThrowError(
        expect.objectContaining({ code: 'INVALID_RESPONSE' }),
      );
    });

  it('fails closed on more than 64 declarations', () => {
    const executables = Array.from({ length: 65 }, (_, index) => ({
      name: `bin-${index}`,
      path: `bin/${index}`,
    }));
    expect(() => inspect(executables)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' }),
    );
  });

  it('surfaces validated executables through catalog inspect', async () => {
    const root = await fixtureRoot();
    const executables = [
      { name: 'demo', path: 'bin/demo.js' },
      {
        name: 'demo-py',
        path: 'lib/demo.py',
        interpreter: 'python',
        entry: 'demo.cli:main',
      },
    ];
    const { registry } = await registerWithCannedAnswers(root, {
      answer: (operation, _input, canned) =>
        operation === 'inspect'
          ? sandboxOutcome(
              // SAFETY: The surrounding boundary establishes the asserted domain contract.
              okResponse(
                JSON.parse(
                  JSON.stringify({
                    package: PACKAGE_INSTANCE,
                    record: WIRE_RECORD,
                    executables,
                  }),
                ) as JsonValue,
              ),
            )
          : canned,
    });
    const catalog = await registry.catalogFor('acme');
    const inspection = await catalog.inspect('pkg:acme/demo@1.0.0');
    expect(inspection.executables).toEqual(executables);
  });

  it('preserves an absent executables answer through catalog inspect', async () => {
    const root = await fixtureRoot();
    // The canned inspect answer carries no executables key at all.
    const { registry } = await registerWithCannedAnswers(root);
    const catalog = await registry.catalogFor('acme');
    const inspection = await catalog.inspect('pkg:acme/demo@1.0.0');
    expect(inspection.executables).toBeUndefined();
  });
});

describe('artifact-bytes capability marker', () => {
  it('advertises host-side fetching when fetch-artifact-record is admitted', async () => {
    const root = await fixtureRoot();
    const { registry } = await registerWithCannedAnswers(root);
    const catalog = await registry.catalogFor('acme');
    expect(catalog.capabilities.operations).toContain('artifact');
    expect(catalog.capabilities.extensions).toEqual({
      'openpacker/artifact-bytes': 'host-fetch',
    });
  });

  it('omits the marker when the manifest admits no fetch-artifact-record', () => {
    // A catalog manifest without fetch-artifact-record is refused at load, so
    // exercise the provider constructor directly.
    const manifest = fixtureManifest();
    delete manifest.commands['fetch-artifact-record'];
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const executor = {
      invoke: async () => {
        throw new Error('must not be invoked');
      },
    } as unknown as DelegatedPluginExecutor;
    const catalog = delegatedAdapterModule(manifest, executor).catalog!({});
    expect(catalog.capabilities.operations).not.toContain('artifact');
    expect(catalog.capabilities.extensions).toEqual({});
  });
});

describe('registerPlugin', () => {
  it('registers one named plugin and stays idempotent', async () => {
    const root = await fixtureRoot();
    const fixture = await installFixturePlugin(root);
    const registry = new AdapterRegistry();
    const dependencies = {
      storeRoot: fixture.storeRoot,
      registry,
      inspectExecutable: async (path: string) => fakeIdentity(path),
      sandboxRun: async () => sandboxOutcome(''),
    };
    const first = await registerPlugin('acme', dependencies);
    expect(first).toEqual({
      name: 'acme',
      id: 'dev.example.acme-adapter',
      purlTypes: ['acme'],
      alreadyRegistered: false,
    });
    expect(registry.has('acme')).toBe(true);
    const second = await registerPlugin('acme', dependencies);
    expect(second.alreadyRegistered).toBe(true);
  });

  it('never acquires: an unknown name is PLUGIN_NOT_INSTALLED', async () => {
    const root = await fixtureRoot();
    const fixture = await installFixturePlugin(root);
    await expect(
      registerPlugin('globex', {
        storeRoot: fixture.storeRoot,
        registry: new AdapterRegistry(),
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_NOT_INSTALLED' });
  });

  it('fails closed on a tampered entry instead of registering it', async () => {
    const root = await fixtureRoot();
    const fixture = await installFixturePlugin(root);
    await writeFile(join(fixture.storePath, 'plugin.json'), '{}\n');
    await expect(
      registerPlugin('acme', {
        storeRoot: fixture.storeRoot,
        registry: new AdapterRegistry(),
      }),
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' });
  });
});

describe('verifyPluginBindings', () => {
  async function boundDigest(storeRoot: string): Promise<string> {
    const [pin] = await listPlugins({ storeRoot });
    return pin!.storeDigest;
  }

  it('verifies and registers a correctly pinned binding', async () => {
    const root = await fixtureRoot();
    const fixture = await installFixturePlugin(root);
    const registry = new AdapterRegistry();
    const bound = await verifyPluginBindings(
      {
        'dev.example.acme-adapter': {
          storeDigest: await boundDigest(fixture.storeRoot),
        },
      },
      {
        storeRoot: fixture.storeRoot,
        registry,
        inspectExecutable: async (path: string) => fakeIdentity(path),
        sandboxRun: async () => sandboxOutcome(''),
      },
    );
    expect(bound.map((entry) => entry.id)).toEqual([
      'dev.example.acme-adapter',
    ]);
    expect(registry.has('acme')).toBe(true);
  });

  it('refuses a binding to a store entry that is not the installed one', async () => {
    const root = await fixtureRoot();
    const fixture = await installFixturePlugin(root);
    await expect(
      verifyPluginBindings(
        {
          'dev.example.acme-adapter': {
            storeDigest: `sha256:${'b'.repeat(64)}`,
          },
        },
        { storeRoot: fixture.storeRoot, registry: new AdapterRegistry() },
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_DIGEST_MISMATCH' });
  });

  it('refuses --allow-env of a binding artifact_origin_token_envs name', async () => {
    const root = await fixtureRoot();
    const fixture = await installFixturePlugin(root);
    await expect(
      verifyPluginBindings(
        {
          'dev.example.acme-adapter': {
            storeDigest: await boundDigest(fixture.storeRoot),
            artifactOriginTokenEnvs: ['ACME_TOKEN'],
          },
        },
        {
          storeRoot: fixture.storeRoot,
          registry: new AdapterRegistry(),
          allowEnvironment: ['ACME_TOKEN'],
          environment: { ACME_TOKEN: 'tok68value' },
          inspectExecutable: async (path: string) => fakeIdentity(path),
          sandboxRun: async () => sandboxOutcome(''),
        },
      ),
    ).rejects.toMatchObject({
      code: 'UNSAFE_ENV',
      message: expect.stringContaining('ACME_TOKEN'),
    });
  });

  it('refuses --allow-env of a binding extra-header env name', async () => {
    const root = await fixtureRoot();
    const fixture = await installFixturePlugin(root);
    await expect(
      verifyPluginBindings(
        {
          'dev.example.acme-adapter': {
            storeDigest: await boundDigest(fixture.storeRoot),
            artifactOriginExtraHeaderEnvs: ['JFROG_API_KEY'],
          },
        },
        {
          storeRoot: fixture.storeRoot,
          registry: new AdapterRegistry(),
          allowEnvironment: ['JFROG_API_KEY'],
          environment: { JFROG_API_KEY: 'jfrog-key' },
          inspectExecutable: async (path: string) => fakeIdentity(path),
          sandboxRun: async () => sandboxOutcome(''),
        },
      ),
    ).rejects.toMatchObject({
      code: 'UNSAFE_ENV',
      message: expect.stringContaining('JFROG_API_KEY'),
    });
  });

  it('refuses a binding to a plugin that is not installed', async () => {
    const root = await fixtureRoot();
    const fixture = await installFixturePlugin(root);
    await expect(
      verifyPluginBindings(
        {
          'dev.example.globex-adapter': {
            storeDigest: `sha256:${'b'.repeat(64)}`,
          },
        },
        { storeRoot: fixture.storeRoot, registry: new AdapterRegistry() },
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_NOT_INSTALLED' });
  });
});

// Real immutable-snapshot execution: the store executable is snapshotted,
// hashed, and run by the mock backend with no OS jail. Linux-only, matching
// the pack-provider snapshot tests.
describe.skipIf(process.platform !== 'linux')(
  'snapshot execution (mock backend)',
  () => {
    it('round-trips the protocol through the real script and snapshot', async () => {
      const root = await fixtureRoot();
      const fixture = await installFixturePlugin(root);
      const registry = new AdapterRegistry();
      const result = await registerInstalledPlugins({
        storeRoot: fixture.storeRoot,
        registry,
        allowEnvironment: ['ACME_TOKEN'],
        environment: { ACME_TOKEN: 's3cr3t' },
        sandboxRun: async (input) =>
          runInSandbox({ ...input, backend: createMockBackend() }),
      });
      expect(result.refused).toEqual([]);

      const definition = await registry.definitionFor('acme');
      expect(definition).toEqual(DEFINITION);
      const catalog = await registry.catalogFor('acme');
      const identities = await catalog.identify('demo');
      // The script echoed the request query and the forwarded environment.
      expect(identities[0]?.aliases).toEqual(['demo', 's3cr3t', 'unset']);
      await expect(catalog.enumerate('pkg:acme/demo')).resolves.toEqual([
        'pkg:acme/demo@1.0.0',
      ]);
      const inspection = await catalog.inspect('pkg:acme/demo@1.0.0');
      expect(inspection.package.identity.exactPurl).toBe('pkg:acme/demo@1.0.0');
      const record = await catalog.fetchArtifactRecord('pkg:acme/demo@1.0.0');
      expect(record.body).toEqual({ artifact: true });
      const snapshot = await catalog.snapshot('2026-01-02T00:00:00Z');
      expect(snapshot.snapshotId).toBe('snap-1');
    });

    it('detects the store executable being swapped after registration', async () => {
      const root = await fixtureRoot();
      const fixture = await installFixturePlugin(root);
      const registry = new AdapterRegistry();
      await registerInstalledPlugins({
        storeRoot: fixture.storeRoot,
        registry,
        sandboxRun: async (input) => {
          // Swap the approved path mid-operation; the identity re-check must
          // fail closed even though the sandboxed run itself succeeded.
          await writeFile(fixture.executablePath, '#!/bin/sh\nexit 0\n');
          return runInSandbox({ ...input, backend: createMockBackend() });
        },
      });
      await expect(registry.definitionFor('acme')).rejects.toMatchObject({
        code: 'AUTHORITY_NOT_DECLARED',
      });
    });

    it('fails closed when the sandboxed plugin exits nonzero', async () => {
      const root = await fixtureRoot();
      const fixture = await installFixturePlugin(root, {
        executable: '#!/bin/sh\nexit 3\n',
      });
      const registry = new AdapterRegistry();
      await registerInstalledPlugins({
        storeRoot: fixture.storeRoot,
        registry,
        sandboxRun: async (input) =>
          runInSandbox({ ...input, backend: createMockBackend() }),
      });
      await expect(registry.definitionFor('acme')).rejects.toMatchObject({
        code: 'PLUGIN_FAILED',
      });
    });
  },
);

const nativeBackend = createNativeBackend();
const bwrapReady =
  process.platform === 'linux' &&
  findTrustedSandboxHelper('bwrap') !== undefined &&
  nativeBackend?.id === 'native-bwrap';

describe.skipIf(!bwrapReady)('native bwrap execution', () => {
  it('answers inside the fail-closed jail with no network and a read-only store', async () => {
    const root = await fixtureRoot();
    const fixture = await installFixturePlugin(root);
    const registry = new AdapterRegistry();
    const result = await registerInstalledPlugins({
      storeRoot: fixture.storeRoot,
      registry,
      allowEnvironment: ['ACME_TOKEN'],
      environment: { ACME_TOKEN: 's3cr3t' },
    });
    expect(result.refused).toEqual([]);
    const catalog = await registry.catalogFor('acme');
    const identities = await catalog.identify('demo');
    expect(identities[0]?.aliases).toEqual(['demo', 's3cr3t', 'unset']);
  });
});

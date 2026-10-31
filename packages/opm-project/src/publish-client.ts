import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { echoedValue } from '@openpacker/adapter-core';
import {
  canonicalDigest,
  documentParseLimits,
  parseCanonicalJson,
  parseUntrustedUrl,
} from '@openpacker/canonical';
import type {
  ArtifactDescriptor,
  ArtifactLocation,
  JsonValue,
  LifecycleApplyResponse,
  LifecycleEvent,
  PackReceipt,
  PublishRequest,
  PublishResponse,
} from '@openpacker/contracts';
import { OpenPackerClient, PrexClientError } from '@openpacker/sdk';
import { packProject, PACK_RECEIPT } from './pack.js';
import { readStableFile } from './paths.js';
import { parsePackageSpec, stripPurlVersion } from './spec.js';
import { OpmError } from './types.js';

export interface PublishPackedArtifactInput {
  from?: string;
  pack?: {
    root: string;
    ecosystem: string;
    version: string;
    name?: string;
    outputDirectory?: string;
    strategy?: 'delegate' | 'standard';
    provider?: string;
  };
  registry?: string;
  offline?: boolean;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface PublishPackedArtifactResult {
  request: PublishRequest;
  response: PublishResponse;
  registry: string;
}

export interface YankRegistryVersionInput {
  purl: string;
  registry?: string;
  reason?: string;
  offline?: boolean;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

const EXACT_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;
const NATIVE_REGISTRY_HOSTS = [
  'registry.npmjs.org',
  'pypi.org',
  'crates.io',
] as const;

export async function publishPackedArtifact(
  input: PublishPackedArtifactInput,
): Promise<PublishPackedArtifactResult> {
  assertOnline(input.offline);
  const registry = resolveRegistry(input.registry, input.env);
  const from = await resolvePackDirectory(input);
  const receipt = await readPackReceipt(from);
  const artifact = distributionArtifact(receipt);
  const fileName = artifact.fileName;
  if (fileName === undefined)
    throw new OpmError(
      'INVALID_SPEC',
      'Pack receipt omitted the distribution file name',
    );
  const artifactPath = join(from, fileName);
  const location: ArtifactLocation = {
    transport: 'file',
    uri: pathToFileURL(artifactPath).href,
    priority: 0,
    rangeSupported: true,
    annotations: {
      'openpacker.package.name': receipt.target.identifier,
      'openpacker.package.version': receipt.target.version,
      'openpacker.package.purlType': receipt.target.purlType,
    },
  };
  const descriptor: ArtifactDescriptor = {
    ...artifact,
    locations: [location],
  };
  const request: PublishRequest = { descriptor, location };
  try {
    const response = await prexClient(registry, input.fetch).publish(request, {
      ...(!(input.signal === undefined) && { signal: input.signal }),
    });
    return { request, response: response.data, registry };
  } catch (error) {
    throw wrapClientError(error);
  }
}

export async function yankRegistryVersion(
  input: YankRegistryVersionInput,
): Promise<LifecycleApplyResponse> {
  assertOnline(input.offline);
  const registry = resolveRegistry(input.registry, input.env);
  const parsed = parsePackageSpec(input.purl);
  if (parsed.version === undefined || !EXACT_VERSION.test(parsed.version))
    throw new OpmError(
      'INVALID_SPEC',
      'opm yank requires an exact PURL name@version; wildcards are refused',
    );
  const ecosystem = parsed.ecosystem ?? 'generic';
  const exactPurl = parsed.purl;
  const canonicalPurl = stripPurlVersion(exactPurl);
  const name = yankName(canonicalPurl, parsed.alias);
  const issuedAt = new Date().toISOString();
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const sourceSnapshot = await canonicalDigest({
    exactPurl,
    name,
    version: parsed.version,
  } as JsonValue);
  const event: LifecycleEvent = {
    eventVersion: '1',
    eventId: randomUUID(),
    subject: {
      canonicalPurl,
      exactPurl,
      purlType: ecosystem,
      name,
      version: parsed.version,
      qualifiers: {},
      nativeCoordinates: [
        {
          ecosystem,
          coordinate: name,
          version: parsed.version,
        },
      ],
      aliases: [parsed.alias],
      sourceRefs: [],
      publisherRefs: [],
      externalRefs: [],
    },
    action: 'yanked',
    effectiveAt: issuedAt,
    issuedAt,
    actor: { type: 'uri', value: 'urn:openpacker:opm' },
    authority: 'registry',
    reasonCode: 'YANKED',
    ...(!(input.reason === undefined) && { reason: input.reason }),
    replacementRefs: [],
    sourceSnapshot,
    evidenceRefs: [],
    externalRefs: [],
  };
  try {
    const response = await prexClient(registry, input.fetch).lifecycleApply(
      event,
      input.signal === undefined ? {} : { signal: input.signal },
    );
    return response.data;
  } catch (error) {
    throw wrapClientError(error);
  }
}

function assertOnline(offline: boolean | undefined): void {
  if (offline === true)
    throw new OpmError(
      'OFFLINE',
      'opm publish/yank refuses --offline; a PREX registry round-trip is required',
    );
}

function resolveRegistry(
  registry: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
): string {
  const raw = (registry ?? env?.OPM_PREX_REGISTRY ?? '').trim();
  if (raw === '')
    throw new OpmError(
      'UNAVAILABLE',
      'opm publish/yank requires --registry or OPM_PREX_REGISTRY',
    );
  let parsed: URL;
  try {
    parsed = parseUntrustedUrl(raw);
  } catch {
    throw new OpmError(
      'UNSAFE_PATH',
      `Invalid PREX registry URL: ${echoedValue(raw)}`,
    );
  }
  if (parsed.username !== '' || parsed.password !== '')
    throw new OpmError(
      'UNSAFE_PATH',
      'PREX registry URLs must not carry userinfo',
    );
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new OpmError(
      'UNSAFE_PATH',
      `PREX registry URL must be http(s); got ${parsed.protocol}`,
    );
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  if (
    NATIVE_REGISTRY_HOSTS.some(
      (denied) =>
        host === denied ||
        host === `www.${denied}` ||
        host.endsWith(`.${denied}`),
    )
  )
    throw new OpmError(
      'UNSAFE_PATH',
      `Refusing to publish/yank to native registry ${host}; PREX registries only`,
    );
  return parsed.href;
}

function prexClient(
  registry: string,
  fetchImpl?: typeof fetch,
): OpenPackerClient {
  try {
    return new OpenPackerClient({
      baseUrl: registry.endsWith('/') ? registry : `${registry}/`,
      ...(!(fetchImpl === undefined) && { fetch: fetchImpl }),
    });
  } catch (error) {
    throw wrapClientError(error);
  }
}

async function resolvePackDirectory(
  input: PublishPackedArtifactInput,
): Promise<string> {
  if (input.pack !== undefined) {
    const name = input.pack.name;
    if (name === undefined || name.trim() === '')
      throw new OpmError(
        'INVALID_SPEC',
        'opm publish --pack requires a package name',
      );
    const outputDirectory =
      input.pack.outputDirectory ??
      input.from ??
      join(input.pack.root, '.opm', 'pack');
    const outcome = await packProject({
      root: input.pack.root,
      ecosystem: input.pack.ecosystem,
      strategy: input.pack.strategy ?? 'standard',
      name,
      version: input.pack.version,
      outputDirectory,
      ...(!(input.pack.provider === undefined) && {
        provider: input.pack.provider,
      }),
    });
    if (!outcome.performed || outcome.exitCode !== 0)
      throw new OpmError(
        'UNAVAILABLE',
        'pack did not produce a publishable artifact',
      );
    const packed = outcome.artifacts.find(
      (artifact) => artifact.nativeRole === 'distribution',
    );
    return packed === undefined ? outputDirectory : dirname(packed.path);
  }
  if (input.from === undefined || input.from.trim() === '')
    throw new OpmError(
      'INVALID_SPEC',
      'opm publish requires --from <dir> or --pack <ecosystem>',
    );
  if (!isAbsolute(input.from))
    throw new OpmError(
      'UNSAFE_PATH',
      'opm publish --from must be an absolute directory',
    );
  return input.from;
}

/**
 * The most a pack receipt is read of, and so what its parse may cost: as much
 * as an honest document of these bytes (`documentParseLimits`, 64 MiB). The
 * directory is the one `--from` names, which a build may have filled, and 4
 * MiB of `{"1023":0}` costs gigabytes to hold (ADR 0044, "Documents other
 * than packuments").
 */
const PACK_RECEIPT_BYTES = 4 * 1024 * 1024;

async function readPackReceipt(directory: string): Promise<PackReceipt> {
  const raw = await readStableFile(
    join(directory, PACK_RECEIPT),
    PACK_RECEIPT_BYTES,
  );
  try {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    return parseCanonicalJson(
      raw,
      documentParseLimits(PACK_RECEIPT_BYTES),
    ) as PackReceipt;
  } catch (error) {
    throw new OpmError(
      'INVALID_SPEC',
      `Invalid pack receipt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function distributionArtifact(receipt: PackReceipt): ArtifactDescriptor {
  const found =
    receipt.artifacts.find(
      (artifact) => artifact.nativeRole === 'distribution',
    ) ?? receipt.artifacts[0];
  if (found === undefined)
    throw new OpmError(
      'INVALID_SPEC',
      'Pack receipt contains no distribution artifact',
    );
  return found;
}

function yankName(canonicalPurl: string, alias: string): string {
  const match = canonicalPurl.match(/^pkg:[A-Za-z0-9.-]+\/(.+)$/u);
  if (match?.[1] === undefined) return alias;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function wrapClientError(error: unknown): OpmError {
  if (error instanceof OpmError) return error;
  if (error instanceof PrexClientError) {
    const code = error.problem?.code;
    return new OpmError(code ?? 'UNAVAILABLE', error.message);
  }
  return new OpmError(
    'UNAVAILABLE',
    error instanceof Error ? error.message : String(error),
  );
}

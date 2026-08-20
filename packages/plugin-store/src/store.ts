/**
 * The user-level delegated-adapter plugin store.
 *
 * Plugins are PREX packages under the reserved purl type `opm-plugin`. They
 * are resolved, digest-pinned and policy-gated exactly like any other
 * registry artifact (the same `resolveRegistryArtifact` + supply-chain
 * evaluation path an ephemeral run uses), then materialized into a
 * content-addressed store no project shares mutably:
 *
 *   <store>/sha256-<hex>/           materialized entry (plugin.json + executable)
 *   <store>/sha256-<hex>.artifact   cached verified artifact bytes (offline repair)
 *   <store>/plugins.json            pin index
 *
 * A plugin artifact is exactly two root-level regular files: the
 * DelegatedAdapterManifest at `plugin.json` and the standalone executable the
 * manifest declares. Anything else — extra files, directories, links — is
 * refused at `plugin add`, so a malformed plugin never reaches the store.
 * The manifest is schema-validated before materialization and re-verified
 * against the materialized bytes afterwards.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  streamFromBytes,
  descriptorForBytes,
  type ArtifactSource,
} from '@openpacker/artifact-model';
import { parseAndValidateContract } from '@openpacker/conformance';
import type { DelegatedAdapterManifest } from '@openpacker/contracts';
import {
  DEFAULT_MATERIALIZATION_LIMITS,
  inspectArchive,
  materialize,
  type InspectedArchiveEntry,
  type MaterializationLimits,
} from '@openpacker/materializer';
import { policyDocumentFromPolicyInput } from '@openpacker/policy';
import {
  assertDigest,
  assertSafeSegment,
  assertSupplyChainAllowed,
  captureFactsFromCatalog,
  defaultSupplyChainPolicyInput,
  digestOf,
  ensureStableDirectory,
  inferFormat,
  listRegistryVersions,
  OpmError,
  providerFor,
  readStableFile,
  readStableFileBytes,
  removeStableFile,
  removeStableTree,
  requireAdapterRegistry,
  resolveRegistryArtifact,
  stableStoreTreeDigest,
  storeKeyFromDigest,
  writeStableFile,
  type ArchiveFormat,
  type RegistryOptions,
} from '@openpacker/opm-project';
import type { HttpTransport } from '@openpacker/adapter-core';
import {
  pluginRegistryModule,
  requirePluginRegistryEndpoint,
  PLUGIN_PURL_TYPE,
} from './registry.js';

/** Name of the manifest file inside a plugin artifact (and store entry). */
export const PLUGIN_MANIFEST_NAME = 'plugin.json';
/** Pin index file at the plugin store root. */
export const PLUGIN_INDEX_NAME = 'plugins.json';

const MANIFEST_SCHEMA =
  'https://openpacker.dev/spec/prex/v1/schemas/delegated-adapter.schema.json#/$defs/DelegatedAdapterManifest';

/**
 * Plugin archives are tiny by construction: a manifest and one standalone
 * executable, at the root, nothing nested.
 */
const PLUGIN_ARCHIVE_LIMITS: MaterializationLimits = {
  ...DEFAULT_MATERIALIZATION_LIMITS,
  maximumFiles: 4,
  maximumDepth: 1,
};

const PLUGIN_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const PLUGIN_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;

/**
 * The plugin store root.
 *
 * `OPM_PLUGIN_HOME` wins when set and must be an absolute path — a relative
 * override would silently put executables wherever the caller happened to
 * run. Otherwise the XDG data dir, then the home fallback.
 */
export function pluginStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPM_PLUGIN_HOME?.trim();
  if (explicit) {
    if (!isAbsolute(explicit))
      throw new OpmError(
        'UNSAFE_PATH',
        `OPM_PLUGIN_HOME must be an absolute path, got "${explicit}"`,
      );
    return explicit;
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) {
    if (!isAbsolute(xdg))
      throw new OpmError(
        'UNSAFE_PATH',
        `XDG_DATA_HOME must be an absolute path, got "${xdg}"`,
      );
    return join(xdg, 'openpacker', 'plugins');
  }
  return join(homedir(), '.local', 'share', 'openpacker', 'plugins');
}

export interface PluginSpec {
  name: string;
  version?: string;
}

/** Parse `name`, `name@version`, or the full `pkg:opm-plugin/name@version`. */
export function parsePluginSpec(spec: string): PluginSpec {
  let value = spec.trim();
  if (value.startsWith('pkg:')) {
    if (!value.startsWith(`pkg:${PLUGIN_PURL_TYPE}/`))
      throw new OpmError(
        'INVALID_PLUGIN_SPEC',
        `Not a plugin purl: "${spec}" (expected pkg:${PLUGIN_PURL_TYPE}/<name>[@<version>])`,
      );
    value = value.slice(`pkg:${PLUGIN_PURL_TYPE}/`.length);
  }
  const at = value.lastIndexOf('@');
  const name = at === -1 ? value : value.slice(0, at);
  const version = at === -1 ? undefined : value.slice(at + 1);
  return {
    name: parsePluginName(name),
    ...(version === undefined ? {} : { version: parsePluginVersion(version) }),
  };
}

export function parsePluginName(name: string): string {
  if (!PLUGIN_NAME.test(name))
    throw new OpmError(
      'INVALID_PLUGIN_SPEC',
      `Invalid plugin name "${name}" (must match ${PLUGIN_NAME})`,
    );
  return name;
}

function parsePluginVersion(version: string): string {
  if (!PLUGIN_VERSION.test(version))
    throw new OpmError(
      'INVALID_PLUGIN_SPEC',
      `Invalid plugin version "${version}" (must match ${PLUGIN_VERSION})`,
    );
  return version;
}

/** One pin in `<store>/plugins.json`. */
export interface PluginPin {
  /** Manifest `id` — the name project bindings (`[plugins.<id>]`) use. */
  id: string;
  /** Purl name the plugin was added under (`opm plugin add <name>`). */
  name: string;
  exactPurl: string;
  /** Artifact digest; also names the store entry `sha256-<hex>`. */
  storeDigest: string;
  /** Digest over the materialized store tree, for tamper detection. */
  treeDigest: string;
  /** Manifest path within the store entry. */
  manifestPath: string;
  installedAt: string;
  /** Archive format of the cached `.artifact` bytes. */
  format: ArchiveFormat;
}

interface PluginIndex {
  pluginStoreVersion: 1;
  plugins: Record<string, PluginPin>;
}

export interface InstalledPlugin extends PluginPin {
  storePath: string;
  /** True when the store entry was already present and verified intact. */
  alreadyInstalled: boolean;
  /** True when bytes came from the local `.artifact` cache (offline path). */
  cached: boolean;
}

export interface ListedPlugin extends PluginPin {
  storePath: string;
  /** False when the pin exists but the store entry vanished. */
  present: boolean;
}

export interface PluginStoreOptions {
  /** Store root override; defaults to {@link pluginStoreRoot}. */
  storeRoot?: string;
}

export interface AddPluginOptions extends PluginStoreOptions {
  name: string;
  version?: string;
  offline?: boolean;
  /** Plugin registry endpoint; defaults to OPM_REGISTRY_OPM_PLUGIN. */
  endpoint?: string;
  transport?: HttpTransport;
  fetch?: typeof fetch;
  /** Injectable clock: policy evaluation time and `installedAt`. */
  now?: () => string;
  signal?: AbortSignal;
}

export async function addPlugin(
  options: AddPluginOptions,
): Promise<InstalledPlugin> {
  const name = parsePluginName(options.name);
  const version =
    options.version === undefined
      ? undefined
      : parsePluginVersion(options.version);
  const root = options.storeRoot ?? pluginStoreRoot();
  const now = options.now ?? (() => new Date().toISOString());
  const offline = options.offline === true;
  await ensureStableDirectory(root);
  const indexPath = join(root, PLUGIN_INDEX_NAME);
  const index = await readPluginIndex(indexPath);
  const existing = index.plugins[name];
  const wantedExact =
    version === undefined
      ? undefined
      : `pkg:${PLUGIN_PURL_TYPE}/${name}@${version}`;

  if (existing !== undefined) {
    if (wantedExact !== undefined && existing.exactPurl !== wantedExact)
      throw new OpmError(
        'PLUGIN_ALREADY_INSTALLED',
        `Plugin "${name}" is installed as ${existing.exactPurl}. ` +
          `Remove it first (opm plugin remove ${name}) to install ${wantedExact}.`,
      );
    const intact = await verifyEntry(root, existing);
    // Nothing came from the `.artifact` cache here: the intact store entry
    // itself answered, so `cached` stays false.
    if (intact) return toInstalled(root, existing, true, false);
    // The entry vanished or was tampered with: repair from the cached
    // artifact bytes when they are present and still digest-verified — the
    // only offline-capable path, mirroring the project store's cache rule.
    const cached = await readCachedArtifact(root, existing);
    if (cached !== undefined)
      return materializeAndPin(root, indexPath, index, existing, cached, now, {
        alreadyInstalled: false,
        cached: true,
      });
    if (offline)
      throw new OpmError(
        'OFFLINE',
        `Plugin "${name}" is pinned but neither its store entry nor its ` +
          'cached artifact is present, and reinstalling needs the plugin registry.',
      );
    // Online repair: refetch the pinned exact identity.
    return acquire(
      root,
      indexPath,
      index,
      name,
      existing.exactPurl,
      options,
      now,
    );
  }

  if (offline)
    throw new OpmError(
      'OFFLINE',
      `Cannot install plugin "${name}" while offline: nothing is pinned for ` +
        'it and resolution needs the plugin registry.',
    );
  return acquire(root, indexPath, index, name, wantedExact, options, now);
}

/**
 * Resolve, fetch, policy-gate, verify and materialize one plugin.
 *
 * Resolution mirrors `fetchTool`: an exact version is used as given, a bare
 * name takes the newest the registry publishes — and because there is no
 * lockfile here, the resolved version is pinned back into `plugins.json`.
 */
async function acquire(
  root: string,
  indexPath: string,
  index: PluginIndex,
  name: string,
  wantedExact: string | undefined,
  options: AddPluginOptions,
  now: () => string,
): Promise<InstalledPlugin> {
  const endpoint = options.endpoint ?? requirePluginRegistryEndpoint();
  const registry = requireAdapterRegistry();
  if (!registry.has(PLUGIN_PURL_TYPE))
    registry.register(
      pluginRegistryModule({
        endpoint,
        ...(options.transport === undefined
          ? {}
          : { transport: options.transport }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
    );
  const registryOptions: RegistryOptions = {
    endpoint,
    ...(options.transport === undefined
      ? {}
      : { transport: options.transport }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    now,
  };

  const basePurl = `pkg:${PLUGIN_PURL_TYPE}/${name}`;
  const exact =
    wantedExact ??
    (await (async () => {
      const versions = await listRegistryVersions(
        PLUGIN_PURL_TYPE,
        basePurl,
        registryOptions,
      );
      const newest = versions[versions.length - 1];
      if (!newest)
        throw new OpmError(
          'UNRESOLVABLE',
          `The plugin registry published no versions of ${basePurl}.`,
        );
      return newest;
    })());

  const artifact = await resolveRegistryArtifact(
    PLUGIN_PURL_TYPE,
    exact,
    registryOptions,
  );

  // The same supply-chain gate a package install passes through.
  const provider = await providerFor(PLUGIN_PURL_TYPE, registryOptions);
  const { inspection, facts } = await captureFactsFromCatalog(
    provider,
    artifact.exactPurl,
    { evaluationTime: now(), registryId: artifact.registryId },
  );
  if (facts.publishedAt === undefined) {
    const publishedAt = (
      inspection.record.body as {
        registryMetadata?: { publishedAt?: unknown };
      }
    ).registryMetadata?.publishedAt;
    if (typeof publishedAt === 'string') facts.publishedAt = publishedAt;
  }
  await assertSupplyChainAllowed(
    policyDocumentFromPolicyInput(defaultSupplyChainPolicyInput()),
    facts,
  );

  // Defense in depth: the provider verified the download, and the bytes are
  // re-hashed here before they are allowed to touch the store.
  if (digestOf(artifact.bytes) !== artifact.digest)
    throw new OpmError(
      'DIGEST_MISMATCH',
      `Plugin artifact for ${artifact.exactPurl} does not hash to the ` +
        `published ${artifact.digest}`,
    );

  const pin: PluginPin = {
    id: '', // filled from the validated manifest below
    name,
    exactPurl: artifact.exactPurl,
    storeDigest: artifact.digest,
    treeDigest: '',
    manifestPath: PLUGIN_MANIFEST_NAME,
    installedAt: now(),
    format: inferFormat(artifact.uri, artifact.mediaType),
  };
  return materializeAndPin(
    root,
    indexPath,
    index,
    pin,
    {
      exactPurl: artifact.exactPurl,
      bytes: artifact.bytes,
      format: pin.format,
    },
    now,
    { alreadyInstalled: false, cached: false },
  );
}

interface VerifiedArtifactInput {
  exactPurl: string;
  bytes: Uint8Array;
  format: ArchiveFormat;
}

/**
 * Validate the artifact shape, materialize it, re-verify the published bytes,
 * and record the pin. The manifest is validated *before* anything is written
 * and re-hashed *after* publication, so a malformed or swapped plugin fails at
 * `plugin add` rather than at first use.
 */
async function materializeAndPin(
  root: string,
  indexPath: string,
  index: PluginIndex,
  pin: PluginPin,
  artifact: VerifiedArtifactInput,
  now: () => string,
  flags: { alreadyInstalled: boolean; cached: boolean },
): Promise<InstalledPlugin> {
  const inspected = await inspectPluginArtifact(artifact);
  pin.id = inspected.manifest.id;
  const storeKey = storeKeyFromDigest(pin.storeDigest);
  const storePath = join(root, storeKey);

  // Content-addressed: an existing entry with this name is either the same
  // content or corrupt; never trust orphan state — replace it atomically.
  if (await entryExists(storePath)) await removeStableTree(storePath);
  const descriptor = await descriptorForBytes({
    bytes: artifact.bytes,
    descriptorId: storeKey,
    mediaType: mediaTypeForFormat(pin.format),
    artifactType: 'package',
    nativeRole: 'native-package',
  });
  const source: ArtifactSource = {
    async stat(descriptor) {
      return { descriptor, rangeSupported: false };
    },
    async open() {
      return streamFromBytes(artifact.bytes);
    },
    async listReferrers() {
      return [];
    },
  };
  const result = await materialize({
    source,
    descriptor,
    destination: storePath,
    format: artifact.format,
    limits: PLUGIN_ARCHIVE_LIMITS,
  });

  // Re-verify the materialized tree against the archive entries that were
  // validated: same file set, same per-file digests.
  const expected = new Map(
    [inspected.manifestEntry, inspected.executableEntry].map((entry) => [
      entry.path,
      sha256Hex(entry.data),
    ]),
  );
  const published = new Map(
    result.files.map((file) => [file.path, file.digest.value]),
  );
  if (
    published.size !== expected.size ||
    [...expected].some(([path, digest]) => published.get(path) !== digest)
  )
    throw new OpmError(
      'DIGEST_MISMATCH',
      `Materialized plugin entry for ${pin.exactPurl} does not match the verified artifact`,
    );
  const publishedManifest = await readStableFile(
    join(storePath, PLUGIN_MANIFEST_NAME),
  );
  if (
    sha256Hex(new TextEncoder().encode(publishedManifest)) !==
    expected.get(PLUGIN_MANIFEST_NAME)
  )
    throw new OpmError(
      'DIGEST_MISMATCH',
      `Published plugin manifest for ${pin.exactPurl} does not match the verified artifact`,
    );
  pin.treeDigest = await stableStoreTreeDigest(storePath);

  // Cache the verified artifact bytes so the pinned entry can be repaired
  // offline; read-only, like the project store's `.artifact` cache.
  await writeStableFile(`${storePath}.artifact`, artifact.bytes, 0o444);

  index.plugins[pin.name] = { ...pin };
  await writePluginIndex(indexPath, index);
  return toInstalled(root, pin, flags.alreadyInstalled, flags.cached);
}

interface InspectedPluginArtifact {
  manifest: DelegatedAdapterManifest;
  manifestEntry: InspectedArchiveEntry;
  executableEntry: InspectedArchiveEntry;
}

/**
 * A plugin artifact is exactly `plugin.json` plus the one executable the
 * manifest declares — both regular files at the archive root. The
 * materializer has already refused traversal, links and special files; this
 * enforces the plugin shape on top.
 */
async function inspectPluginArtifact(
  artifact: VerifiedArtifactInput,
): Promise<InspectedPluginArtifact> {
  const entries = await inspectArchive(
    artifact.bytes,
    artifact.format,
    PLUGIN_ARCHIVE_LIMITS,
  );
  const invalid = (message: string): OpmError =>
    new OpmError(
      'INVALID_PLUGIN_ARTIFACT',
      `Plugin artifact for ${artifact.exactPurl} ${message}`,
    );
  if (entries.some((entry) => entry.type !== 'file'))
    throw invalid('must contain regular files only (no directories or links)');
  const files = entries.filter((entry) => entry.type === 'file');
  const manifestEntry = files.find(
    (entry) => entry.path === PLUGIN_MANIFEST_NAME,
  );
  if (manifestEntry === undefined)
    throw invalid(`must contain ${PLUGIN_MANIFEST_NAME}`);
  const executables = files.filter(
    (entry) => entry.path !== PLUGIN_MANIFEST_NAME,
  );
  let manifestText: string;
  try {
    manifestText = new TextDecoder('utf-8', { fatal: true }).decode(
      manifestEntry.data,
    );
  } catch {
    throw new OpmError(
      'INVALID_PLUGIN_MANIFEST',
      `Plugin manifest in ${artifact.exactPurl} is not valid UTF-8`,
    );
  }
  const parsed = parseAndValidateContract(MANIFEST_SCHEMA, manifestText);
  if (!parsed.valid || parsed.value === undefined)
    throw new OpmError(
      'INVALID_PLUGIN_MANIFEST',
      `Plugin manifest in ${artifact.exactPurl} does not match ${MANIFEST_SCHEMA}: ` +
        parsed.errors
          .map(
            (error) =>
              `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
          )
          .join('; '),
    );
  const manifest = parsed.value as unknown as DelegatedAdapterManifest;
  if (executables.length !== 1 || executables[0]!.path !== manifest.executable)
    throw invalid(
      `must contain exactly one executable, named "${manifest.executable}" ` +
        `as the manifest declares (found: ${executables.map((entry) => entry.path).join(', ') || 'none'})`,
    );
  const executableEntry = executables[0]!;
  if ((executableEntry.mode & 0o111) === 0)
    throw invalid(
      `executable entry "${manifest.executable}" is not marked executable`,
    );
  return { manifest, manifestEntry, executableEntry };
}

export async function removePlugin(
  name: string,
  options: PluginStoreOptions = {},
): Promise<PluginPin> {
  const parsed = parsePluginName(name);
  const root = options.storeRoot ?? pluginStoreRoot();
  await ensureStableDirectory(root);
  const indexPath = join(root, PLUGIN_INDEX_NAME);
  const index = await readPluginIndex(indexPath);
  const pin = index.plugins[parsed];
  if (pin === undefined)
    throw new OpmError(
      'PLUGIN_NOT_INSTALLED',
      `Plugin "${parsed}" is not installed. ` +
        `Installed: ${Object.keys(index.plugins).sort().join(', ') || '(none)'}.`,
    );
  const storePath = join(root, storeKeyFromDigest(pin.storeDigest));
  await removeStableTree(storePath);
  await removeStableFile(`${storePath}.artifact`);
  delete index.plugins[parsed];
  await writePluginIndex(indexPath, index);
  return pin;
}

export async function listPlugins(
  options: PluginStoreOptions = {},
): Promise<readonly ListedPlugin[]> {
  const root = options.storeRoot ?? pluginStoreRoot();
  await ensureStableDirectory(root);
  const index = await readPluginIndex(join(root, PLUGIN_INDEX_NAME));
  const listed: ListedPlugin[] = [];
  for (const name of Object.keys(index.plugins).sort()) {
    const pin = index.plugins[name]!;
    const storePath = join(root, storeKeyFromDigest(pin.storeDigest));
    listed.push({
      ...pin,
      storePath,
      present: await entryExists(storePath),
    });
  }
  return listed;
}

async function entryExists(storePath: string): Promise<boolean> {
  const info = await lstat(storePath).catch(() => undefined);
  return info !== undefined && info.isDirectory() && !info.isSymbolicLink();
}

/** The pinned entry is present and its tree still digests to the pin. */
async function verifyEntry(root: string, pin: PluginPin): Promise<boolean> {
  const storePath = join(root, storeKeyFromDigest(pin.storeDigest));
  if (!(await entryExists(storePath))) return false;
  try {
    return (await stableStoreTreeDigest(storePath)) === pin.treeDigest;
  } catch {
    return false;
  }
}

async function readCachedArtifact(
  root: string,
  pin: PluginPin,
): Promise<VerifiedArtifactInput | undefined> {
  const archivePath = `${join(root, storeKeyFromDigest(pin.storeDigest))}.artifact`;
  let bytes: Uint8Array;
  try {
    bytes = await readStableFileBytes(archivePath, 64 * 1024 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (digestOf(bytes) !== pin.storeDigest)
    throw new OpmError(
      'DIGEST_MISMATCH',
      `Cached artifact for ${pin.exactPurl} does not hash to the pinned ${pin.storeDigest}`,
    );
  return { exactPurl: pin.exactPurl, bytes, format: pin.format };
}

function toInstalled(
  root: string,
  pin: PluginPin,
  alreadyInstalled: boolean,
  cached: boolean,
): InstalledPlugin {
  return {
    ...pin,
    storePath: join(root, storeKeyFromDigest(pin.storeDigest)),
    alreadyInstalled,
    cached,
  };
}

async function readPluginIndex(indexPath: string): Promise<PluginIndex> {
  let text: string;
  try {
    text = await readStableFile(indexPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { pluginStoreVersion: 1, plugins: {} };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new OpmError(
      'INVALID_STATE',
      `Plugin index is not JSON: ${indexPath}`,
    );
  }
  return validatePluginIndex(value, indexPath);
}

function validatePluginIndex(value: unknown, indexPath: string): PluginIndex {
  const invalid = (message: string): OpmError =>
    new OpmError(
      'INVALID_STATE',
      `Invalid plugin index ${indexPath}: ${message}`,
    );
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalid('must be an object');
  const record = value as Record<string, unknown>;
  if (record.pluginStoreVersion !== 1)
    throw invalid('pluginStoreVersion must be 1');
  const rawPlugins = record.plugins;
  if (
    rawPlugins === null ||
    typeof rawPlugins !== 'object' ||
    Array.isArray(rawPlugins)
  )
    throw invalid('plugins must be an object');
  const plugins: Record<string, PluginPin> = {};
  for (const [name, raw] of Object.entries(rawPlugins)) {
    parsePluginName(name);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw invalid(`plugins.${name} must be an object`);
    const pin = raw as Record<string, unknown>;
    for (const field of [
      'id',
      'name',
      'exactPurl',
      'storeDigest',
      'treeDigest',
      'manifestPath',
      'installedAt',
      'format',
    ] as const)
      if (typeof pin[field] !== 'string' || pin[field] === '')
        throw invalid(`plugins.${name}.${field} must be a non-empty string`);
    const typed = pin as unknown as PluginPin;
    if (typed.name !== name)
      throw invalid(`plugins.${name}.name is contradictory`);
    if (!typed.exactPurl.startsWith(`pkg:${PLUGIN_PURL_TYPE}/`))
      throw invalid(
        `plugins.${name}.exactPurl must be a pkg:${PLUGIN_PURL_TYPE}/ purl`,
      );
    assertDigest(typed.storeDigest);
    assertDigest(typed.treeDigest);
    if (typed.manifestPath !== PLUGIN_MANIFEST_NAME)
      throw invalid(
        `plugins.${name}.manifestPath must be ${PLUGIN_MANIFEST_NAME}`,
      );
    if (!Number.isFinite(Date.parse(typed.installedAt)))
      throw invalid(`plugins.${name}.installedAt must be a timestamp`);
    if (!['tar', 'tar+gzip', 'zip'].includes(typed.format))
      throw invalid(`plugins.${name}.format is not an archive format`);
    assertSafeSegment(storeKeyFromDigest(typed.storeDigest), 'store key');
    plugins[name] = typed;
  }
  return { pluginStoreVersion: 1, plugins };
}

async function writePluginIndex(
  indexPath: string,
  index: PluginIndex,
): Promise<void> {
  await writeStableFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function mediaTypeForFormat(format: ArchiveFormat): string {
  switch (format) {
    case 'tar':
      return 'application/x-tar';
    case 'tar+gzip':
      return 'application/gzip';
    case 'zip':
      return 'application/zip';
  }
}

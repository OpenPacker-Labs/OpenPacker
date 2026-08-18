import { canonicalProjectionDigest, formatDigest } from '@openpacker/canonical';
import { DIGEST_PROJECTIONS, type JsonValue } from '@openpacker/contracts';
import type {
  Distribution,
  PackageIdentity,
  PackageInstance,
  PackageManifest,
  NormalizedPackManifest,
  PackReceipt,
  SemanticLoss,
  SourceSnapshot,
  VersionConstraint,
} from '@openpacker/contracts';

/** Ecosystems with a codec in this repository. */
export type KnownEcosystem =
  | 'npm'
  | 'cargo'
  | 'nuget'
  | 'pypi'
  | 'golang'
  | 'maven'
  | 'nix';

/**
 * A PURL type. The known set above keeps editor completion and catches typos
 * in this repository, while any lowercase PURL type is accepted so that a
 * codec can be registered out of tree without patching this union — the
 * schemas have always allowed any type, and this is what lets that reach the
 * daemon.
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export type Ecosystem = KnownEcosystem | (string & {});

/** PURL types are lowercase alphanumerics plus `.`, `+`, and `-`. */
export const ECOSYSTEM_PATTERN = /^[a-z0-9.+-]+$/u;

export function isEcosystem(value: string): boolean {
  return ECOSYSTEM_PATTERN.test(value);
}

export interface NativeCoordinate {
  ecosystem: Ecosystem;
  name: string;
  namespace?: string | undefined;
  version?: string | undefined;
  original: string;
}

export interface ParsedVersion {
  original: string;
  normalized: string;
  release: readonly number[];
  prerelease: readonly (number | string)[];
  build: readonly string[];
}

export type RangeAst =
  | { type: 'any' }
  | {
      type: 'comparison';
      operator: '=' | '!=' | '>' | '>=' | '<' | '<=';
      version: string;
    }
  | { type: 'and' | 'or'; items: readonly RangeAst[] };

export interface ParsedRange {
  scheme: Ecosystem;
  original: string;
  normalized: string;
  ast: RangeAst;
  vers?: string;
  reversible: boolean;
  semanticLoss: readonly SemanticLoss[];
}

export function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface TranslatedMetadata {
  instance: PackageInstance;
  rawMetadata: unknown;
}

export interface LockCapture {
  format: string;
  formatVersion: string;
  sourceDigest?: string;
  packages: readonly {
    exactPurl: string;
    nativeCoordinate: string;
    resolved?: string;
    artifactDigest?: string;
    dependencies: Readonly<Record<string, string>>;
    native: unknown;
  }[];
  semanticLoss: readonly SemanticLoss[];
}

export interface EcosystemCodec<Metadata = unknown, Lock = unknown> {
  readonly purlType: Ecosystem;
  parseNativeCoordinate(value: string): NativeCoordinate;
  canonicalizePurl(value: string): string;
  parseNativeVersion(value: string): ParsedVersion;
  compareNativeVersions(left: string, right: string): number;
  parseNativeRange(value: string): ParsedRange;
  toVers(value: string): VersionConstraint;
  satisfies(version: string, range: string | ParsedRange): boolean;
  translateMetadata(
    metadata: Metadata,
    provenance: TranslationProvenance,
  ): Promise<TranslatedMetadata>;
  translateLockResult(
    lock: Lock,
    provenance: TranslationProvenance,
  ): LockCapture;
}

export interface ProviderCapabilities {
  readonly operations: readonly (
    | 'identify'
    | 'enumerate'
    | 'inspect'
    | 'artifact'
    | 'snapshot'
    | 'enrich'
    // Side-effecting classes. A provider that lists these is stating that it
    // changes the host, which is what lets system package managers plug in at
    // all; one that omits them is stating it does not.
    | 'install'
    | 'run'
  )[];
  readonly purlTypes: readonly Ecosystem[];
  readonly qualifierSupport: 'complete' | 'partial' | 'none';
  readonly targetSpecificSemantics: boolean;
  readonly offlineReplay: boolean;
  readonly extensions: Readonly<Record<string, unknown>>;
}

export interface ProviderRecord<T = unknown> {
  key: string;
  endpoint: string;
  etag?: string | undefined;
  revision?: string | undefined;
  body: T;
  rawBody: Uint8Array;
  retrievedAt: string;
}

export interface ProviderInspection {
  package: PackageInstance;
  record: ProviderRecord;
  warnings: readonly ProviderWarning[];
}

export interface ProviderWarning {
  code: string;
  message: string;
  path?: string;
}

export interface CatalogProvider {
  readonly providerId: string;
  readonly capabilities: ProviderCapabilities;
  identify(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly PackageIdentity[]>;
  enumerate(basePurl: string, signal?: AbortSignal): Promise<readonly string[]>;
  inspect(exactPurl: string, signal?: AbortSignal): Promise<ProviderInspection>;
  fetchArtifactRecord(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord>;
  snapshot(
    evaluationTime: string,
    signal?: AbortSignal,
  ): Promise<SourceSnapshot>;
}

export interface EnrichmentResult {
  subjectPurl: string;
  providerId: string;
  extensions: Readonly<Record<string, unknown>>;
  source: ProviderRecord;
  warnings: readonly ProviderWarning[];
  semanticLoss: readonly SemanticLoss[];
}

/**
 * How a package manager that installs onto the host plugs into PREX.
 *
 * apt, winget, nix and the ecosystem runners (`npx`, `pipx`, `uvx`, `dnx`)
 * cannot be modelled as pure metadata: doing their job means changing
 * something. A `CatalogProvider` answers "what is this and where does it come
 * from"; this answers "make it present", and says honestly what it can and
 * cannot promise about the result.
 *
 * Implementations are expected to shell out to the native tool. That is the
 * point — PREX is the interface, not a reimplementation of every installer.
 */
export interface InstallerProvider {
  readonly providerId: string;
  readonly capabilities: ProviderCapabilities;

  /**
   * Whether this provider can act on this host right now.
   *
   * Separate from `capabilities` because the answer is environmental: winget
   * on Linux, apt on Windows, or a missing binary. Reported rather than
   * thrown, so a caller can choose another provider.
   */
  available(signal?: AbortSignal): Promise<InstallerAvailability>;

  /** What would happen, without doing it. */
  plan(exactPurl: string, options?: InstallOptions): Promise<InstallPlan>;

  /**
   * Perform the installation.
   *
   * The result records the command actually run, because a system install is
   * not content-addressed and the receipt is the only account of it.
   */
  install(exactPurl: string, options?: InstallOptions): Promise<InstallOutcome>;
}

export interface InstallerAvailability {
  available: boolean;
  /** Why not, when unavailable — a missing tool, wrong platform, no privilege. */
  reason?: string;
  /** The native tool this provider drives, when it found one. */
  tool?: { name: string; version?: string; path?: string };
}

export interface InstallOptions {
  /** Refuse anything that would touch the network. */
  offline?: boolean;
  /** Do not perform the change; report what would happen. */
  dryRun?: boolean;
  /**
   * Consent to a change that requires elevation.
   *
   * Off by default. A system-wide install is not something to perform because
   * a PURL happened to name a system package.
   */
  allowElevation?: boolean;
  signal?: AbortSignal;
  /** Where a provider that can install without root should put things. */
  prefix?: string;
  /**
   * Sandbox policy for the install process (ADR 0036).
   * When omitted, implementations should fail closed unless
   * allowHostUnsandboxedInstall is true.
   */
  sandbox?: {
    mode?: 'fail-closed' | 'degrade-warn' | 'off';
    prefer?: 'auto' | 'mxc' | 'native';
    allowHostUnsandboxedInstall?: boolean;
  };
}

export interface InstallPlan {
  exactPurl: string;
  /** The exact argv this would run, so a caller can show it before consenting. */
  command: readonly string[];
  /** True when the command needs root or administrator rights. */
  requiresElevation: boolean;
  /** True when the change cannot be undone by PREX's own generation ledger. */
  irreversible: boolean;
  /**
   * What this provider cannot promise about the outcome.
   *
   * A system installer runs vendor scripts and mutates paths PREX does not
   * own, so claims like byte-verification and rollback do not survive. Saying
   * so is the difference between a plug-in point and an overclaim.
   */
  semanticLoss: readonly SemanticLoss[];
  /**
   * How the install would be sandboxed, when known.
   * Absent means the provider has not yet adopted the sandbox funnel.
   */
  sandbox?: {
    mode: 'fail-closed' | 'degrade-warn' | 'off';
    prefer: 'auto' | 'mxc' | 'native';
    willEnforce: boolean;
  };
}

export interface InstallOutcome extends InstallPlan {
  performed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** When the native tool reports what it settled on, the resolved version. */
  installedVersion?: string;
  /** Backend that enforced (or failed to enforce) the install jail. */
  sandboxBackend?: string;
  sandboxEnforced?: boolean;
}

/**
 * Read and write the project files an ecosystem's own tooling reads.
 *
 * `opm.toml` is what opm decides from, but nothing else in a project reads it:
 * an IDE, a CI job and `dotnet build` all read `package.json` or the `.csproj`.
 * A `ProjectFormat` projects opm's decisions into those files so using opm
 * leaves a project the native toolchain still understands.
 *
 * This is ecosystem knowledge, so it lives in the adapter — core never learns
 * what a `.csproj` is. Which levels an adapter implements is discoverable from
 * its Registry Definition (`prex.registry.project-manifest/1` and siblings);
 * an absent level means the projection does not happen, not that it silently
 * half-happens.
 */
export interface ProjectFormat {
  readonly providerId: string;
  /** PURL type whose requirements this format carries. */
  readonly purlType: Ecosystem;

  /**
   * The files in `root` this format owns, or undefined when `root` is not a
   * project of this kind. Detection is a filesystem question, so it is asked
   * rather than assumed from the manifest's ecosystem list.
   */
  detect(root: string): Promise<DetectedProject | undefined>;

  /**
   * Requirements the native manifest declares.
   *
   * Not used to decide anything yet — `opm.toml` is authoritative — but it is
   * what a later `opm import --native` and any drift report need, and writing
   * a format without being able to read it back is how round-trip bugs hide.
   */
  readRequirements(
    project: DetectedProject,
  ): Promise<readonly NativeRequirement[]>;

  /** Project opm's requirement set into the native manifest. */
  writeManifest(
    project: DetectedProject,
    requirements: readonly NativeRequirement[],
    options?: WriteManifestOptions,
  ): Promise<ProjectionResult>;

  /** Project the resolved closure into the native lockfile. */
  writeLockfile?(
    project: DetectedProject,
    packages: readonly NativeLockEntry[],
  ): Promise<ProjectionResult>;

  /** Project the content-addressed store into the native install layout. */
  writeLayout?(
    project: DetectedProject,
    packages: readonly NativeLockEntry[],
  ): Promise<ProjectionResult>;

  /**
   * Build the archive this ecosystem publishes — an npm `.tgz`, a NuGet
   * `.nupkg`. Advertised via `prex.registry.package-build/1`.
   */
  pack?(
    project: DetectedProject,
    options?: PackProjectOptions,
  ): Promise<PackedArtifact>;
}

export interface PackProjectOptions {
  /** Directory the archive is written to. Defaults to the project root. */
  outputDirectory?: string;
}

export interface PackedArtifact {
  /** Absolute path of the archive written. */
  path: string;
  /** `pkg:npm/name@version` for what was packed. */
  exactPurl: string;
  mediaType: string;
  size: number;
  /** sha256 over the archive bytes, the same identity any other artifact has. */
  digest: string;
  semanticLoss: readonly SemanticLoss[];
}

/**
 * Version 2 package-build boundary.
 *
 * Unlike the legacy `ProjectFormat.pack`, this is a capability in its own
 * right: OCI, Nix and system packaging formats may be packable without also
 * being project-manifest projection formats, and one pack can yield several
 * native artifacts.
 */
export interface PackagePacker {
  readonly providerId: string;
  readonly purlType: Ecosystem;
  available(options?: PackOptions): Promise<PackAvailability>;
  detect(root: string): Promise<DetectedProject | undefined>;
  /** Adapter-owned publish selection used by the normalized capture. */
  capturePaths?(project: DetectedProject): Promise<readonly string[]>;
  plan(input: PackInput, options?: PackOptions): Promise<PackPlan>;
  pack(input: PackInput, options?: PackOptions): Promise<PackOutcome>;
}

export interface PackInput {
  project: DetectedProject;
  /** Optional common package document used for cross-target packing. */
  manifest?: PackageManifest;
  /** The target entry must be explicit when it differs from the source. */
  target?: Distribution;
  /** Internal OCI-based representation consumed by standardized emitters. */
  normalized?: NormalizedPackInput;
}

export interface NormalizedPackInput {
  manifest: NormalizedPackManifest;
  files: readonly NormalizedPackFile[];
}

export interface NormalizedPackFile {
  path: string;
  contents: Uint8Array;
  executable: boolean;
}

export interface PackOptions {
  /** Directory receiving every native artifact and the pack receipt. */
  outputDirectory?: string;
  /** Native delegate now; standardized emitters are added by package-build/2. */
  strategy?: 'delegate' | 'standard';
  /** Select one native implementation from an adapter's supported tool family. */
  tool?: string;
  /** Permit a native command to compile or execute project-controlled code. */
  allowBuild?: boolean;
  /** Permit network access independently from build consent. */
  allowNetwork?: boolean;
  /** Refuse network even when allowNetwork is also set. */
  offline?: boolean;
  /** Return the exact plan without running it. */
  dryRun?: boolean;
  signal?: AbortSignal;
  sandbox?: InstallOptions['sandbox'];
}

export interface PackAvailability {
  available: boolean;
  reason?: string;
  tool?: { name: string; version?: string; path?: string };
}

export interface PackPlan {
  strategy: 'delegate' | 'standard';
  purlType: Ecosystem;
  /** First command, retained for package-build/1-compatible displays. */
  command?: readonly string[];
  /** Ordered native commands when packing is not a single process. */
  commands?: readonly (readonly string[])[];
  /** Commands attempted after execution to retire temporary native state. */
  cleanupCommands?: readonly (readonly string[])[];
  tool?: { name: string; version?: string; path?: string };
  requiresBuild: boolean;
  requiresNetwork: boolean;
  expectedRoles: readonly string[];
  semanticLoss: readonly SemanticLoss[];
}

export interface PackArtifact {
  path: string;
  /** Present when the native tool reports package identity authoritatively. */
  exactPurl?: string;
  mediaType: string;
  size: number;
  digest: string;
  nativeRole: string;
  outputName?: string;
}

export interface PackOutcome extends PackPlan {
  performed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  artifacts: readonly PackArtifact[];
  sandboxBackend?: string;
  sandboxEnforced?: boolean;
  receipt?: PackReceipt;
}

export interface WriteManifestOptions {
  /**
   * Native names to remove if present.
   *
   * A projection cannot simply delete everything it did not write: a project
   * may hold dependencies a person added by hand, and treating the requirement
   * set as an allowlist would silently delete them. The host tracks what it
   * previously wrote and names it here, so removal is limited to what opm
   * itself put there.
   */
  retire?: readonly string[];
}

export interface DetectedProject {
  /** Project root as given. */
  root: string;
  /**
   * The manifest this format writes, absolute.
   *
   * One path, not a set: a format that finds two candidates has to choose, and
   * choosing is ecosystem knowledge (a `.csproj` next to a `Directory.Build.props`
   * is not ambiguous to NuGet).
   */
  manifestPath: string;
  /** Other files the format reads or writes, absolute. */
  relatedPaths?: Readonly<Record<string, string>>;
  /** Free-form facts the format needs between calls (target frameworks, CPM). */
  metadata?: Readonly<Record<string, unknown>>;
}

export type RequirementScope =
  | 'runtime'
  | 'development'
  | 'optional'
  | 'peer'
  | 'build';

export interface NativeRequirement {
  /** Base PURL, no version. */
  purl: string;
  /** Native name as this ecosystem spells it (`@scope/name`, `Newtonsoft.Json`). */
  name: string;
  /** Native range or exact pin, in the ecosystem's own grammar. */
  range?: string;
  scope: RequirementScope;
}

export interface NativeLockEntry extends NativeRequirement {
  exactPurl: string;
  version: string;
  /** Where the bytes came from. */
  source: string;
  /** PREX digest of the archive, always sha256. */
  digest: string;
  size: number;
  /**
   * The ecosystem's own integrity value over the same bytes, when it was
   * captured. npm wants SRI, NuGet wants base64 sha512, Cargo wants sha256
   * hex — a native lockfile written with the wrong one is worse than no
   * lockfile, so its absence has to be visible here.
   */
  nativeIntegrity?: { algorithm: string; value: string; encoding: string };
  /** Absolute path of the extracted tree in the opm store, when materialised. */
  storePath?: string;
  /** True for a package no requirement named directly. */
  transitive: boolean;
}

/**
 * What a projection did, and what it could not promise.
 *
 * `semanticLoss` is the honest half: a format that cannot express a scope, or
 * cannot write a build DSL, says so here instead of producing a file that
 * differs from what the native tool would have written without telling anyone.
 */
export interface ProjectionResult {
  /** Absolute paths written, in the order they were written. */
  written: readonly string[];
  /** Paths deliberately left alone, with why. */
  skipped?: readonly { path: string; reason: string }[];
  semanticLoss: readonly SemanticLoss[];
}

export interface EnrichmentProvider {
  readonly providerId: string;
  readonly capabilities: ProviderCapabilities;
  enrich(exactPurl: string, signal?: AbortSignal): Promise<EnrichmentResult>;
}

export interface CredentialResolver {
  resolve(
    secretReference: string,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, string>>>;
}

export interface TranslationProvenance {
  providerId: string;
  endpoint: string;
  retrievedAt: string;
  evaluationTime: string;
  etag?: string;
  revision?: string;
  snapshotDigest?: { algorithm: 'sha256'; value: string };
  metadataDigest: { algorithm: 'sha256'; value: string };
  rawMetadataRef?: {
    type: string;
    locator: string;
    digest?: { algorithm: 'sha256'; value: string };
    mediaType?: string;
  };
}

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'HEAD' | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
  signal?: AbortSignal | undefined;
  maximumBytes?: number | undefined;
}

export interface HttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  url: string;
}

export interface HttpTransport {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export interface BoundedFetchOptions {
  allowedOrigins: readonly string[];
  maximumBytes?: number;
  maximumRedirects?: number;
  maximumRetries?: number;
  maximumRetryDelayMilliseconds?: number;
  fetch?: typeof fetch;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
]);

export class BoundedFetchTransport implements HttpTransport {
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #fetch: typeof fetch;
  readonly #delay: NonNullable<BoundedFetchOptions['delay']>;
  readonly #maximumBytes: number;
  readonly #maximumRedirects: number;
  readonly #maximumRetries: number;
  readonly #maximumRetryDelayMilliseconds: number;

  constructor(options: BoundedFetchOptions) {
    this.#allowedOrigins = new Set(
      options.allowedOrigins.map(normalizeAllowedOrigin),
    );
    if (this.#allowedOrigins.size === 0)
      throw new ProviderError(
        'INVALID_PROVIDER_ENDPOINT',
        'Provider transport requires at least one allowed origin',
      );
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#delay = options.delay ?? abortableDelay;
    this.#maximumBytes = options.maximumBytes ?? 128 * 1024 * 1024;
    this.#maximumRedirects = options.maximumRedirects ?? 5;
    this.#maximumRetries = options.maximumRetries ?? 2;
    this.#maximumRetryDelayMilliseconds =
      options.maximumRetryDelayMilliseconds ?? 1_000;
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    let url = parseProviderUrl(request.url);
    assertAllowedProviderUrl(url, this.#allowedOrigins);
    let method = request.method ?? 'GET';
    let headers = { ...(request.headers ?? {}) };
    const limit = Math.min(
      request.maximumBytes ?? this.#maximumBytes,
      this.#maximumBytes,
    );
    let redirects = 0;
    let retries = 0;
    for (;;) {
      throwIfAborted(request.signal);
      const response = await this.#fetch(url, {
        method,
        headers,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        redirect: 'manual',
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location)
          throw new ProviderError(
            'UPSTREAM_UNAVAILABLE',
            `Redirect ${response.status} omitted Location`,
            response.status,
          );
        if (redirects >= this.#maximumRedirects)
          throw new ProviderError(
            'UPSTREAM_UNAVAILABLE',
            `Provider exceeded ${this.#maximumRedirects} redirects`,
            response.status,
          );
        const next = parseProviderUrl(location, url);
        assertAllowedProviderUrl(next, this.#allowedOrigins);
        if (url.protocol === 'https:' && next.protocol !== 'https:')
          throw new ProviderError(
            'UPSTREAM_UNAVAILABLE',
            'Provider redirect attempted an HTTPS downgrade',
            response.status,
          );
        if (next.origin !== url.origin)
          headers = stripSensitiveHeaders(headers);
        if (response.status === 303) method = 'GET';
        url = next;
        redirects += 1;
        continue;
      }
      if (
        RETRY_STATUSES.has(response.status) &&
        retries < this.#maximumRetries
      ) {
        const retryAfter = retryDelayMilliseconds(
          response.headers.get('retry-after'),
          retries,
          this.#maximumRetryDelayMilliseconds,
        );
        await response.body?.cancel();
        retries += 1;
        await this.#delay(retryAfter, request.signal);
        continue;
      }
      if (
        response.status !== 304 &&
        (response.status < 200 || response.status >= 300)
      ) {
        await response.body?.cancel();
        throw providerErrorForStatus(response.status);
      }
      const body = await readBoundedBody(response, limit, request.signal);
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
        url: response.url || url.toString(),
      };
    }
  }
}

function normalizeAllowedOrigin(value: string): string {
  const url = parseProviderUrl(value);
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw new ProviderError(
      'INVALID_PROVIDER_ENDPOINT',
      `Allowed provider origin must be an HTTP(S) origin: ${value}`,
    );
  return url.origin;
}

function parseProviderUrl(value: string, base?: URL): URL {
  try {
    return new URL(value, base);
  } catch {
    throw new ProviderError(
      'INVALID_PROVIDER_ENDPOINT',
      'Provider URL is invalid',
    );
  }
}

function assertAllowedProviderUrl(
  url: URL,
  allowedOrigins: ReadonlySet<string>,
): void {
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    !allowedOrigins.has(url.origin)
  )
    throw new ProviderError(
      'INVALID_PROVIDER_ENDPOINT',
      `Provider origin is not allowed: ${url.origin}`,
    );
}

export function providerErrorForStatus(status: number): ProviderError {
  if (status === 404)
    return new ProviderError(
      'PACKAGE_NOT_FOUND',
      'Upstream resource was not found',
      status,
    );
  if (status === 429)
    return new ProviderError(
      'RATE_LIMITED',
      'Upstream rate limit exceeded',
      status,
    );
  return new ProviderError(
    'UPSTREAM_UNAVAILABLE',
    `Upstream returned ${status}`,
    status,
  );
}

function stripSensitiveHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !SENSITIVE_HEADERS.has(name.toLowerCase()),
    ),
  );
}

function retryDelayMilliseconds(
  retryAfter: string | null,
  attempt: number,
  maximum: number,
): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(seconds * 1_000, maximum);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date))
      return Math.min(Math.max(date - Date.now(), 0), maximum);
  }
  return Math.min(100 * 2 ** attempt, maximum);
}

async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (milliseconds === 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(
          signal.reason ?? new ProviderError('CANCELLED', 'Request cancelled'),
        );
      },
      { once: true },
    );
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason ?? new ProviderError('CANCELLED', 'Request cancelled');
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maximumBytes) {
    await response.body?.cancel();
    throw new ProviderError(
      'UPSTREAM_RESPONSE_TOO_LARGE',
      `Response exceeds ${maximumBytes} bytes`,
      response.status,
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes)
        throw new ProviderError(
          'UPSTREAM_RESPONSE_TOO_LARGE',
          `Response exceeds ${maximumBytes} bytes`,
          response.status,
        );
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export interface Clock {
  now(): string;
}

export class FixtureHttpTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  readonly #counts = new Map<string, number>();

  constructor(
    private readonly fixtures: ReadonlyMap<
      string,
      | Omit<HttpResponse, 'url'>
      | HttpResponse
      | readonly (Omit<HttpResponse, 'url'> | HttpResponse)[]
    >,
  ) {}

  async request(request: HttpRequest): Promise<HttpResponse> {
    if (request.signal?.aborted)
      throw request.signal.reason ?? new Error('request cancelled');
    this.requests.push(request);
    const configured = this.fixtures.get(request.url);
    if (!configured)
      throw new ProviderError(
        'PACKAGE_NOT_FOUND',
        `No fixture for ${request.url}`,
      );
    const count = this.#counts.get(request.url) ?? 0;
    this.#counts.set(request.url, count + 1);
    const fixture = Array.isArray(configured)
      ? configured[Math.min(count, configured.length - 1)]
      : configured;
    if (fixture === undefined)
      throw new ProviderError(
        'PACKAGE_NOT_FOUND',
        `No fixture response for ${request.url}`,
      );
    if (
      request.maximumBytes !== undefined &&
      fixture.body.byteLength > request.maximumBytes
    ) {
      throw new ProviderError(
        'UPSTREAM_RESPONSE_TOO_LARGE',
        `Response exceeds ${request.maximumBytes} bytes`,
      );
    }
    return { ...fixture, url: 'url' in fixture ? fixture.url : request.url };
  }
}

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface ParsedPurl {
  type: string;
  namespace?: string | undefined;
  name: string;
  version?: string | undefined;
  qualifiers: Readonly<Record<string, string>>;
  subpath?: string | undefined;
}

const decode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ProviderError(
      'INVALID_PURL',
      `Invalid percent encoding: ${value}`,
    );
  }
};

const encode = (value: string): string =>
  encodeURIComponent(value)
    .replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    .replace(/%[0-9a-f]{2}/g, (match) => match.toUpperCase());

export function parsePurl(value: string): ParsedPurl {
  if (value.length > 4096)
    throw new ProviderError('INVALID_PURL', 'PURL exceeds 4096 characters');
  if (!value.startsWith('pkg:'))
    throw new ProviderError('INVALID_PURL', 'PURL must start with pkg:');
  const hash = value.indexOf('#');
  const subpath = hash < 0 ? undefined : value.slice(hash + 1);
  const withoutSubpath = hash < 0 ? value : value.slice(0, hash);
  const query = withoutSubpath.indexOf('?');
  const queryText = query < 0 ? '' : withoutSubpath.slice(query + 1);
  const identity =
    query < 0 ? withoutSubpath.slice(4) : withoutSubpath.slice(4, query);
  const slash = identity.indexOf('/');
  if (slash <= 0)
    throw new ProviderError('INVALID_PURL', 'PURL requires a type and name');
  const type = identity.slice(0, slash).toLowerCase();
  const pathAndVersion = identity.slice(slash + 1);
  const at = pathAndVersion.lastIndexOf('@');
  const path = at < 0 ? pathAndVersion : pathAndVersion.slice(0, at);
  const version = at < 0 ? undefined : decode(pathAndVersion.slice(at + 1));
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0))
    throw new ProviderError('INVALID_PURL', 'PURL path has an empty segment');
  const namePart = segments.pop();
  if (!namePart) throw new ProviderError('INVALID_PURL', 'PURL name is empty');
  const qualifiers: Record<string, string> = {};
  for (const pair of queryText === '' ? [] : queryText.split('&')) {
    const separator = pair.indexOf('=');
    if (separator <= 0)
      throw new ProviderError('INVALID_PURL', `Invalid qualifier: ${pair}`);
    const key = decode(pair.slice(0, separator)).toLowerCase();
    if (key in qualifiers)
      throw new ProviderError('INVALID_PURL', `Duplicate qualifier: ${key}`);
    qualifiers[key] = decode(pair.slice(separator + 1));
  }
  const result: ParsedPurl = { type, name: decode(namePart), qualifiers };
  if (segments.length > 0) result.namespace = segments.map(decode).join('/');
  if (version !== undefined && version !== '') result.version = version;
  if (subpath !== undefined && subpath !== '')
    result.subpath = subpath.split('/').map(decode).join('/');
  return result;
}

export function formatPurl(purl: ParsedPurl): string {
  const path = [purl.namespace, purl.name]
    .filter((part): part is string => part !== undefined)
    .flatMap((part) => part.split('/'))
    .map(encode)
    .join('/');
  const version = purl.version === undefined ? '' : `@${encode(purl.version)}`;
  const qualifierEntries = Object.entries(purl.qualifiers).sort(
    ([left], [right]) => compareCodePoints(left, right),
  );
  const qualifiers =
    qualifierEntries.length === 0
      ? ''
      : `?${qualifierEntries.map(([key, entry]) => `${encode(key.toLowerCase())}=${encode(entry)}`).join('&')}`;
  const subpath =
    purl.subpath === undefined
      ? ''
      : `#${purl.subpath.split('/').filter(Boolean).map(encode).join('/')}`;
  return `pkg:${purl.type.toLowerCase()}/${path}${version}${qualifiers}${subpath}`;
}

export function parseSemver(
  value: string,
  maximumReleaseParts = 3,
): ParsedVersion {
  if (value.length > 256)
    throw new ProviderError(
      'INVALID_NATIVE_VERSION',
      'Version exceeds 256 characters',
    );
  const match =
    /^(?:v)?(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      value.trim(),
    );
  if (!match)
    throw new ProviderError(
      'INVALID_NATIVE_VERSION',
      `Invalid version: ${value}`,
    );
  const present = match
    .slice(1, 5)
    .filter((part): part is string => part !== undefined);
  if (present.length > maximumReleaseParts)
    throw new ProviderError(
      'INVALID_NATIVE_VERSION',
      `Too many release components: ${value}`,
    );
  const release = present.map(Number);
  while (release.length < maximumReleaseParts) release.push(0);
  const prerelease =
    match[5]
      ?.split('.')
      .map((part) => (/^(0|[1-9]\d*)$/.test(part) ? Number(part) : part)) ?? [];
  const build = match[6]?.split('.') ?? [];
  const normalized = `${release.join('.')}${prerelease.length === 0 ? '' : `-${prerelease.join('.')}`}${build.length === 0 ? '' : `+${build.join('.')}`}`;
  return { original: value, normalized, release, prerelease, build };
}

export function compareParsedVersions(
  left: ParsedVersion,
  right: ParsedVersion,
): number {
  for (
    let index = 0;
    index < Math.max(left.release.length, right.release.length);
    index += 1
  ) {
    const difference = (left.release[index] ?? 0) - (right.release[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
  }
  for (
    let index = 0;
    index < Math.max(left.prerelease.length, right.prerelease.length);
    index += 1
  ) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined || b === undefined)
      return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    if (typeof a === 'number' && typeof b === 'number') return Math.sign(a - b);
    if (typeof a === 'number') return -1;
    if (typeof b === 'number') return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function evaluateRange(
  version: string,
  ast: RangeAst,
  compare: (left: string, right: string) => number,
): boolean {
  switch (ast.type) {
    case 'any':
      return true;
    case 'and':
      return ast.items.every((item) => evaluateRange(version, item, compare));
    case 'or':
      return ast.items.some((item) => evaluateRange(version, item, compare));
    case 'comparison': {
      const order = compare(version, ast.version);
      if (ast.operator === '=') return order === 0;
      if (ast.operator === '!=') return order !== 0;
      if (ast.operator === '>') return order > 0;
      if (ast.operator === '>=') return order >= 0;
      if (ast.operator === '<') return order < 0;
      return order <= 0;
    }
  }
}

export function evaluateSemverRange(
  version: string,
  ast: RangeAst,
  compare: (left: string, right: string) => number,
): boolean {
  const parsed = parseSemver(version);
  if (parsed.prerelease.length === 0)
    return evaluateRange(version, ast, compare);

  const acceptsPrerelease = (expression: RangeAst): boolean => {
    if (expression.type === 'or')
      return expression.items.some(
        (item) =>
          evaluateRange(version, item, compare) && acceptsPrerelease(item),
      );
    if (!evaluateRange(version, expression, compare)) return false;
    const comparisons =
      expression.type === 'and'
        ? expression.items.filter(
            (item): item is Extract<RangeAst, { type: 'comparison' }> =>
              item.type === 'comparison',
          )
        : expression.type === 'comparison'
          ? [expression]
          : [];
    return comparisons.some((item) => {
      const boundary = parseSemver(item.version);
      return (
        boundary.prerelease.length > 0 &&
        boundary.release.every((part, index) => part === parsed.release[index])
      );
    });
  };

  return acceptsPrerelease(ast);
}

export interface SemverRangeOptions {
  scheme: 'npm' | 'cargo' | 'golang';
  bare: 'exact' | 'caret';
  commaAnd?: boolean;
  hyphenRanges?: boolean;
}

const comparison = (
  operator: '=' | '!=' | '>' | '>=' | '<' | '<=',
  version: string,
): RangeAst => ({
  type: 'comparison',
  operator,
  version,
});

const conjunction = (items: readonly RangeAst[]): RangeAst =>
  items.length === 0
    ? { type: 'any' }
    : items.length === 1
      ? items[0]!
      : { type: 'and', items };

function releaseText(
  release: readonly number[],
  prerelease: readonly (number | string)[] = [],
): string {
  return `${release.join('.')}${prerelease.length === 0 ? '' : `-${prerelease.join('.')}`}`;
}

function caretBounds(version: ParsedVersion): readonly RangeAst[] {
  const lower = releaseText(version.release, version.prerelease);
  const firstNonZero = version.release.findIndex((part) => part !== 0);
  const incrementAt =
    firstNonZero < 0 ? version.release.length - 1 : firstNonZero;
  const upper = version.release.map((part, index) =>
    index < incrementAt ? part : index === incrementAt ? part + 1 : 0,
  );
  return [comparison('>=', lower), comparison('<', releaseText(upper))];
}

function tildeBounds(
  version: ParsedVersion,
  specifiedParts: number,
): readonly RangeAst[] {
  const incrementAt = specifiedParts <= 1 ? 0 : 1;
  const upper = version.release.map((part, index) =>
    index < incrementAt ? part : index === incrementAt ? part + 1 : 0,
  );
  return [
    comparison('>=', releaseText(version.release, version.prerelease)),
    comparison('<', releaseText(upper)),
  ];
}

function parseRangeToken(
  token: string,
  options: SemverRangeOptions,
): readonly RangeAst[] {
  const operatorMatch = /^(<=|>=|!=|=|<|>|\^|~)?\s*(.*)$/.exec(token);
  if (!operatorMatch)
    throw new ProviderError(
      'INVALID_NATIVE_RANGE',
      `Invalid range token: ${token}`,
    );
  const operator = operatorMatch[1] ?? '';
  const rawVersion = operatorMatch[2]!.trim();
  if (rawVersion === '' || rawVersion === '*' || /^x$/i.test(rawVersion))
    return [];
  const main = rawVersion.split(/[+-]/, 1)[0]!;
  const rawParts = main.split('.');
  const wildcard = rawParts.findIndex(
    (part) => part === '*' || /^x$/i.test(part),
  );
  if (wildcard >= 0 || rawParts.length < 3) {
    const fixed = rawParts
      .slice(0, wildcard < 0 ? rawParts.length : wildcard)
      .map((part) => {
        if (!/^\d+$/.test(part))
          throw new ProviderError(
            'INVALID_NATIVE_RANGE',
            `Invalid partial version: ${rawVersion}`,
          );
        return Number(part);
      });
    if (fixed.length === 0) return [];
    while (fixed.length < 3) fixed.push(0);
    if (operator === '^') return caretBounds(parseSemver(fixed.join('.')));
    if (operator === '~')
      return tildeBounds(parseSemver(fixed.join('.')), rawParts.length);
    if (operator !== '')
      return [
        comparison(
          operator as '=' | '!=' | '>' | '>=' | '<' | '<=',
          fixed.join('.'),
        ),
      ];
    const incrementAt = Math.min(
      (wildcard < 0 ? rawParts.length : wildcard) - 1,
      1,
    );
    const upper = fixed.map((part, index) =>
      index < incrementAt ? part : index === incrementAt ? part + 1 : 0,
    );
    return [
      comparison('>=', fixed.join('.')),
      comparison('<', upper.join('.')),
    ];
  }
  const parsed = parseSemver(rawVersion);
  if (operator === '^') return caretBounds(parsed);
  if (operator === '~') return tildeBounds(parsed, rawParts.length);
  if (operator !== '')
    return [
      comparison(
        operator as '=' | '!=' | '>' | '>=' | '<' | '<=',
        parsed.normalized,
      ),
    ];
  return options.bare === 'caret'
    ? caretBounds(parsed)
    : [comparison('=', parsed.normalized)];
}

function astVers(ast: RangeAst): string | undefined {
  if (ast.type === 'any') return '*';
  if (ast.type === 'comparison') return `${ast.operator}${ast.version}`;
  if (ast.type === 'or') return undefined;
  const parts = ast.items.map(astVers);
  return parts.some((part) => part === undefined) ? undefined : parts.join('|');
}

export function parseSemverRange(
  value: string,
  options: SemverRangeOptions,
): ParsedRange {
  if (value.length > 4096)
    throw new ProviderError(
      'INVALID_NATIVE_RANGE',
      'Native range exceeds 4096 characters',
    );
  const original = value;
  let normalizedInput = value.trim();
  if (normalizedInput === '' || normalizedInput === '*') normalizedInput = '*';
  if (options.hyphenRanges) {
    normalizedInput = normalizedInput.replace(
      /(^|\|\||\s)(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)\s+-\s+(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)(?=\s|\|\||$)/g,
      (_match, prefix: string, lower: string, upper: string) => {
        const upperMain = upper.split('-', 1)[0]!;
        const upperParts = upperMain.split('.').map(Number);
        if (upperParts.length === 3) return `${prefix}>=${lower} <=${upper}`;
        const incrementAt = upperParts.length - 1;
        while (upperParts.length < 3) upperParts.push(0);
        upperParts[incrementAt] = upperParts[incrementAt]! + 1;
        for (let index = incrementAt + 1; index < upperParts.length; index += 1)
          upperParts[index] = 0;
        return `${prefix}>=${lower} <${upperParts.join('.')}`;
      },
    );
  }
  normalizedInput = normalizedInput.replace(
    /(<=|>=|!=|=|<|>|\^|~)\s+(?=[0-9v*x])/gi,
    '$1',
  );
  const alternatives = normalizedInput.split('||').map((alternative) => {
    const tokens = alternative
      .replace(options.commaAnd ? /,/g : /$^/, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return conjunction(
      tokens.flatMap((token) => parseRangeToken(token, options)),
    );
  });
  const ast: RangeAst =
    alternatives.length === 1
      ? alternatives[0]!
      : { type: 'or', items: alternatives };
  const versBody = exactlyRepresentableSemverRange(ast)
    ? astVers(ast)
    : undefined;
  const loss =
    versBody === undefined
      ? [
          semanticLoss(
            options.scheme,
            'NATIVE_RANGE_NOT_EXACTLY_REPRESENTABLE',
            '/range',
            'Native prerelease or disjunction semantics have no exact VERS encoding',
          ),
        ]
      : [];
  return {
    scheme: options.scheme,
    original,
    normalized: renderRange(ast),
    ast,
    ...(versBody === undefined
      ? {}
      : { vers: `vers:${options.scheme}/${versBody}` }),
    reversible: versBody !== undefined,
    semanticLoss: loss,
  };
}

function exactlyRepresentableSemverRange(ast: RangeAst): boolean {
  if (ast.type === 'comparison') return ast.operator === '=';
  if (ast.type === 'and')
    return ast.items.every(exactlyRepresentableSemverRange);
  return false;
}

export function renderRange(ast: RangeAst): string {
  if (ast.type === 'any') return '*';
  if (ast.type === 'comparison') return `${ast.operator}${ast.version}`;
  const separator = ast.type === 'and' ? ' ' : ' || ';
  return ast.items.map(renderRange).join(separator);
}

function parseVersExpression(expression: string): RangeAst {
  if (expression === '*') return { type: 'any' };
  const alternatives = expression.split('||').map((alternative) => {
    const clauses = alternative.split('|').map((clause) => {
      const match = /^(<=|>=|!=|=|<|>)([^\s|]{1,1024})$/u.exec(clause.trim());
      if (!match?.[1] || !match[2])
        throw new ProviderError(
          'INVALID_VERS',
          `Invalid VERS clause: ${clause}`,
        );
      return {
        type: 'comparison' as const,
        operator: match[1] as '=' | '!=' | '>' | '>=' | '<' | '<=',
        version: match[2],
      };
    });
    return clauses.length === 1
      ? clauses[0]!
      : { type: 'and' as const, items: clauses };
  });
  return alternatives.length === 1
    ? alternatives[0]!
    : { type: 'or', items: alternatives };
}

function renderVersExpression(ast: RangeAst): string {
  if (ast.type === 'any') return '*';
  if (ast.type === 'comparison') return `${ast.operator}${ast.version}`;
  return ast.items
    .map(renderVersExpression)
    .join(ast.type === 'and' ? '|' : '||');
}

export function parseVers(value: string): VersionConstraint {
  if (value.length > 4096)
    throw new ProviderError('INVALID_VERS', 'VERS exceeds 4096 bytes');
  const match = /^vers:([a-z][a-z0-9.+-]*)\/(.+)$/u.exec(value.trim());
  if (!match?.[1] || !match[2])
    throw new ProviderError(
      'INVALID_VERS',
      'VERS must include a scheme and expression',
    );
  const ast = parseVersExpression(match[2]);
  return {
    scheme: match[1],
    original: value,
    normalized: renderRange(ast),
    ast: ast as VersionConstraint['ast'],
    vers: `vers:${match[1]}/${renderVersExpression(ast)}`,
    reversible: true,
    semanticLoss: [],
  };
}

export function rangeToConstraint(range: ParsedRange): VersionConstraint {
  const result: VersionConstraint = {
    scheme: range.scheme,
    original: range.original,
    normalized: range.normalized,
    ast: range.ast as VersionConstraint['ast'],
    reversible: range.reversible,
    semanticLoss: [...range.semanticLoss],
  };
  if (range.vers !== undefined) result.vers = range.vers;
  return result;
}

export function semanticLoss(
  ecosystem: Ecosystem,
  code: string,
  sourcePath: string,
  originalMeaning: string,
  representedMeaning?: string,
  severity: SemanticLoss['severity'] = 'warning',
): SemanticLoss {
  const result: SemanticLoss = {
    code,
    severity,
    sourceEcosystem: ecosystem,
    sourcePath,
    originalMeaning,
    blocksProfile: ['prex-calculus-subset-v1'],
  };
  if (representedMeaning !== undefined)
    result.representedMeaning = representedMeaning;
  return result;
}

export function text(response: HttpResponse): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(response.body);
}

export function json<T>(response: HttpResponse): T {
  if (response.status < 200 || response.status >= 300)
    throw providerErrorForStatus(response.status);
  try {
    const value = JSON.parse(text(response)) as T;
    assertBoundedProviderMetadata(value);
    return value;
  } catch (error) {
    throw new ProviderError(
      'INVALID_PROVIDER_METADATA',
      error instanceof Error ? error.message : 'Invalid JSON',
    );
  }
}

export function assertBoundedProviderMetadata(
  value: unknown,
  maximumDepth = 64,
  maximumNodes = 200_000,
): void {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > maximumNodes)
      throw new ProviderError(
        'UPSTREAM_RESPONSE_TOO_LARGE',
        `Provider metadata exceeds ${maximumNodes} values`,
      );
    if (current.depth > maximumDepth)
      throw new ProviderError(
        'INVALID_PROVIDER_METADATA',
        `Provider metadata exceeds depth ${maximumDepth}`,
      );
    if (current.value !== null && typeof current.value === 'object') {
      for (const child of Array.isArray(current.value)
        ? current.value
        : Object.values(current.value))
        pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

export function header(
  response: HttpResponse,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  return Object.entries(response.headers).find(
    ([key]) => key.toLowerCase() === lower,
  )?.[1];
}

export async function verifyNativeDigest(
  bytes: Uint8Array,
  algorithm: string,
  expected: string,
): Promise<boolean> {
  const normalized = algorithm.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const webAlgorithm =
    normalized === 'SHA1'
      ? 'SHA-1'
      : normalized === 'SHA256'
        ? 'SHA-256'
        : normalized === 'SHA384'
          ? 'SHA-384'
          : normalized === 'SHA512'
            ? 'SHA-512'
            : undefined;
  if (webAlgorithm === undefined)
    throw new ProviderError(
      'INVALID_PROVIDER_METADATA',
      `Unsupported native digest algorithm: ${algorithm}`,
    );
  const digest = new Uint8Array(
    await crypto.subtle.digest(webAlgorithm, Uint8Array.from(bytes).buffer),
  );
  const actual = /^[0-9a-f]+$/i.test(expected)
    ? [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    : btoa(String.fromCharCode(...digest));
  return actual.toLowerCase() === expected.toLowerCase();
}

export function sourceRef(ecosystem: Ecosystem, endpoint: string) {
  return {
    type: 'registry' as const,
    uri: endpoint,
    extensions: { 'openpacker.dev/ecosystem': ecosystem },
  };
}

/**
 * The `package-node-v1` node identity for a package instance.
 *
 * Node identity is normative: `spec/prex/v1/digest-projections.json` defines
 * it as the digest of a projection over exact PURL, qualifiers, and native
 * semantics version. Computing it through the projection registry rather than
 * by hashing a convenient value keeps every codec — and anyone recomputing it
 * from a universe — in agreement by construction.
 */
export async function packageNodeId(input: {
  exactPurl: string;
  qualifiers?: Readonly<Record<string, string>>;
  nativeSemanticsVersion?: string;
}): Promise<string> {
  const projection = DIGEST_PROJECTIONS.projections.find(
    (item) => item.id === 'package-node-v1',
  );
  if (!projection)
    throw new Error('package-node-v1 projection is missing from the registry');
  const digest = await canonicalProjectionDigest(
    {
      identity: {
        exactPurl: input.exactPurl,
        qualifiers: { ...(input.qualifiers ?? {}) },
      },
      ...(input.nativeSemanticsVersion === undefined
        ? {}
        : { nativeSemantics: { version: input.nativeSemanticsVersion } }),
    } as unknown as JsonValue,
    projection,
  );
  return formatDigest(digest);
}

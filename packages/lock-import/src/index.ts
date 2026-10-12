import {
  ProviderError,
  formatPurl,
  packageNodeId,
  parsePurl,
  type Ecosystem,
  type EcosystemCodec,
  type LockCapture,
  type TranslationProvenance,
} from '@openpacker/adapter-core';
import { tryGetAdapterRegistry } from '@openpacker/adapter-host';
import { parse as parseYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import {
  canonicalBytes,
  canonicalDigest,
  canonicalProjectionDigest,
  compareCanonicalStrings,
  formatDigest,
  sha256,
} from '@openpacker/canonical';
import { DIGEST_PROJECTIONS } from '@openpacker/contracts';
import type {
  Digest,
  JsonValue,
  OpenPackerLockfile,
  PackageInstance,
  ResolutionReceipt,
  ResolutionUniverse,
  SemanticLoss,
  SolveRequest,
  SolveResponse,
  TargetContext,
} from '@openpacker/contracts';

export type LockFormat =
  | 'package-lock'
  | 'pnpm-lock'
  | 'cargo-lock'
  | 'nuget-assets'
  | 'nuget-packages-lock'
  | 'uv-lock'
  | 'poetry-lock'
  | 'requirements-txt'
  | 'go-sum'
  | 'gradle-lockfile'
  | 'auto';

export interface LockImportOptions {
  format?: LockFormat;
  ecosystem?: Ecosystem;
  evaluationTime?: string;
  target?: TargetContext;
  policy?: SolveRequest['policy'];
  objectives?: SolveRequest['objectives'];
  universe?: ResolutionUniverse;
  providerId?: string;
  endpoint?: string;
  /** Optional codec registry for ecosystems beyond the built-in three. */
  codecs?: ReadonlyMap<Ecosystem, EcosystemCodec>;
  /** Optional format handlers keyed by LockFormat. */
  formatHandlers?: ReadonlyMap<Exclude<LockFormat, 'auto'>, LockFormatHandler>;
}

export interface LockFormatHandler {
  ecosystem: Ecosystem;
  parse(raw: string | Uint8Array): LockParsedValue;
  codec: EcosystemCodec;
}

type LockParsedValue = JsonValue | object;

export interface CapturePlan {
  format: Exclude<LockFormat, 'auto'>;
  ecosystem: Ecosystem;
  lockCapture: LockCapture;
  lockedExactPurls: string[];
  packages: PackageInstance[];
  semanticLoss: SemanticLoss[];
  sourceDigest: Digest;
}

export interface LockImportSolveInput {
  request: SolveRequest;
  universe: ResolutionUniverse;
  lockCapture: LockCapture;
  semanticLoss: SemanticLoss[];
}

export interface LockImportResult {
  lockCapture: LockCapture;
  solveResponse: SolveResponse;
  lockfile: OpenPackerLockfile;
  semanticLoss: SemanticLoss[];
}

const DEFAULT_EVALUATION_TIME = '2026-08-02T00:00:00Z';

function projectedDigest(
  id: 'proof-v1' | 'explanation-v1' | 'artifact-set-v1' | 'universe-v1',
  value: JsonValue,
) {
  const projection = DIGEST_PROJECTIONS.projections.find(
    (candidate) => candidate.id === id,
  );
  if (!projection) throw new Error(`Missing digest projection ${id}`);
  return canonicalProjectionDigest(value, projection);
}

/**
 * Resolve codecs from options or the process adapter registry.
 *
 * Never constructs ecosystem codecs by name — that is the adapter host's job.
 */
function resolveCodecs(
  options: LockImportOptions,
): Map<Ecosystem, EcosystemCodec> {
  const codecs = new Map<Ecosystem, EcosystemCodec>();
  const registry = tryGetAdapterRegistry();
  if (registry) {
    for (const module of registry.list()) {
      if (!module.codec) continue;
      const codec = module.codec();
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      for (const purlType of module.purlTypes)
        codecs.set(purlType.toLowerCase() as Ecosystem, codec);
    }
  }
  if (options.codecs) {
    for (const [ecosystem, codec] of options.codecs)
      codecs.set(ecosystem, codec);
  }
  return codecs;
}

function defaultHandlers(
  codecs: ReadonlyMap<Ecosystem, EcosystemCodec>,
): Map<Exclude<LockFormat, 'auto'>, LockFormatHandler> {
  const npm = codecs.get('npm');
  const cargo = codecs.get('cargo');
  const nuget = codecs.get('nuget');
  const pypi = codecs.get('pypi');
  const golang = codecs.get('golang');
  const maven = codecs.get('maven');
  if (!npm || !cargo || !nuget || !pypi || !golang || !maven)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'Lock-import requires codecs for npm, cargo, nuget, pypi, golang, and maven. ' +
        'Configure the adapter registry at process entry or pass options.codecs.',
    );
  return new Map([
    [
      'package-lock',
      {
        ecosystem: 'npm',
        codec: npm,
        parse: (raw) => parseStrictJson(asText(raw)),
      },
    ],
    [
      'pnpm-lock',
      {
        ecosystem: 'npm',
        codec: npm,
        parse: (raw) => parsePnpmLock(asText(raw)),
      },
    ],
    [
      'cargo-lock',
      {
        ecosystem: 'cargo',
        codec: cargo,
        parse: (raw) => asText(raw),
      },
    ],
    [
      'nuget-assets',
      {
        ecosystem: 'nuget',
        codec: nuget,
        parse: (raw) => ({
          format: 'project.assets.json' as const,
          data: parseStrictJson(asText(raw)),
        }),
      },
    ],
    [
      'nuget-packages-lock',
      {
        ecosystem: 'nuget',
        codec: nuget,
        parse: (raw) => ({
          format: 'packages.lock.json' as const,
          data: parseStrictJson(asText(raw)),
        }),
      },
    ],
    [
      'uv-lock',
      {
        ecosystem: 'pypi',
        codec: pypi,
        parse: (raw) => parseUvLock(asText(raw)),
      },
    ],
    [
      'poetry-lock',
      {
        ecosystem: 'pypi',
        codec: pypi,
        parse: (raw) => parsePoetryLock(asText(raw)),
      },
    ],
    [
      'requirements-txt',
      {
        ecosystem: 'pypi',
        codec: pypi,
        // Normalised into the uv.lock shape the pypi codec already reads,
        // rather than teaching that codec a second Python lock dialect. A
        // pinned requirements.txt carries strictly less than uv.lock does, and
        // the conversion is where that shows.
        parse: (raw) => parseRequirementsTxt(asText(raw)),
      },
    ],
    [
      'go-sum',
      {
        ecosystem: 'golang',
        codec: golang,
        parse: (raw) => asText(raw),
      },
    ],
    [
      'gradle-lockfile',
      {
        ecosystem: 'maven',
        codec: maven,
        parse: (raw) => asText(raw),
      },
    ],
  ]);
}

/**
 * A `poetry.lock`, as the uv.lock document the pypi codec reads.
 *
 * Poetry pins exactly like uv does — `[[package]]` entries with a name and a
 * version — so the conversion is a rename rather than a translation. What it
 * does not carry is uv's per-package artifact hashes in the same shape, and
 * that difference is where the import loses information rather than inventing
 * it. Per-entry environment context (`python-versions`, markers, sources,
 * `optional = true`) is refused outright: a lock that only applies to some
 * interpreters or only includes some packages cannot be imported as a flat
 * pinned set. The lock-wide `[metadata] python-versions` survives as uv.lock's
 * `requires-python`, which the pypi codec records as tracked semantic loss.
 */
function hasUnsupportedPoetryContext(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasUnsupportedPoetryContext);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, child]) =>
      key === 'marker' ||
      key === 'markers' ||
      key === 'source' ||
      key === 'files' ||
      // python-versions is interpreter applicability; dropping it would pin a
      // selection for environments the lock never claimed to cover.
      key === 'python-versions' ||
      // optional = true means the package may not participate in the locked
      // set at all. (optional = false is the poetry default and carries no
      // information, so it is not context.)
      (key === 'optional' && child === true) ||
      hasUnsupportedPoetryContext(child),
  );
}

export function parsePoetryLock(text: string) {
  // Depth is capped far beyond anything a real poetry.lock nests to; the cap
  // also bounds the hasUnsupportedPoetryContext recursion over the result.
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const document = parseToml(text, { maxDepth: 64 }) as {
    package?: Array<
      Record<string, unknown> & { name?: unknown; version?: unknown }
    >;
    metadata?: {
      'lock-version'?: unknown;
      'python-versions'?: unknown;
      files?: unknown;
    };
  };
  if (!Array.isArray(document.package))
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'poetry.lock has no [[package]] entries',
    );

  if (document.metadata?.files !== undefined)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'poetry.lock artifact hashes cannot be represented without losing integrity',
    );

  const packages: { name: string; version: string }[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of document.package.entries()) {
    if (typeof entry?.name !== 'string' || typeof entry.version !== 'string')
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `poetry.lock package entry ${index + 1} is missing a string name or version`,
      );
    // Normalised the way PyPI normalises, so Foo_Bar and foo-bar are one
    // distribution — the same rule requirements.txt import applies.
    const name = entry.name.toLowerCase().replace(/[-_.]+/gu, '-');
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(name))
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `poetry.lock package entry ${index + 1} has an invalid name`,
      );
    if (hasUnsupportedPoetryContext(entry))
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `poetry.lock package ${name} carries marker, source, python-version, optionality, or artifact context that cannot be represented losslessly`,
      );
    if (seen.has(name))
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `poetry.lock contains multiple locked selections for ${name}`,
      );
    seen.add(name);
    packages.push({ name, version: entry.version });
  }
  if (packages.length === 0)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'poetry.lock contains no importable packages',
    );
  // The lock-wide [metadata] python-versions maps onto uv.lock's
  // requires-python, which the pypi codec records as a tracked semantic loss
  // rather than discarding it.
  const requiresPython = document.metadata?.['python-versions'];
  return {
    version: 1,
    ...(typeof requiresPython === 'string' && {
      'requires-python': requiresPython,
    }),
    package: packages,
  };
}

/**
 * A `pnpm-lock.yaml`, as the package-lock document the npm codec reads.
 *
 * pnpm resolves against the same registry npm does, so the packages are the
 * same packages; only the lock format differs. Converting here rather than
 * teaching the npm codec a second dialect keeps one npm translation with one
 * set of semantics.
 *
 * pnpm keys packages as `name@version`, with scoped names carrying their own
 * `@` — `@scope/pkg@1.0.0`. The split is on the last `@` for that reason.
 */
export function parsePnpmLock(text: string) {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const document = parseYaml(text) as {
    lockfileVersion?: unknown;
    packages?: Record<string, unknown>;
    snapshots?: Record<string, unknown>;
  };
  const version = String(document.lockfileVersion ?? '');
  // Older versions use different package/snapshot key shapes. Refusing beats
  // treating them as v9 and silently changing package identities.
  if (!/^9(?:\.|$)/u.test(version))
    throw new ProviderError(
      'INVALID_LOCKFILE',
      `Unsupported pnpm lockfileVersion "${version}"; only version 9 is supported.`,
    );
  if (
    !document.packages ||
    typeof document.packages !== 'object' ||
    Array.isArray(document.packages)
  )
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'pnpm-lock.yaml has no packages section',
    );

  const parsePackageKey = (key: string) => {
    if (key.includes('('))
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `pnpm peer context cannot be represented losslessly: ${key}`,
      );
    const at = key.lastIndexOf('@');
    if (at <= 0)
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `pnpm-lock.yaml contains an unsupported package key: ${key}`,
      );
    const name = key.slice(0, at);
    const packageVersion = key.slice(at + 1);
    if (!/^(?:@[^/]+\/)?[^/@]+$/u.test(name) || !/^[0-9]/u.test(packageVersion))
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `pnpm-lock.yaml contains an unsupported package key: ${key}`,
      );
    return { name, version: packageVersion };
  };

  const packages: Record<
    string,
    { version: string; resolved?: string; integrity?: string }
  > = {};
  const packageKeys = new Set<string>();
  for (const [key, value] of Object.entries(document.packages)) {
    const { name, version: packageVersion } = parsePackageKey(key);
    // A non-object value (`'a@1.0.0: garbage'`) has no resolution to read;
    // accepting it would import a version-only entry from malformed input.
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `pnpm-lock.yaml contains a malformed package value for: ${key}`,
      );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const resolution = (value as { resolution?: unknown }).resolution;
    if (
      resolution !== undefined &&
      (resolution === null ||
        typeof resolution !== 'object' ||
        Array.isArray(resolution))
    )
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `pnpm-lock.yaml contains a malformed resolution for: ${key}`,
      );
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const { integrity, tarball } = (resolution ?? {}) as {
      integrity?: unknown;
      tarball?: unknown;
    };
    if (tarball !== undefined && typeof tarball !== 'string')
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `pnpm-lock.yaml contains a malformed resolution for: ${key}`,
      );
    if (integrity !== undefined && typeof integrity !== 'string')
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `pnpm-lock.yaml contains a malformed resolution for: ${key}`,
      );
    // package-lock keys packages by install path; `node_modules/<name>` is the
    // form the npm codec reads.
    const installPath = `node_modules/${name}`;
    if (packages[installPath] !== undefined)
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `pnpm-lock.yaml contains multiple locked selections for ${name}`,
      );
    packages[installPath] = {
      version: packageVersion,
      ...(tarball !== undefined && { resolved: tarball }),
      ...(integrity !== undefined && { integrity }),
    };
    packageKeys.add(key);
  }
  if (document.snapshots !== undefined) {
    if (
      document.snapshots === null ||
      typeof document.snapshots !== 'object' ||
      Array.isArray(document.snapshots)
    )
      throw new ProviderError(
        'INVALID_LOCKFILE',
        'pnpm-lock.yaml snapshots must be a mapping',
      );
    for (const key of Object.keys(document.snapshots)) {
      parsePackageKey(key);
      if (!packageKeys.has(key))
        throw new ProviderError(
          'INVALID_LOCKFILE',
          `pnpm-lock.yaml snapshot has no matching package: ${key}`,
        );
    }
  }
  if (Object.keys(packages).length === 0)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'pnpm-lock.yaml contains no importable packages',
    );
  return { lockfileVersion: 3, packages };
}

/**
 * A fully pinned `requirements.txt`, as a uv.lock-shaped document.
 *
 * Only `name==version` lines are importable. A requirements file may also
 * carry ranges, markers, editable installs, VCS URLs and `-r` includes; none
 * of those name an exact package, and importing a lock that is not actually
 * locked would produce a pinned universe from an unpinned input. Those lines
 * are refused rather than approximated — `pip freeze` output imports cleanly,
 * a hand-written requirements file with ranges does not, and the error says
 * which line is the problem.
 */
export function parseRequirementsTxt(text: string) {
  const packages: { name: string; version: string }[] = [];
  const seen = new Map<string, string>();
  let lineNumber = 0;
  for (const rawLine of text.split(/\r?\n/u)) {
    lineNumber += 1;
    const uncommented = rawLine.split('#')[0]!;
    // `--hash` anywhere on the line, not just as a whitespace-delimited token:
    // `idna==3.7--hash=sha256:x` would otherwise smuggle a hash into the
    // version token.
    if (/--hash/u.test(uncommented))
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `requirements.txt line ${lineNumber} contains an artifact hash that cannot be represented losslessly`,
      );
    const line = uncommented.trim();
    if (line === '') continue;
    if (line.startsWith('-'))
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `requirements.txt line ${lineNumber} uses an option or include that cannot be represented losslessly: "${line}"`,
      );
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*==\s*([^\s;]+)$/u.exec(line);
    if (!match) {
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `requirements.txt line ${lineNumber} is not an exact pin: "${rawLine.trim()}". ` +
          `Only "name==version" can be imported; a range or marker does not name a package.`,
      );
    }
    const name = match[1]!.toLowerCase().replace(/[-_.]+/gu, '-');
    const version = match[2]!;
    const previous = seen.get(name);
    if (previous !== undefined) {
      if (previous !== version)
        throw new ProviderError(
          'INVALID_LOCKFILE',
          `requirements.txt contains multiple exact versions for ${name}`,
        );
      continue;
    }
    seen.set(name, version);
    packages.push({ name, version });
  }
  if (packages.length === 0)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'requirements.txt contains no exact pins to import',
    );
  return { version: 1, package: packages };
}

/**
 * Native uv.lock (TOML, the file uv writes) or the JSON projection of the
 * same document. Both become the in-memory shape the pypi codec already
 * reads — one codec, one capture path.
 *
 * Detection belongs in `detectLockFormat`. This parser refuses a document
 * that is not uv.lock version 1 with a package array rather than guessing
 * a poetry or cargo table that happened to parse.
 */
export function parseUvLock(text: string): {
  version: 1;
  'requires-python'?: string;
  package: Record<string, unknown>[];
  [key: string]: unknown;
} {
  const trimmed = text.trim();
  const document = jsonable(
    trimmed.startsWith('{')
      ? parseStrictJson(trimmed)
      : parseToml(text, { maxDepth: 64 }),
  );
  if (
    document === null ||
    typeof document !== 'object' ||
    Array.isArray(document)
  )
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'uv.lock must be a TOML or JSON table',
    );
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const record = document as Record<string, unknown>;
  if (record.version !== 1)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      `Expected uv.lock version 1, received ${String(record.version)}`,
    );
  if (!Array.isArray(record.package))
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'uv.lock is missing package array',
    );
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return record as {
    version: 1;
    'requires-python'?: string;
    package: Record<string, unknown>[];
    [key: string]: unknown;
  };
}

type JsonableValue =
  | null
  | boolean
  | number
  | string
  | JsonableValue[]
  | { [key: string]: JsonableValue }
  | undefined;

function jsonable(value: unknown): JsonableValue {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(jsonable);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonableValue> = {};
    for (const [key, child] of Object.entries(value))
      out[key] = jsonable(child);
    return out;
  }
  // SAFETY: Lock parser values are JSON-compatible apart from bigint, handled above.
  return value as JsonableValue;
}

function looksLikeUvLockToml(text: string): boolean {
  if (!/\[\[package\]\]/.test(text)) return false;
  // Poetry also uses [[package]]; its lock-version block is the discriminator.
  if (/^lock-version\s*=/mu.test(text)) return false;
  if (/^requires-python\s*=/mu.test(text)) return true;
  // uv writes `version = 1` plus inline-table sources (`source = { registry = … }`).
  // Cargo.lock uses `version = 3`/`4` and `source = "registry+…"`.
  return (
    /^version\s*=\s*1\b/mu.test(text) &&
    (/^revision\s*=/mu.test(text) || /source\s*=\s*\{/.test(text))
  );
}

function asText(raw: string | Uint8Array): string {
  return typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw);
}

function asBytes(raw: string | Uint8Array): Uint8Array {
  return typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
}

function parseStrictJson(text: string): JsonValue {
  // The YAML parser already in this package detects duplicate mapping keys;
  // JSON.parse then retains the strict JSON grammar expected by lock formats.
  parseYaml(text, { schema: 'json', uniqueKeys: true });
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  // SAFETY: The JSON-schema parser has accepted the complete JSON value at this boundary.
  return JSON.parse(text) as JsonValue;
}

export function detectLockFormat(
  raw: string | Uint8Array,
  hint?: LockFormat,
): Exclude<LockFormat, 'auto'> {
  if (hint && hint !== 'auto') return hint;
  const text = asText(raw).trim();
  if (text.startsWith('{')) {
    try {
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      const parsed = parseStrictJson(text) as Record<string, unknown>;
      // npm 7 and 8 write lockfileVersion 2, which carries the same `packages`
      // map beside the legacy `dependencies` one; 9 and later write 3.
      if (
        (parsed.lockfileVersion === 3 || parsed.lockfileVersion === 2) &&
        parsed.packages
      )
        return 'package-lock';
      if (parsed.version !== undefined && parsed.targets) return 'nuget-assets';
      if (
        parsed.version !== undefined &&
        parsed.dependencies &&
        !Array.isArray(parsed.package)
      )
        return 'nuget-packages-lock';
      // uv.lock JSON projection: version + package[]
      if (
        (parsed.version === 1 || parsed.version === '1') &&
        Array.isArray(parsed.package)
      )
        return 'uv-lock';
    } catch {
      // fall through
    }
  }
  if (looksLikeUvLockToml(text)) return 'uv-lock';
  if (/^version\s*=\s*\d+/m.test(text) && /\[\[package\]\]/.test(text))
    return 'cargo-lock';
  // go.sum lines: module version h1:... (ignore comments)
  if (
    text
      .split('\n')
      .some((line) => /^[\w./-]+ [vh][\w.+-]* h1:/.test(line.trim()))
  )
    return 'go-sum';
  // Gradle lockfile: group:name:version=configurations
  if (
    text
      .split('\n')
      .some((line) =>
        /^[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+=/.test(line.trim()),
      )
  )
    return 'gradle-lockfile';
  if (
    /^lockfileVersion:\s*'?9(?:\.\d+)?'?\s*$/mu.test(text) &&
    /^packages:/mu.test(text)
  )
    return 'pnpm-lock';
  // Poetry writes a [metadata] lock-version alongside [[package]] tables;
  // Cargo.lock has [[package]] too, so the metadata block is what separates
  // them and it is checked before the cargo test above would match.
  if (/^\[\[package\]\]/mu.test(text) && /^lock-version\s*=/mu.test(text))
    return 'poetry-lock';
  // Last, and only when every meaningful line is an exact pin. A loose test
  // here would claim any text file is a requirements.txt, so this asks for
  // proof rather than a hint.
  {
    const lines = text
      .split(/\r?\n/u)
      .map((line) => line.split('#')[0]!.trim())
      .filter((line) => line !== '' && !line.startsWith('-'));
    if (
      lines.length > 0 &&
      lines.every((line) =>
        /^[A-Za-z0-9][A-Za-z0-9._-]*\s*==\s*[^\s;]+(\s+--hash=\S+)*$/u.test(
          line,
        ),
      )
    )
      return 'requirements-txt';
  }
  throw new ProviderError(
    'INVALID_LOCKFILE',
    'Unable to detect native lockfile format',
  );
}

export async function planLockCapture(
  raw: string | Uint8Array,
  options: LockImportOptions = {},
): Promise<CapturePlan> {
  const codecs = resolveCodecs(options);
  const handlers = new Map([
    ...defaultHandlers(codecs),
    ...(options.formatHandlers ?? []),
  ]);
  const format = detectLockFormat(raw, options.format);
  const handler = handlers.get(format);
  if (!handler)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      `No lock-import handler registered for format ${format}`,
    );
  if (options.ecosystem && options.ecosystem !== handler.ecosystem)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      `Ecosystem ${options.ecosystem} does not match detected format ${format}`,
    );

  const sourceDigest = await sha256(asBytes(raw));
  const evaluationTime = options.evaluationTime ?? DEFAULT_EVALUATION_TIME;
  const provenance: TranslationProvenance = {
    providerId: options.providerId ?? `lock-import:${handler.ecosystem}`,
    endpoint: options.endpoint ?? `lockfile://${format}`,
    retrievedAt: evaluationTime,
    evaluationTime,
    metadataDigest: sourceDigest,
  };
  const parsed = handler.parse(raw);
  const lockCapture = handler.codec.translateLockResult(parsed, provenance);
  if (!lockCapture.packages.length)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'Native lockfile produced no package selections',
    );

  const packages = await Promise.all(
    lockCapture.packages.map((entry) =>
      minimalInstanceFromLockEntry(entry, handler.ecosystem, sourceDigest),
    ),
  );
  const lockedExactPurls = [
    ...new Set(
      packages
        .map((item) => item.identity.exactPurl)
        .filter((value): value is string => value !== undefined),
    ),
  ].sort(compareCanonicalStrings);

  if (lockedExactPurls.length !== packages.length)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'Native lockfile contains duplicate or missing exact PURLs',
    );

  return {
    format,
    ecosystem: handler.ecosystem,
    lockCapture: {
      ...lockCapture,
      sourceDigest: formatDigest(sourceDigest),
    },
    lockedExactPurls,
    packages,
    semanticLoss: [
      ...lockCapture.semanticLoss,
      {
        code: 'NATIVE_RESULT_CAPTURE_ONLY',
        severity: 'info',
        sourceEcosystem: handler.ecosystem,
        sourcePath: '/',
        originalMeaning:
          'Selections were imported from a native lockfile; OpenPacker did not independently solve the graph',
        representedMeaning: 'native-capture-v1 locked exact PURLs',
        blocksProfile: ['prex-calculus-subset-v1', 'native-validated-v1'],
      },
    ],
    sourceDigest,
  };
}

export async function buildCaptureSolveInput(
  plan: CapturePlan,
  options: LockImportOptions = {},
): Promise<LockImportSolveInput> {
  const evaluationTime = options.evaluationTime ?? DEFAULT_EVALUATION_TIME;
  const universe =
    options.universe === undefined
      ? await buildMinimalUniverse(
          plan.packages,
          evaluationTime,
          plan.sourceDigest,
        )
      : await mergePackagesIntoUniverse(options.universe, plan.packages);

  const request: SolveRequest = {
    requirements: [],
    target: options.target ?? {},
    environment: {
      installed: [],
      locked: plan.lockedExactPurls,
    },
    policy: options.policy ?? {
      allowYanked: false,
      allowQuarantined: false,
      semanticLossMaximum: 'warning',
      requiredEvidence: [],
      acceptedOverlayAuthorities: [],
    },
    semantics: {
      profile: 'native-capture-v1',
      nativeCompatibility: [plan.ecosystem],
    },
    objectives: options.objectives ?? [
      'minimize-package-count',
      'prefer-highest-native-version',
      'canonical-lexical-tie-break',
    ],
    mode: 'closure',
    evaluationTime,
  };

  return {
    request,
    universe,
    lockCapture: plan.lockCapture,
    semanticLoss: plan.semanticLoss,
  };
}

export async function planNativeLockImport(
  raw: string | Uint8Array,
  options: LockImportOptions = {},
): Promise<LockImportSolveInput> {
  const plan = await planLockCapture(raw, options);
  return buildCaptureSolveInput(plan, options);
}

type EmbeddedSolveOutput = {
  normalizedRequest: SolveRequest;
  requestDigest: Digest;
  universeDigest: Digest;
  selected: PackageInstance[];
  solution: SolveResponse['solution'];
  proof: SolveResponse['proof'];
  explanation: unknown;
};

export interface EmbeddedSolveLike {
  solve(input: { request: SolveRequest; universe: ResolutionUniverse }): {
    normalizedRequest: SolveRequest;
    requestDigest: Digest;
    universeDigest: Digest;
    selected: PackageInstance[];
    solution: SolveResponse['solution'];
    proof: SolveResponse['proof'];
    explanation: unknown;
  };
  check(
    input: { request: SolveRequest; universe: ResolutionUniverse },
    output: EmbeddedSolveOutput,
  ): { valid: boolean; diagnostics: string[] };
}

export async function completeLockImport(
  solveInput: LockImportSolveInput,
  resolver: EmbeddedSolveLike,
  meta: {
    providerId: string;
    implementation?: string;
    version: string;
    resolverBuildDigest: Digest;
    protocolVersion?: string;
  },
): Promise<LockImportResult> {
  if (solveInput.request.policy.requiredEvidence.length > 0)
    throw new ProviderError(
      'POLICY_DENIED',
      `Lock import cannot satisfy required evidence: ${solveInput.request.policy.requiredEvidence.join(', ')}`,
    );
  const severity = { info: 0, warning: 1, error: 2 } as const;
  const maximum = severity[solveInput.request.policy.semanticLossMaximum];
  const losses = [
    ...solveInput.semanticLoss,
    ...solveInput.universe.packages.flatMap((item) => item.semanticLoss),
  ];
  const deniedLoss = losses.find((loss) => severity[loss.severity] > maximum);
  if (deniedLoss)
    throw new ProviderError(
      'POLICY_DENIED',
      `Semantic loss ${deniedLoss.code} exceeds ${solveInput.request.policy.semanticLossMaximum}`,
    );
  const embeddedInput = {
    request: solveInput.request,
    universe: solveInput.universe,
  };
  const output = resolver.solve(embeddedInput);
  const check = resolver.check(embeddedInput, output);
  if (!check.valid)
    throw new ProviderError(
      'INTERNAL_ERROR',
      `Independent proof check failed: ${check.diagnostics.join('; ')}`,
    );

  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const explanation = output.explanation as SolveResponse['explanation'];
  const proofDigest = await projectedDigest(
    'proof-v1',
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    JSON.parse(JSON.stringify(output.proof)) as JsonValue,
  );
  const explanationDigest = await projectedDigest(
    'explanation-v1',
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    JSON.parse(JSON.stringify(explanation)) as JsonValue,
  );
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  const artifactSetDigest = await projectedDigest(
    'artifact-set-v1',
    JSON.parse(
      JSON.stringify({
        items: output.selected.flatMap((item) => item.artifacts),
      }),
    ) as JsonValue,
  );
  const protocolVersion =
    meta.protocolVersion === '1.0-draft' || meta.protocolVersion === undefined
      ? ('1.0-draft' as const)
      : ('1.0-draft' as const);
  const unsignedReceipt: ResolutionReceipt = {
    receiptVersion: '1',
    protocolVersion,
    requestDigest: output.requestDigest,
    normalizedRequest: output.normalizedRequest,
    universeDigest: output.universeDigest,
    sourceSnapshots: solveInput.universe.sourceSnapshots,
    targetDigest: await canonicalDigest(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      JSON.parse(JSON.stringify(output.normalizedRequest.target)) as JsonValue,
    ),
    policyDigest: await canonicalDigest(
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      JSON.parse(JSON.stringify(output.normalizedRequest.policy)) as JsonValue,
    ),
    lifecycleRoot: solveInput.universe.lifecycleRoot,
    semanticsProfile: output.normalizedRequest.semantics.profile,
    objectiveOrdering: output.normalizedRequest.objectives,
    solutionDigest: output.solution.solutionDigest,
    proofDigest,
    explanationDigest,
    artifactSetDigest,
    resolver: {
      providerId: meta.providerId,
      implementation: meta.implementation ?? 'openpacker-resolver',
      version: meta.version,
      buildDigest: meta.resolverBuildDigest,
    },
    evaluationTime: output.normalizedRequest.evaluationTime,
    evidenceRefs: [],
    externalRefs: [],
  };

  const solveResponse: SolveResponse = {
    meta: {
      protocolVersion,
      provider: {
        id: meta.providerId,
        implementation: meta.implementation ?? 'openpacker-lock-import',
        version: meta.version,
      },
    },
    normalizedRequest: output.normalizedRequest,
    requestDigest: output.requestDigest,
    universeDigest: output.universeDigest,
    selected: output.selected,
    solution: output.solution,
    proof: output.proof,
    explanation,
    unsignedReceipt,
  };

  const lockfile = await buildLockfileFromSolve(solveResponse);
  return {
    lockCapture: solveInput.lockCapture,
    solveResponse,
    lockfile,
    semanticLoss: solveInput.semanticLoss,
  };
}

export async function buildLockfileFromSolve(
  solve: SolveResponse,
): Promise<OpenPackerLockfile> {
  const receiptDigest = await canonicalDigest(
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    JSON.parse(JSON.stringify(solve.unsignedReceipt)) as JsonValue,
  );
  const artifacts = solve.selected.flatMap((item) => item.artifacts);
  return {
    schemaVersion: '1',
    protocolVersion: '1.0-draft',
    rootRequirements: solve.normalizedRequest.requirements,
    target: solve.normalizedRequest.target,
    semanticsProfile: solve.normalizedRequest.semantics.profile,
    objectiveOrdering: solve.normalizedRequest.objectives,
    selectedExactPurls: solve.selected
      .map((item) => item.identity.exactPurl)
      .filter((value): value is string => value !== undefined)
      .sort(compareCanonicalStrings),
    dependencyEdges: solve.solution.dependencyEdges,
    artifactDescriptors: artifacts,
    ocmReferences: artifacts.flatMap((artifact) =>
      artifact.externalRefs.filter((reference) =>
        reference.type.startsWith('ocm'),
      ),
    ),
    sourceSnapshotDigests: solve.solution.sourceSnapshotDigests,
    lifecycleRoot: solve.unsignedReceipt.lifecycleRoot,
    policyDigest: solve.unsignedReceipt.policyDigest,
    solutionDigest: solve.solution.solutionDigest,
    receiptDigest,
    externalRefs: [],
  };
}

async function minimalInstanceFromLockEntry(
  entry: LockCapture['packages'][number],
  ecosystem: Ecosystem,
  sourceDigest: Digest,
): Promise<PackageInstance> {
  const exactPurl = entry.exactPurl;
  const parsed = parsePurl(exactPurl);
  if (!parsed.version)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      `Locked package is missing an exact version: ${exactPurl}`,
    );
  // Through the shared helper, not sha256(exactPurl): the node ID is defined
  // as the `package-node-v1` projection of the instance it labels, and this
  // instance carries both qualifiers and a native semantics version. Hashing
  // the PURL alone produced an ID that did not match its own projection for
  // every package in every imported lockfile.
  const nodeId = await packageNodeId({
    exactPurl,
    qualifiers: parsed.qualifiers,
    nativeSemanticsVersion: `${ecosystem}-lock-import-v1`,
  });
  const metadataDigest = await sha256(
    new TextEncoder().encode(
      JSON.stringify({
        exactPurl,
        native: entry.native,
        resolved: entry.resolved,
        artifactDigest: entry.artifactDigest,
      }),
    ),
  );
  const parsedDigest =
    entry.artifactDigest === undefined
      ? undefined
      : parseLooseDigest(entry.artifactDigest);
  const semanticLoss: SemanticLoss[] = [];
  if (entry.artifactDigest !== undefined && parsedDigest === undefined)
    semanticLoss.push({
      code: 'NATIVE_DIGEST_NOT_REPRESENTED',
      severity: 'warning',
      sourceEcosystem: ecosystem,
      sourcePath: '/',
      originalMeaning: `The native lock pins this artifact with a non-sha256 digest (${entry.artifactDigest.slice(0, 32)}…) that its native tool can verify`,
      representedMeaning:
        'No artifact descriptor is captured; OpenPacker holds no sha256 audit digest for this package',
      blocksProfile: [],
    });
  const resolvedLocation = httpsArtifactLocation(entry.resolved);
  if (entry.resolved !== undefined && resolvedLocation === undefined)
    semanticLoss.push({
      code: 'NATIVE_ARTIFACT_LOCATION_NOT_HTTPS',
      severity: 'warning',
      sourceEcosystem: ecosystem,
      sourcePath: '/',
      originalMeaning: `The native lock references ${entry.resolved}`,
      representedMeaning: 'No executable artifact location was imported',
      blocksProfile: [],
    });
  const artifacts =
    parsedDigest === undefined
      ? []
      : [
          {
            descriptorId: `${nodeId}:lock-archive`,
            mediaType: 'application/octet-stream',
            artifactType: 'application/vnd.openpacker.lock-import.v1',
            digest: parsedDigest,
            size: 0,
            nativeRole: 'package-archive' as const,
            extensions: {
              'org.openpacker.lock-import': {
                exactPurl,
                nativeArchive: true,
                sizeUnknown: true,
              },
            },
            locations: resolvedLocation === undefined ? [] : [resolvedLocation],
            referrers: [],
            externalRefs: [],
          },
        ];

  return {
    nodeId,
    identity: {
      canonicalPurl: formatPurl({
        type: parsed.type,
        ...(!(parsed.namespace === undefined) && {
          namespace: parsed.namespace,
        }),
        name: parsed.name,
        qualifiers: parsed.qualifiers,
        ...(!(parsed.subpath === undefined) && { subpath: parsed.subpath }),
      }),
      exactPurl,
      purlType: parsed.type,
      ...(!(parsed.namespace === undefined) && { namespace: parsed.namespace }),
      name: parsed.name,
      version: parsed.version,
      qualifiers: { ...parsed.qualifiers },
      ...(!(parsed.subpath === undefined) && { subpath: parsed.subpath }),
      nativeCoordinates: [
        {
          ecosystem,
          coordinate: entry.nativeCoordinate,
          version: parsed.version,
        },
      ],
      aliases: [],
      sourceRefs: [],
      publisherRefs: [],
      externalRefs: [],
    },
    nativeVersion: parsed.version,
    normalizedVersion: parsed.version,
    versionSortKey: parsed.version,
    requirements: [],
    capabilities: [],
    conflicts: [],
    cardinalityConstraints: [],
    artifacts,
    lifecycle: {
      status: 'unknown',
      eligible: false,
      warnings: [
        {
          code: 'LIFECYCLE_NOT_CAPTURED',
          message:
            'Native lockfiles carry no lifecycle status; registry lifecycle (yank, quarantine, revocation) was not consulted during import',
        },
      ],
    },
    sourceSnapshots: [sourceDigest],
    metadataDigest,
    nativeSemantics: {
      version: `${ecosystem}-lock-import-v1`,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      data: stripUndefined({
        nativeCoordinate: entry.nativeCoordinate,
        dependencies: entry.dependencies,
        native: entry.native,
      }) as JsonValue,
    },
    semanticLoss,
  };
}

function httpsArtifactLocation(resolved: string | undefined) {
  if (resolved === undefined) return undefined;
  try {
    const url = new URL(resolved);
    if (url.protocol !== 'https:' || url.username || url.password)
      return undefined;
    return {
      transport: 'https' as const,
      uri: url.toString(),
      priority: 0,
      rangeSupported: false,
    };
  } catch {
    return undefined;
  }
}

function stripUndefined(value: unknown): JsonValue {
  // SAFETY: The surrounding boundary establishes the asserted domain contract.
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function parseLooseDigest(value: string): Digest | undefined {
  if (value.startsWith('sha256:')) {
    const hex = value.slice('sha256:'.length).toLowerCase();
    if (/^[0-9a-f]{64}$/.test(hex)) return { algorithm: 'sha256', value: hex };
  }
  if (value.startsWith('sha256-')) {
    // npm integrity is base64-encoded SHA-256; decode when well-formed.
    try {
      const binary = atob(value.slice('sha256-'.length));
      let hex = '';
      for (let index = 0; index < binary.length; index += 1) {
        hex += binary.charCodeAt(index).toString(16).padStart(2, '0');
      }
      if (/^[0-9a-f]{64}$/.test(hex))
        return { algorithm: 'sha256', value: hex };
    } catch {
      // fall through
    }
  }
  // Non-sha256 native digests (sha512, Go h1:, none) are not representable;
  // callers record a NATIVE_DIGEST_NOT_REPRESENTED loss instead of fabricating.
  return undefined;
}

async function buildMinimalUniverse(
  packages: PackageInstance[],
  evaluationTime: string,
  sourceDigest: Digest,
): Promise<ResolutionUniverse> {
  const sorted = [...packages].sort((left, right) =>
    compareCanonicalStrings(left.nodeId, right.nodeId),
  );
  const recordsDigest = await canonicalDigest(
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    JSON.parse(
      JSON.stringify(sorted.map((item) => item.metadataDigest)),
    ) as JsonValue,
  );
  const snapshot = {
    snapshotId: formatDigest(sourceDigest),
    providerId: 'org.openpacker.lock-import',
    providerType: 'native-lock',
    endpointIdentity: 'lockfile',
    retrievedAt: evaluationTime,
    evaluationTime,
    rootDigest: sourceDigest,
    recordsDigest,
    evidenceRefs: [],
  };
  const body: Omit<ResolutionUniverse, 'canonicalDigest'> = {
    universeVersion: '1',
    packages: sorted,
    overlays: [],
    sourceSnapshots: [snapshot],
    lifecycleRoot: await canonicalDigest([]),
    targetVocabularyVersion: '1',
  };
  return {
    ...body,
    canonicalDigest: await projectedDigest(
      'universe-v1',
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      JSON.parse(JSON.stringify(body)) as JsonValue,
    ),
  };
}

async function mergePackagesIntoUniverse(
  universe: ResolutionUniverse,
  packages: PackageInstance[],
): Promise<ResolutionUniverse> {
  const byExact = new Map(
    universe.packages
      .filter((item) => item.identity.exactPurl)
      .map((item) => [item.identity.exactPurl!, item]),
  );
  for (const item of packages) {
    const exact = item.identity.exactPurl;
    if (!exact)
      throw new ProviderError(
        'INVALID_LOCKFILE',
        'Package instance is missing exactPurl',
      );
    const existing = byExact.get(exact);
    if (
      existing !== undefined &&
      new TextDecoder().decode(
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        canonicalBytes(stripUndefined(existing) as JsonValue),
      ) !==
        new TextDecoder().decode(
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          canonicalBytes(stripUndefined(item) as JsonValue),
        )
    )
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `Caller universe contradicts native lock package ${exact}`,
      );
    if (existing === undefined) byExact.set(exact, item);
  }
  const merged = {
    ...universe,
    packages: [...byExact.values()].sort((left, right) =>
      compareCanonicalStrings(left.nodeId, right.nodeId),
    ),
  };
  return {
    ...merged,
    canonicalDigest: await projectedDigest(
      'universe-v1',
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      JSON.parse(JSON.stringify(merged)) as JsonValue,
    ),
  };
}

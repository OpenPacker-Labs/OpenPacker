import { canonicalDigest, formatDigest, sha256 } from '@openpacker/canonical';
import type {
  ArtifactDescriptor,
  Digest,
  JsonValue,
  PackageIdentity,
  PackageInstance,
  Requirement,
  SemanticLoss,
  SourceSnapshot,
  VersionConstraint,
} from '@openpacker/contracts';
import {
  compareCodePoints,
  evaluateRange,
  formatPurl,
  header,
  json,
  packageNodeId,
  parsePurl,
  ProviderError,
  providerErrorForStatus,
  rangeToConstraint,
  renderRange,
  semanticLoss,
  sourceRef,
  verifyNativeDigest,
  type CatalogProvider,
  type Clock,
  type EcosystemCodec,
  type HttpTransport,
  type LockCapture,
  type NativeCoordinate,
  type ParsedRange,
  type ParsedVersion,
  type ProviderCapabilities,
  type ProviderInspection,
  type ProviderRecord,
  type RangeAst,
  type TranslatedMetadata,
  type TranslationProvenance,
} from '@openpacker/adapter-core';

/**
 * PEP 503 / packaging name normalization used as the common packaging normal
 * form for PyPI and PURL `pypi` names:
 * lowercase the name and replace runs of `[-_.]` with a single `-`.
 *
 * PURL documents underscore→hyphen lowercasing; PEP 503 (Simple API) and
 * packaging.utils.canonicalize_name additionally collapse dots and repeated
 * separators. OpenPacker applies the full PEP 503 form so Simple API paths,
 * JSON API keys, and PURLs agree.
 */
export function normalizePypiName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-');
}

export interface PypiFile {
  filename: string;
  packagetype: string;
  python_version?: string;
  url: string;
  size?: number;
  digests?: { sha256?: string; md5?: string; blake2b_256?: string };
  yanked?: boolean | string;
  yanked_reason?: string | null;
  requires_python?: string | null;
  upload_time?: string;
  upload_time_iso_8601?: string;
  [key: string]: unknown;
}

export interface PypiProjectInfo {
  name: string;
  version?: string;
  summary?: string;
  requires_python?: string | null;
  requires_dist?: (string | null)[] | null;
  yanked?: boolean | string;
  yanked_reason?: string | null;
  [key: string]: unknown;
}

/** PyPI JSON API project document (`/pypi/{name}/json`). */
export interface PypiProjectDocument {
  info: PypiProjectInfo;
  releases: Record<string, PypiFile[]>;
  urls?: PypiFile[];
  [key: string]: unknown;
}

/** Version-scoped JSON document (`/pypi/{name}/{version}/json`). */
export interface PypiVersionDocument {
  info: PypiProjectInfo;
  urls: PypiFile[];
  [key: string]: unknown;
}

export interface UvLockArtifact {
  url?: string;
  hash?: string;
  size?: number;
}

export interface UvLockDependency {
  name: string;
  version?: string;
  extra?: string[];
  marker?: string;
  specifier?: string;
}

export interface UvLockPackage {
  name: string;
  version: string;
  source?: {
    registry?: string;
    editable?: string;
    path?: string;
    git?: string;
    url?: string;
    [key: string]: unknown;
  };
  dependencies?: Array<UvLockDependency | string>;
  optional_dependencies?: Record<string, Array<UvLockDependency | string>>;
  sdist?: UvLockArtifact;
  wheels?: UvLockArtifact[];
  [key: string]: unknown;
}

/**
 * Structured representation of uv.lock version 1 (TOML projected to JSON).
 * Primary freeze format for the PyPI codec.
 */
export interface UvLockDocument {
  version: number;
  'requires-python'?: string;
  package: UvLockPackage[];
  [key: string]: unknown;
}

export type PypiMetadata =
  | { kind: 'project-version'; project: PypiProjectDocument; version: string }
  | { kind: 'version-document'; document: PypiVersionDocument };

interface Pep440Version {
  epoch: number;
  release: number[];
  pre: { letter: 'a' | 'b' | 'rc'; number: number } | null;
  post: number | null;
  dev: number | null;
  local: (string | number)[] | null;
  /** Raw form kept for `===` arbitrary equality. */
  original: string;
}

const PRE_ALIASES: Record<string, 'a' | 'b' | 'rc'> = {
  a: 'a',
  alpha: 'a',
  b: 'b',
  beta: 'b',
  c: 'rc',
  pre: 'rc',
  preview: 'rc',
  rc: 'rc',
};

function stripVersionV(value: string): string {
  const trimmed = value.trim();
  return /^v/i.test(trimmed) ? trimmed.slice(1) : trimmed;
}

export function parsePep440(value: string): Pep440Version {
  if (value.length > 256)
    throw new ProviderError(
      'INVALID_NATIVE_VERSION',
      'Version exceeds 256 characters',
    );
  const original = value;
  let rest = stripVersionV(value)
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1.$2');
  rest = rest.replace(/(\d)([a-z])/g, '$1.$2');

  let epoch = 0;
  const epochMatch = /^(\d+)!(.+)$/.exec(rest);
  if (epochMatch) {
    epoch = Number(epochMatch[1]);
    rest = epochMatch[2]!;
  }

  let local: (string | number)[] | null = null;
  const plus = rest.indexOf('+');
  if (plus >= 0) {
    const localText = rest.slice(plus + 1);
    rest = rest.slice(0, plus);
    if (localText === '' || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i.test(localText))
      throw new ProviderError(
        'INVALID_NATIVE_VERSION',
        `Invalid local version: ${value}`,
      );
    local = localText
      .split(/[._-]/)
      .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
  }

  const publicMatch =
    /^(\d+(?:\.\d+)*)(?:\.(a|alpha|b|beta|c|pre|preview|rc)\.?(\d+))?(?:\.(post)\.?(\d+))?(?:\.(dev)\.?(\d+))?$/.exec(
      rest,
    );
  if (!publicMatch)
    throw new ProviderError(
      'INVALID_NATIVE_VERSION',
      `Invalid PEP 440 version: ${value}`,
    );

  const release = publicMatch[1]!.split('.').map((part) => Number(part));
  if (release.some((part) => !Number.isFinite(part)))
    throw new ProviderError(
      'INVALID_NATIVE_VERSION',
      `Invalid PEP 440 version: ${value}`,
    );

  let pre: Pep440Version['pre'] = null;
  if (publicMatch[2] !== undefined) {
    const letter = PRE_ALIASES[publicMatch[2]!];
    if (letter === undefined)
      throw new ProviderError(
        'INVALID_NATIVE_VERSION',
        `Invalid PEP 440 version: ${value}`,
      );
    pre = { letter, number: Number(publicMatch[3] ?? 0) };
  }

  const post =
    publicMatch[4] !== undefined ? Number(publicMatch[5] ?? 0) : null;
  const dev = publicMatch[6] !== undefined ? Number(publicMatch[7] ?? 0) : null;

  // Implicit .0 for bare `1.0a` is already covered by the \d+ requirement after
  // separator insertion. Accept common forms like `1.0.dev0` via rewrite below.
  return { epoch, release, pre, post, dev, local, original };
}

/**
 * Loose PEP 440 parser that also accepts `1.0a1`, `1.0.post1`, `1!1.0` after
 * separator normalization, plus trailing `.postN` / `.devN` order variants.
 */
export function parsePep440Loose(value: string): Pep440Version {
  try {
    return parsePep440(value);
  } catch {
    // Fall through to a more permissive path for mixed segment order.
  }
  if (value.length > 256)
    throw new ProviderError(
      'INVALID_NATIVE_VERSION',
      'Version exceeds 256 characters',
    );
  const original = value;
  let rest = stripVersionV(value).toLowerCase();
  rest = rest.replace(/[-_]/g, '.');
  rest = rest.replace(/([a-z])(\d)/g, '$1.$2').replace(/(\d)([a-z])/g, '$1.$2');

  let epoch = 0;
  const epochMatch = /^(\d+)!(.+)$/.exec(rest);
  if (epochMatch) {
    epoch = Number(epochMatch[1]);
    rest = epochMatch[2]!;
  }

  let local: (string | number)[] | null = null;
  const plus = rest.indexOf('+');
  if (plus >= 0) {
    const localText = rest.slice(plus + 1);
    rest = rest.slice(0, plus);
    if (localText === '')
      throw new ProviderError(
        'INVALID_NATIVE_VERSION',
        `Invalid PEP 440 version: ${value}`,
      );
    local = localText
      .split(/[._-]/)
      .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
  }

  const parts = rest.split('.').filter(Boolean);
  if (parts.length === 0 || !/^\d+$/.test(parts[0]!))
    throw new ProviderError(
      'INVALID_NATIVE_VERSION',
      `Invalid PEP 440 version: ${value}`,
    );

  const release: number[] = [];
  let index = 0;
  while (index < parts.length && /^\d+$/.test(parts[index]!)) {
    release.push(Number(parts[index]));
    index += 1;
  }

  let pre: Pep440Version['pre'] = null;
  let post: number | null = null;
  let dev: number | null = null;

  while (index < parts.length) {
    const token = parts[index]!;
    if (token in PRE_ALIASES) {
      const letter = PRE_ALIASES[token]!;
      const number =
        index + 1 < parts.length && /^\d+$/.test(parts[index + 1]!)
          ? Number(parts[++index])
          : 0;
      pre = { letter, number };
      index += 1;
      continue;
    }
    if (token === 'post') {
      const number =
        index + 1 < parts.length && /^\d+$/.test(parts[index + 1]!)
          ? Number(parts[++index])
          : 0;
      post = number;
      index += 1;
      continue;
    }
    if (token === 'dev') {
      const number =
        index + 1 < parts.length && /^\d+$/.test(parts[index + 1]!)
          ? Number(parts[++index])
          : 0;
      dev = number;
      index += 1;
      continue;
    }
    if (token === 'r' || token === 'rev') {
      const number =
        index + 1 < parts.length && /^\d+$/.test(parts[index + 1]!)
          ? Number(parts[++index])
          : 0;
      post = number;
      index += 1;
      continue;
    }
    throw new ProviderError(
      'INVALID_NATIVE_VERSION',
      `Invalid PEP 440 version: ${value}`,
    );
  }

  return { epoch, release, pre, post, dev, local, original };
}

export function normalizePep440(version: Pep440Version): string {
  const release = version.release.map(String).join('.');
  const pre =
    version.pre === null ? '' : `${version.pre.letter}${version.pre.number}`;
  const post = version.post === null ? '' : `.post${version.post}`;
  const dev = version.dev === null ? '' : `.dev${version.dev}`;
  const local =
    version.local === null ? '' : `+${version.local.map(String).join('.')}`;
  const epoch = version.epoch === 0 ? '' : `${version.epoch}!`;
  return `${epoch}${release}${pre}${post}${dev}${local}`;
}

function compareLocal(
  left: (string | number)[] | null,
  right: (string | number)[] | null,
): number {
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNum = typeof a === 'number';
    const bNum = typeof b === 'number';
    if (aNum && bNum) return Math.sign(a - b);
    if (aNum) return -1;
    if (bNum) return 1;
    return compareCodePoints(String(a), String(b));
  }
  return 0;
}

const PRE_RANK: Record<'a' | 'b' | 'rc', number> = { a: 0, b: 1, rc: 2 };

export function comparePep440(
  left: Pep440Version,
  right: Pep440Version,
): number {
  if (left.epoch !== right.epoch) return Math.sign(left.epoch - right.epoch);
  const releaseLength = Math.max(left.release.length, right.release.length);
  for (let index = 0; index < releaseLength; index += 1) {
    const difference = (left.release[index] ?? 0) - (right.release[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }

  // dev without pre/post sorts before a release (1.0.dev0 < 1.0).
  const leftDevOnly =
    left.dev !== null && left.pre === null && left.post === null;
  const rightDevOnly =
    right.dev !== null && right.pre === null && right.post === null;
  if (leftDevOnly !== rightDevOnly) return leftDevOnly ? -1 : 1;

  if (left.pre === null && right.pre !== null) return 1;
  if (left.pre !== null && right.pre === null) return -1;
  if (left.pre !== null && right.pre !== null) {
    const letter = PRE_RANK[left.pre.letter] - PRE_RANK[right.pre.letter];
    if (letter !== 0) return Math.sign(letter);
    if (left.pre.number !== right.pre.number)
      return Math.sign(left.pre.number - right.pre.number);
  }

  // With equal pre, a bare pre sorts after pre.dev (1.0a1.dev0 < 1.0a1).
  if (left.dev !== null || right.dev !== null) {
    if (left.post === null && right.post === null) {
      if (left.dev === null && right.dev !== null) return 1;
      if (left.dev !== null && right.dev === null) return -1;
      if (left.dev !== null && right.dev !== null && left.dev !== right.dev)
        return Math.sign(left.dev - right.dev);
    }
  }

  if (left.post === null && right.post !== null) return -1;
  if (left.post !== null && right.post === null) return 1;
  if (left.post !== null && right.post !== null && left.post !== right.post)
    return Math.sign(left.post - right.post);

  if (left.dev === null && right.dev !== null) return 1;
  if (left.dev !== null && right.dev === null) return -1;
  if (left.dev !== null && right.dev !== null && left.dev !== right.dev)
    return Math.sign(left.dev - right.dev);

  return compareLocal(left.local, right.local);
}

function pep440ToParsed(version: Pep440Version): ParsedVersion {
  return {
    original: version.original,
    normalized: normalizePep440(version),
    release: [version.epoch, ...version.release],
    prerelease:
      version.pre === null
        ? version.dev === null
          ? []
          : ['dev', version.dev]
        : [version.pre.letter, version.pre.number],
    build: version.local === null ? [] : version.local.map(String),
  };
}

function comparison(
  operator: '=' | '!=' | '>' | '>=' | '<' | '<=',
  version: string,
): RangeAst {
  return { type: 'comparison', operator, version };
}

function conjunction(items: readonly RangeAst[]): RangeAst {
  if (items.length === 0) return { type: 'any' };
  if (items.length === 1) return items[0]!;
  return { type: 'and', items };
}

function compatibleReleaseBounds(version: Pep440Version): RangeAst {
  // ~=X.Y.Z → >=X.Y.Z, ==X.Y.*
  if (version.release.length < 2)
    throw new ProviderError(
      'INVALID_NATIVE_RANGE',
      `Compatible release requires at least two release segments: ${version.original}`,
    );
  const lower = normalizePep440({
    ...version,
    local: null,
  });
  const prefix = version.release.slice(0, -1);
  const upper = [...prefix];
  upper[upper.length - 1] = upper[upper.length - 1]! + 1;
  while (upper.length < version.release.length) upper.push(0);
  return conjunction([
    comparison('>=', lower),
    comparison(
      '<',
      normalizePep440({
        epoch: version.epoch,
        release: upper,
        pre: null,
        post: null,
        dev: null,
        local: null,
        original: upper.join('.'),
      }),
    ),
  ]);
}

function prefixMatchEquals(
  version: Pep440Version,
  pattern: Pep440Version,
  trailingWildcard: boolean,
): boolean {
  if (version.epoch !== pattern.epoch) return false;
  if (trailingWildcard) {
    if (version.release.length < pattern.release.length) return false;
    for (let index = 0; index < pattern.release.length; index += 1) {
      if (version.release[index] !== pattern.release[index]) return false;
    }
    // `==1.1.*` excludes prereleases of that series unless the pattern itself
    // is a prerelease — keep pattern public-only semantics.
    if (pattern.pre === null && version.pre !== null) return false;
    if (pattern.dev === null && pattern.pre === null && version.dev !== null)
      return false;
    return true;
  }
  return comparePep440(
    { ...version, local: null },
    { ...pattern, local: null },
  ) === 0
    ? pattern.local === null || compareLocal(version.local, pattern.local) === 0
    : false;
}

interface ParsedSpecifier {
  operator: '===' | '==' | '!=' | '<=' | '>=' | '<' | '>' | '~=';
  versionText: string;
  wildcard: boolean;
  version: Pep440Version | null;
}

function parseSpecifierToken(token: string): ParsedSpecifier {
  const match =
    /^(===|==|!=|<=|>=|<|>|~=)\s*(.+)$/.exec(token.trim()) ??
    (() => {
      throw new ProviderError(
        'INVALID_NATIVE_RANGE',
        `Invalid PEP 440 specifier: ${token}`,
      );
    })();
  const operator = match[1] as ParsedSpecifier['operator'];
  let versionText = match[2]!.trim();
  if (versionText.startsWith('(') && versionText.endsWith(')'))
    versionText = versionText.slice(1, -1).trim();
  const wildcard = /\.\*$/.test(versionText);
  if (wildcard) {
    if (operator !== '==' && operator !== '!=')
      throw new ProviderError(
        'INVALID_NATIVE_RANGE',
        `Prefix matching is only valid with == or !=: ${token}`,
      );
    const base = versionText.slice(0, -2);
    return {
      operator,
      versionText,
      wildcard: true,
      version: parsePep440Loose(base === '' ? '0' : base),
    };
  }
  if (operator === '===')
    return { operator, versionText, wildcard: false, version: null };
  return {
    operator,
    versionText,
    wildcard: false,
    version: parsePep440Loose(versionText),
  };
}

function specifierToAst(spec: ParsedSpecifier): {
  ast: RangeAst;
  exact: boolean;
  loss: SemanticLoss[];
} {
  if (spec.operator === '===') {
    return {
      ast: comparison('=', spec.versionText),
      exact: false,
      loss: [
        semanticLoss(
          'pypi',
          'PYPI_ARBITRARY_EQUALITY',
          '/range',
          'PEP 440 arbitrary equality (===) compares unnormalized strings and has no exact VERS encoding',
          undefined,
          'error',
        ),
      ],
    };
  }
  if (spec.operator === '~=') {
    const version = spec.version!;
    return {
      ast: compatibleReleaseBounds(version),
      exact: false,
      loss: [
        semanticLoss(
          'pypi',
          'PYPI_COMPATIBLE_RELEASE',
          '/range',
          'PEP 440 compatible release (~=) is expanded natively; VERS encoding is not claimed as reversible',
        ),
      ],
    };
  }
  if (spec.wildcard) {
    const pattern = spec.version!;
    const lower = normalizePep440({
      epoch: pattern.epoch,
      release: [...pattern.release],
      pre: null,
      post: null,
      dev: null,
      local: null,
      original: pattern.release.join('.'),
    });
    const upperRelease = [...pattern.release];
    upperRelease[upperRelease.length - 1] =
      upperRelease[upperRelease.length - 1]! + 1;
    const upper = normalizePep440({
      epoch: pattern.epoch,
      release: upperRelease,
      pre: null,
      post: null,
      dev: null,
      local: null,
      original: upperRelease.join('.'),
    });
    const ast =
      spec.operator === '=='
        ? conjunction([comparison('>=', lower), comparison('<', upper)])
        : {
            type: 'or' as const,
            items: [comparison('<', lower), comparison('>=', upper)],
          };
    return {
      ast,
      exact: false,
      loss: [
        semanticLoss(
          'pypi',
          'PYPI_PREFIX_MATCH',
          '/range',
          'PEP 440 prefix matching (.*) is approximated with release bounds; prerelease edge cases stay native-only',
        ),
      ],
    };
  }
  const normalized = normalizePep440(spec.version!);
  const operator =
    spec.operator === '=='
      ? '='
      : (spec.operator as '=' | '!=' | '>' | '>=' | '<' | '<=');
  return {
    ast: comparison(operator, normalized),
    exact: operator === '=',
    loss: [],
  };
}

function pypiVers(ast: RangeAst): string | undefined {
  if (ast.type === 'any') return '*';
  if (ast.type === 'comparison') return `${ast.operator}${ast.version}`;
  if (ast.type === 'or') return undefined;
  const parts = ast.items.map(pypiVers);
  return parts.some((part) => part === undefined) ? undefined : parts.join('|');
}

export interface ParsedRequirement {
  name: string;
  extras: string[];
  specifier: string;
  marker: string | undefined;
  original: string;
}

/**
 * Parse a PEP 508 requirement string into name, extras, specifier, and marker.
 * Markers are never evaluated: callers must record SemanticLoss instead.
 */
export function parsePep508Requirement(value: string): ParsedRequirement {
  const original = value.trim();
  if (original === '' || original.length > 4096)
    throw new ProviderError(
      'INVALID_NATIVE_RANGE',
      `Invalid PEP 508 requirement: ${value}`,
    );

  let rest = original;
  let marker: string | undefined;
  const markerSplit = /;(?=(?:[^"]*"[^"]*")*[^"]*$)/.exec(rest);
  if (markerSplit && markerSplit.index !== undefined) {
    marker = rest.slice(markerSplit.index + 1).trim();
    rest = rest.slice(0, markerSplit.index).trim();
  }

  const nameMatch = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/.exec(rest);
  if (!nameMatch)
    throw new ProviderError(
      'INVALID_NATIVE_COORDINATE',
      `Invalid PEP 508 requirement name: ${value}`,
    );
  const rawName = nameMatch[1]!;
  rest = rest.slice(rawName.length).trim();

  let extras: string[] = [];
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end < 0)
      throw new ProviderError(
        'INVALID_NATIVE_RANGE',
        `Unclosed extras in requirement: ${value}`,
      );
    extras = rest
      .slice(1, end)
      .split(',')
      .map((extra) => extra.trim())
      .filter(Boolean)
      .map((extra) => normalizePypiName(extra));
    rest = rest.slice(end + 1).trim();
  }

  if (rest.startsWith('(') && rest.endsWith(')'))
    rest = rest.slice(1, -1).trim();

  return {
    name: normalizePypiName(rawName),
    extras,
    specifier: rest,
    marker: marker === '' ? undefined : marker,
    original,
  };
}

function pypiIdentity(exactPurl: string, endpoint?: string): PackageIdentity {
  const parsed = parsePurl(exactPurl);
  const identity: PackageIdentity = {
    canonicalPurl: formatPurl({ ...parsed, version: undefined }),
    purlType: 'pypi',
    name: parsed.name,
    qualifiers: { ...parsed.qualifiers },
    nativeCoordinates: [
      {
        ecosystem: 'pypi',
        coordinate: parsed.name,
        ...(parsed.version === undefined ? {} : { version: parsed.version }),
      },
    ],
    aliases: [],
    sourceRefs: endpoint === undefined ? [] : [sourceRef('pypi', endpoint)],
    publisherRefs: [],
    externalRefs: [],
  };
  if (parsed.version !== undefined) {
    identity.version = parsed.version;
    identity.exactPurl = formatPurl(parsed);
  }
  return identity;
}

function isYanked(value: boolean | string | undefined): boolean {
  return value === true || (typeof value === 'string' && value.length > 0);
}

function sha256Digest(value: string | undefined): Digest | undefined {
  if (value === undefined) return undefined;
  const hex = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return undefined;
  return { algorithm: 'sha256', value: hex };
}

function fileArtifact(
  nodeId: string,
  file: PypiFile,
  index: number,
): ArtifactDescriptor | undefined {
  const digest = sha256Digest(file.digests?.sha256);
  if (!digest || file.size === undefined) return undefined;
  const isWheel = file.packagetype === 'bdist_wheel';
  const isSdist =
    file.packagetype === 'sdist' || file.packagetype === 'sdist.source';
  return {
    descriptorId: `${nodeId}:${isWheel ? 'wheel' : isSdist ? 'sdist' : 'file'}:${index}`,
    digest,
    size: file.size,
    mediaType: isWheel
      ? 'application/zip'
      : isSdist
        ? 'application/gzip'
        : 'application/octet-stream',
    artifactType: isWheel
      ? 'application/vnd.openpacker.pypi.wheel.v1+zip'
      : isSdist
        ? 'application/vnd.openpacker.pypi.sdist.v1+tar'
        : 'application/vnd.openpacker.pypi.file.v1',
    fileName: file.filename,
    nativeRole: isWheel ? 'wheel' : isSdist ? 'sdist' : 'distribution',
    locations: [
      {
        transport: 'https',
        uri: file.url,
        priority: index,
        rangeSupported: true,
      },
    ],
    referrers: [],
    externalRefs: [],
  };
}

export class PypiCodec
  implements EcosystemCodec<PypiMetadata, UvLockDocument | string>
{
  readonly purlType = 'pypi' as const;

  parseNativeCoordinate(value: string): NativeCoordinate {
    const trimmed = value.trim();
    // Accept `name`, `name==1.0`, `name@1.0`, and bare PEP 508 name prefixes.
    const at = /^([^@/\s]+)@(.+)$/.exec(trimmed);
    if (at) {
      return {
        ecosystem: 'pypi',
        name: normalizePypiName(at[1]!),
        original: value,
        version: at[2],
      };
    }
    try {
      const requirement = parsePep508Requirement(trimmed);
      return {
        ecosystem: 'pypi',
        name: requirement.name,
        original: value,
        ...(requirement.specifier.startsWith('==') &&
        !requirement.specifier.includes(',')
          ? {
              version: requirement.specifier
                .replace(/^===\s*/, '')
                .replace(/^==\s*/, '')
                .replace(/\.\*$/, ''),
            }
          : {}),
      };
    } catch {
      const match = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)$/.exec(
        trimmed,
      );
      if (!match)
        throw new ProviderError(
          'INVALID_NATIVE_COORDINATE',
          `Invalid PyPI coordinate: ${value}`,
        );
      return {
        ecosystem: 'pypi',
        name: normalizePypiName(match[1]!),
        original: value,
      };
    }
  }

  canonicalizePurl(value: string): string {
    const parsed = parsePurl(value);
    if (parsed.type !== 'pypi' || parsed.namespace !== undefined)
      throw new ProviderError(
        'INVALID_PURL',
        'PyPI PURLs do not have namespaces',
      );
    return formatPurl({
      ...parsed,
      name: normalizePypiName(parsed.name),
      ...(parsed.version === undefined
        ? {}
        : { version: this.parseNativeVersion(parsed.version).normalized }),
    });
  }

  parseNativeVersion(value: string): ParsedVersion {
    return pep440ToParsed(parsePep440Loose(value));
  }

  compareNativeVersions(left: string, right: string): number {
    return comparePep440(parsePep440Loose(left), parsePep440Loose(right));
  }

  parseNativeRange(value: string): ParsedRange {
    if (value.length > 4096)
      throw new ProviderError(
        'INVALID_NATIVE_RANGE',
        'Native range exceeds 4096 characters',
      );
    const original = value;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === '*') {
      return {
        scheme: 'pypi',
        original,
        normalized: '*',
        ast: { type: 'any' },
        vers: 'vers:pypi/*',
        reversible: true,
        semanticLoss: [],
      };
    }

    // Full PEP 508 requirement — extract specifier + marker losses.
    if (/^[A-Za-z0-9]/.test(trimmed) && /[;[]/.test(trimmed)) {
      const requirement = parsePep508Requirement(trimmed);
      const base =
        requirement.specifier === ''
          ? this.parseNativeRange('*')
          : this.parseNativeRange(requirement.specifier);
      const losses: SemanticLoss[] = [...base.semanticLoss];
      if (requirement.marker !== undefined) {
        losses.push(
          semanticLoss(
            'pypi',
            'PYPI_ENVIRONMENT_MARKER',
            '/marker',
            `Environment marker ${requirement.marker} is preserved and never silently evaluated`,
            'Marker is retained in nativeSemantics; membership is not claimed without a marker evaluator',
            'error',
          ),
        );
      }
      if (requirement.extras.length > 0) {
        losses.push(
          semanticLoss(
            'pypi',
            'PYPI_EXTRAS_NOT_CAPABILITIES',
            '/extras',
            `Extras [${requirement.extras.join(',')}] are native feature labels, not PREX capabilities`,
          ),
        );
      }
      return {
        scheme: 'pypi',
        original,
        normalized: base.normalized,
        ast: base.ast,
        reversible: false,
        semanticLoss: losses,
        ...(base.vers === undefined || requirement.marker !== undefined
          ? {}
          : { vers: base.vers }),
      };
    }

    const tokens = trimmed
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean);
    if (tokens.length === 0)
      throw new ProviderError(
        'INVALID_NATIVE_RANGE',
        `Invalid PEP 440 specifier set: ${value}`,
      );

    const parsedTokens = tokens.map(parseSpecifierToken);
    const pieces = parsedTokens.map(specifierToAst);
    const ast = conjunction(pieces.map((piece) => piece.ast));
    const losses = pieces.flatMap((piece) => piece.loss);
    const exactOnly =
      pieces.every((piece) => piece.exact) && pieces.length === 1;
    const versBody =
      losses.length === 0 && exactOnly
        ? pypiVers(ast)
        : losses.some(
              (loss) =>
                loss.code === 'PYPI_ARBITRARY_EQUALITY' ||
                loss.code === 'PYPI_PREFIX_MATCH',
            )
          ? undefined
          : pieces.every(
                (piece) =>
                  piece.loss.length === 0 ||
                  piece.loss.every(
                    (loss) => loss.code === 'PYPI_COMPATIBLE_RELEASE',
                  ),
              )
            ? pypiVers(ast)
            : pypiVers(ast);
    // Prefer VERS when every clause is a simple comparison (including expanded ~=).
    const simple =
      losses.every(
        (loss) =>
          loss.code === 'PYPI_COMPATIBLE_RELEASE' ||
          loss.code === 'PYPI_PREFIX_MATCH',
      ) && versBody !== undefined;
    const finalVers =
      simple || (losses.length === 0 && versBody !== undefined)
        ? `vers:pypi/${versBody}`
        : undefined;
    // Compatible release / prefix match still not reversible to original text.
    const reversible =
      finalVers !== undefined &&
      losses.every((loss) => loss.code !== 'PYPI_COMPATIBLE_RELEASE') &&
      losses.every((loss) => loss.code !== 'PYPI_PREFIX_MATCH') &&
      losses.every((loss) => loss.code !== 'PYPI_ARBITRARY_EQUALITY');

    return {
      scheme: 'pypi',
      original,
      normalized: renderRange(ast),
      ast,
      reversible,
      semanticLoss: losses,
      ...(finalVers === undefined ? {} : { vers: finalVers }),
    };
  }

  toVers(value: string): VersionConstraint {
    return rangeToConstraint(this.parseNativeRange(value));
  }

  satisfies(version: string, range: string | ParsedRange): boolean {
    const original = typeof range === 'string' ? range : range.original;
    // Prefer native specifier evaluation so == ignores local segments, === is
    // raw, ~= expands correctly, and markers never short-circuit to false.
    if (/^[A-Za-z0-9]/.test(original.trim()) && /[;[]/.test(original)) {
      const requirement = parsePep508Requirement(original);
      if (requirement.specifier === '' || requirement.specifier === '*')
        return true;
      return this.satisfies(version, requirement.specifier);
    }
    const trimmed = original.trim();
    if (trimmed === '' || trimmed === '*') return true;
    const tokens = trimmed
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean);
    if (
      tokens.length > 0 &&
      tokens.every((token) => /^(===|==|!=|<=|>=|<|>|~=)/.test(token))
    ) {
      return tokens.every((token) =>
        this.satisfiesSpecifier(version, parseSpecifierToken(token)),
      );
    }
    const parsedRange =
      typeof range === 'string' ? this.parseNativeRange(range) : range;
    return evaluateRange(version, parsedRange.ast, (left, right) =>
      this.compareNativeVersions(left, right),
    );
  }

  private satisfiesSpecifier(version: string, spec: ParsedSpecifier): boolean {
    const left = parsePep440Loose(version);
    if (spec.operator === '===')
      return stripVersionV(version) === stripVersionV(spec.versionText);
    if (spec.wildcard) {
      const matched = prefixMatchEquals(left, spec.version!, true);
      return spec.operator === '==' ? matched : !matched;
    }
    if (spec.operator === '~=') {
      const bounds = compatibleReleaseBounds(spec.version!);
      return evaluateRange(version, bounds, (a, b) =>
        this.compareNativeVersions(a, b),
      );
    }
    const right = normalizePep440(spec.version!);
    const order = this.compareNativeVersions(version, right);
    switch (spec.operator) {
      case '==':
        // Local versions: `==1.0` matches `1.0+local` (public version equal).
        return (
          comparePep440(
            { ...left, local: null },
            { ...spec.version!, local: null },
          ) === 0
        );
      case '!=':
        return (
          comparePep440(
            { ...left, local: null },
            { ...spec.version!, local: null },
          ) !== 0
        );
      case '<':
        return order < 0;
      case '<=':
        return order <= 0;
      case '>':
        return order > 0;
      case '>=':
        return order >= 0;
    }
  }

  async translateMetadata(
    metadata: PypiMetadata,
    provenance: TranslationProvenance,
  ): Promise<TranslatedMetadata> {
    const info =
      metadata.kind === 'project-version'
        ? {
            ...metadata.project.info,
            version: metadata.version,
            name: metadata.project.info.name,
          }
        : metadata.document.info;
    const version = info.version;
    if (version === undefined)
      throw new ProviderError(
        'INVALID_PROVIDER_METADATA',
        'PyPI metadata is missing version',
      );
    const name = normalizePypiName(info.name);
    const exactPurl = this.canonicalizePurl(
      formatPurl({
        type: 'pypi',
        name,
        version,
        qualifiers: {},
      }),
    );
    const nodeId = await packageNodeId({
      exactPurl,
      nativeSemanticsVersion: 'pypi-v1',
    });
    const files =
      metadata.kind === 'project-version'
        ? (metadata.project.releases[version] ?? [])
        : metadata.document.urls;
    const losses: SemanticLoss[] = [];
    const requirements: Requirement[] = [];
    for (const [index, raw] of (info.requires_dist ?? []).entries()) {
      if (raw === null || raw === undefined || raw.trim() === '') continue;
      const requirement = parsePep508Requirement(raw);
      const range =
        requirement.specifier === ''
          ? this.parseNativeRange('*')
          : this.parseNativeRange(requirement.specifier);
      const requirementLosses: SemanticLoss[] = [...range.semanticLoss];
      if (requirement.marker !== undefined) {
        requirementLosses.push(
          semanticLoss(
            'pypi',
            'PYPI_ENVIRONMENT_MARKER',
            `/requires_dist/${index}/marker`,
            `Environment marker ${requirement.marker} is preserved and never silently evaluated`,
            'Requirement remains open with respect to markers; do not treat as false',
            'error',
          ),
        );
      }
      if (requirement.extras.length > 0) {
        requirementLosses.push(
          semanticLoss(
            'pypi',
            'PYPI_EXTRAS_NOT_CAPABILITIES',
            `/requires_dist/${index}/extras`,
            `Extras [${requirement.extras.join(',')}] are retained in nativeSemantics, not PREX capabilities`,
          ),
        );
      }
      requirements.push({
        id: `${nodeId}:runtime:${requirement.name}:${index}`,
        dependerNodeId: nodeId,
        expression: {
          type: 'package',
          purl: formatPurl({
            type: 'pypi',
            name: requirement.name,
            qualifiers: {},
          }),
          ...(range.vers === undefined || requirement.marker !== undefined
            ? {}
            : { vers: range.vers }),
        },
        kind: 'runtime',
        optional: requirement.marker !== undefined,
        source: sourceRef('pypi', provenance.endpoint),
        authority: 'native',
        raw: raw,
        nativeSemantics: {
          version: 'pypi-v1',
          data: {
            requirement: raw,
            extras: requirement.extras,
            specifier: requirement.specifier,
            ...(requirement.marker === undefined
              ? {}
              : { marker: requirement.marker }),
          } as JsonValue,
        },
        semanticLoss: requirementLosses,
      });
    }
    requirements.sort((left, right) => compareCodePoints(left.id, right.id));

    if (info.requires_python)
      losses.push(
        semanticLoss(
          'pypi',
          'PYPI_REQUIRES_PYTHON_NATIVE',
          '/info/requires_python',
          `requires_python=${info.requires_python} is Python interpreter compatibility, retained natively`,
          undefined,
          'error',
        ),
      );

    const artifacts: ArtifactDescriptor[] = [];
    files.forEach((file, index) => {
      const artifact = fileArtifact(nodeId, file, index);
      if (artifact) artifacts.push(artifact);
      else if (file.url)
        losses.push(
          semanticLoss(
            'pypi',
            'PYPI_SHA256_OR_SIZE_MISSING',
            `/files/${index}`,
            `Distribution ${file.filename} lacks sha256 or size; native digests remain in raw metadata`,
          ),
        );
    });

    const yanked =
      isYanked(info.yanked) || files.some((file) => isYanked(file.yanked));
    const instance: PackageInstance = {
      nodeId,
      identity: pypiIdentity(exactPurl, provenance.endpoint),
      nativeVersion: version,
      normalizedVersion: this.parseNativeVersion(version).normalized,
      versionSortKey: this.parseNativeVersion(version).normalized,
      requirements,
      capabilities: [],
      conflicts: [],
      cardinalityConstraints: [],
      artifacts,
      lifecycle: {
        status: yanked ? 'yanked' : 'published',
        eligible: !yanked,
        warnings: yanked
          ? [
              {
                code: 'PYPI_YANKED',
                message:
                  typeof info.yanked === 'string'
                    ? info.yanked
                    : (info.yanked_reason ??
                      'Version is yanked on the PyPI index'),
              },
            ]
          : [],
      },
      sourceSnapshots:
        provenance.snapshotDigest === undefined
          ? []
          : [provenance.snapshotDigest],
      metadataDigest: provenance.metadataDigest,
      nativeSemantics: {
        version: 'pypi-v1',
        data: {
          requiresPython: info.requires_python ?? null,
          requiresDist: info.requires_dist ?? [],
          files: files.map((file) => ({
            filename: file.filename,
            packagetype: file.packagetype,
            url: file.url,
            size: file.size ?? null,
            sha256: file.digests?.sha256 ?? null,
            yanked: isYanked(file.yanked),
          })),
        } as JsonValue,
      },
      semanticLoss: losses,
    };
    if (provenance.rawMetadataRef !== undefined)
      instance.rawMetadataRef = provenance.rawMetadataRef;
    return {
      instance,
      rawMetadata:
        metadata.kind === 'project-version'
          ? metadata.project
          : metadata.document,
    };
  }

  translateLockResult(
    lockInput: UvLockDocument | string,
    provenance: TranslationProvenance,
  ): LockCapture {
    const lock =
      typeof lockInput === 'string'
        ? (JSON.parse(lockInput) as UvLockDocument)
        : lockInput;
    if (lock.version !== 1)
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `Expected uv.lock version 1, received ${String(lock.version)}`,
      );
    if (!Array.isArray(lock.package))
      throw new ProviderError(
        'INVALID_LOCKFILE',
        'uv.lock is missing package array',
      );

    const losses: SemanticLoss[] = [];
    if (lock['requires-python'])
      losses.push(
        semanticLoss(
          'pypi',
          'PYPI_LOCK_REQUIRES_PYTHON',
          '/requires-python',
          `Lock requires-python=${lock['requires-python']} is retained; interpreter filtering is native`,
        ),
      );

    const packages = lock.package
      .map((entry) => {
        const name = normalizePypiName(entry.name);
        const exactPurl = this.canonicalizePurl(
          formatPurl({
            type: 'pypi',
            name,
            version: entry.version,
            qualifiers: {},
          }),
        );
        const dependencies: Record<string, string> = {};
        for (const dep of entry.dependencies ?? []) {
          if (typeof dep === 'string')
            dependencies[normalizePypiName(dep)] = 'locked';
          else {
            dependencies[normalizePypiName(dep.name)] =
              dep.specifier ?? 'locked';
            if (dep.marker !== undefined)
              losses.push(
                semanticLoss(
                  'pypi',
                  'PYPI_ENVIRONMENT_MARKER',
                  `/package/${entry.name}/dependencies/${dep.name}/marker`,
                  `Lock dependency marker ${dep.marker} is preserved and never silently evaluated`,
                  undefined,
                  'error',
                ),
              );
            if (dep.extra !== undefined && dep.extra.length > 0)
              losses.push(
                semanticLoss(
                  'pypi',
                  'PYPI_EXTRAS_NOT_CAPABILITIES',
                  `/package/${entry.name}/dependencies/${dep.name}/extra`,
                  `Lock dependency extras [${dep.extra.join(',')}] retained natively`,
                ),
              );
          }
        }
        const wheelHash = entry.wheels?.[0]?.hash;
        const sdistHash = entry.sdist?.hash;
        const artifactDigest = wheelHash ?? sdistHash;
        const resolved =
          entry.wheels?.[0]?.url ??
          entry.sdist?.url ??
          entry.source?.registry ??
          entry.source?.url;
        return {
          exactPurl,
          nativeCoordinate: `${name}@${entry.version}`,
          ...(resolved === undefined ? {} : { resolved }),
          ...(artifactDigest === undefined ? {} : { artifactDigest }),
          dependencies,
          native: entry,
        };
      })
      .sort((left, right) =>
        compareCodePoints(left.exactPurl, right.exactPurl),
      );

    return {
      format: 'uv.lock',
      formatVersion: '1',
      sourceDigest: formatDigest(provenance.metadataDigest),
      packages,
      semanticLoss: losses,
    };
  }
}

export class PypiJsonProvider implements CatalogProvider {
  readonly providerId = 'pypi-json';
  readonly capabilities: ProviderCapabilities = {
    operations: ['identify', 'enumerate', 'inspect', 'artifact', 'snapshot'],
    purlTypes: ['pypi'],
    qualifierSupport: 'partial',
    targetSpecificSemantics: true,
    offlineReplay: true,
    extensions: { 'openpacker.dev/pypi-api': 'json-v1' },
  };
  readonly #records = new Map<string, ProviderRecord<PypiProjectDocument>>();

  constructor(
    private readonly transport: HttpTransport,
    private readonly clock: Clock,
    private readonly endpoint = 'https://pypi.org/pypi',
    private readonly codec = new PypiCodec(),
  ) {}

  async identify(query: string): Promise<readonly PackageIdentity[]> {
    const purl = query.startsWith('pkg:')
      ? this.codec.canonicalizePurl(query)
      : this.purlFor(this.codec.parseNativeCoordinate(query));
    return [pypiIdentity(purl, this.endpoint)];
  }

  invalidate(purl?: string): void {
    if (purl === undefined) this.#records.clear();
    else {
      const parsed = parsePurl(this.codec.canonicalizePurl(purl));
      this.#records.delete(formatPurl({ ...parsed, version: undefined }));
    }
  }

  async enumerate(
    basePurl: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const record = await this.project(basePurl, signal);
    return Object.keys(record.body.releases)
      .sort((left, right) => this.codec.compareNativeVersions(left, right))
      .map((version) =>
        this.codec.canonicalizePurl(
          `${this.codec.canonicalizePurl(basePurl)}@${version}`,
        ),
      );
  }

  async inspect(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderInspection> {
    const canonical = this.codec.canonicalizePurl(exactPurl);
    const parsed = parsePurl(canonical);
    if (!parsed.version)
      throw new ProviderError(
        'VERSION_NOT_FOUND',
        'inspect requires an exact PyPI PURL',
      );
    const record = await this.project(
      formatPurl({ ...parsed, version: undefined }),
      signal,
    );
    if (!(parsed.version in record.body.releases)) {
      // Try normalized version key match.
      const match = Object.keys(record.body.releases).find(
        (version) =>
          this.codec.compareNativeVersions(version, parsed.version!) === 0,
      );
      if (match === undefined)
        throw new ProviderError(
          'VERSION_NOT_FOUND',
          `${canonical} is absent from the project document`,
        );
    }
    const versionKey =
      parsed.version in record.body.releases
        ? parsed.version
        : Object.keys(record.body.releases).find(
            (version) =>
              this.codec.compareNativeVersions(version, parsed.version!) === 0,
          )!;
    const metadataDigest = await canonicalDigest({
      name: record.body.info.name,
      version: versionKey,
      files: record.body.releases[versionKey],
    } as JsonValue);
    const translated = await this.codec.translateMetadata(
      {
        kind: 'project-version',
        project: record.body,
        version: versionKey,
      },
      {
        providerId: this.providerId,
        endpoint: record.endpoint,
        retrievedAt: record.retrievedAt,
        evaluationTime: record.retrievedAt,
        ...(record.etag === undefined ? {} : { etag: record.etag }),
        metadataDigest,
        rawMetadataRef: {
          type: 'provider-metadata',
          locator: `urn:openpacker:pypi:${encodeURIComponent(parsed.name)}:${encodeURIComponent(versionKey)}`,
          digest: metadataDigest,
          mediaType: 'application/json',
        },
      },
    );
    return { package: translated.instance, record, warnings: [] };
  }

  async fetchArtifactRecord(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord> {
    const inspection = await this.inspect(exactPurl, signal);
    const artifact = inspection.package.artifacts[0];
    if (!artifact?.locations[0]?.uri)
      throw new ProviderError(
        'ARTIFACT_NOT_FOUND',
        `No artifact descriptor for ${exactPurl}`,
      );
    const url = artifact.locations[0].uri;
    const response = await this.transport.request({
      url,
      signal,
      maximumBytes: 128 * 1024 * 1024,
      headers: { accept: 'application/octet-stream' },
    });
    if (response.status < 200 || response.status >= 300)
      throw providerErrorForStatus(response.status);
    if (artifact.size !== response.body.byteLength)
      throw new ProviderError(
        'SIZE_MISMATCH',
        `PyPI artifact size ${response.body.byteLength} does not match ${artifact.size}`,
      );
    if (
      !(await verifyNativeDigest(
        response.body,
        'sha256',
        artifact.digest.value,
      ))
    )
      throw new ProviderError(
        'DIGEST_MISMATCH',
        'PyPI distribution digest mismatch',
      );
    const digest = await sha256(response.body);
    const descriptor: ArtifactDescriptor = {
      ...artifact,
      digest,
      size: response.body.byteLength,
    };
    return {
      key: exactPurl,
      endpoint: response.url,
      body: descriptor,
      rawBody: response.body,
      retrievedAt: inspection.record.retrievedAt,
    };
  }

  async snapshot(
    evaluationTime: string,
    signal?: AbortSignal,
  ): Promise<SourceSnapshot> {
    if (signal?.aborted)
      throw (
        signal.reason ?? new ProviderError('CANCELLED', 'Snapshot cancelled')
      );
    const recordDigests = await Promise.all(
      [...this.#records.values()]
        .sort((a, b) => compareCodePoints(a.key, b.key))
        .map(async (record) => ({
          key: record.key,
          ...(record.etag === undefined ? {} : { etag: record.etag }),
          digest: formatDigest(await sha256(record.rawBody)),
        })),
    );
    const recordsDigest = await canonicalDigest(recordDigests as JsonValue);
    const revision = formatDigest(recordsDigest);
    const etags = [
      ...new Set(
        [...this.#records.values()]
          .map((record) => record.etag)
          .filter((etag): etag is string => etag !== undefined),
      ),
    ];
    const etag = etags.length === 1 ? etags[0] : undefined;
    const retrievedAt =
      [...this.#records.values()]
        .map((record) => record.retrievedAt)
        .sort()
        .at(-1) ?? evaluationTime;
    const rootPayload = {
      providerId: this.providerId,
      providerType: 'pypi-json',
      endpointIdentity: this.endpoint,
      retrievedAt,
      evaluationTime,
      revision,
      ...(etag === undefined ? {} : { etag }),
      records: recordDigests,
    };
    const rootDigest = await canonicalDigest(rootPayload as JsonValue);
    return {
      snapshotId: formatDigest(rootDigest),
      providerId: this.providerId,
      providerType: 'pypi-json',
      endpointIdentity: this.endpoint,
      retrievedAt,
      evaluationTime,
      revision,
      ...(etag === undefined ? {} : { etag }),
      rootDigest,
      recordsDigest,
      evidenceRefs: [],
    };
  }

  private purlFor(coordinate: NativeCoordinate): string {
    return this.codec.canonicalizePurl(
      formatPurl({
        type: 'pypi',
        name: coordinate.name,
        version: coordinate.version,
        qualifiers: {},
      }),
    );
  }

  private async project(
    purl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord<PypiProjectDocument>> {
    const canonical = this.codec.canonicalizePurl(purl);
    const parsed = parsePurl(canonical);
    const key = formatPurl({ ...parsed, version: undefined });
    const existing = this.#records.get(key);
    // JSON API path uses the normalized name (PEP 503 form).
    const url = `${this.endpoint.replace(/\/$/, '')}/${encodeURIComponent(parsed.name)}/json`;
    const response = await this.transport.request({
      url,
      signal,
      maximumBytes: 8 * 1024 * 1024,
      headers: {
        accept: 'application/json',
        ...(existing?.etag === undefined
          ? {}
          : { 'if-none-match': existing.etag }),
      },
    });
    if (response.status === 304) {
      if (!existing)
        throw new ProviderError(
          'STALE_METADATA',
          `Received 304 without cached metadata for ${key}`,
          304,
        );
      const revalidated = { ...existing, retrievedAt: this.clock.now() };
      this.#records.set(key, revalidated);
      return revalidated;
    }
    if (response.status < 200 || response.status >= 300)
      throw new ProviderError(
        'UPSTREAM_UNAVAILABLE',
        `PyPI JSON API returned ${response.status}`,
        response.status,
      );
    const record: ProviderRecord<PypiProjectDocument> = {
      key,
      endpoint: response.url,
      ...(header(response, 'etag') === undefined
        ? {}
        : { etag: header(response, 'etag') }),
      body: json<PypiProjectDocument>(response),
      rawBody: response.body,
      retrievedAt: this.clock.now(),
    };
    this.#records.set(record.key, record);
    return record;
  }
}

/** Alias matching the Simple Index naming used in the design brief. */
export { PypiJsonProvider as PypiSimpleProvider };

export { PypiProjectFormat } from './project.js';

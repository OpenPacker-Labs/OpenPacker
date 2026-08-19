import { canonicalDigest, formatDigest, sha256 } from '@openpacker/canonical';
import type {
  ArtifactDescriptor,
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
  encodeUrlPathComponent,
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
  text,
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

export interface MavenDependency {
  groupId: string;
  artifactId: string;
  version?: string;
  type?: string;
  classifier?: string;
  scope?: string;
  optional?: boolean;
  exclusions?: readonly { groupId: string; artifactId: string }[];
}

export interface MavenCatalogEntry {
  groupId: string;
  artifactId: string;
  version: string;
  packaging?: string;
  classifier?: string;
  name?: string;
  description?: string;
  dependencies?: MavenDependency[];
  licenses?: unknown[];
  scm?: { url?: string; connection?: string; tag?: string };
  openpackerSha256?: string;
  packageSize?: number;
  packageUrl?: string;
  [key: string]: unknown;
}

export interface MavenMetadataDocument {
  groupId: string;
  artifactId: string;
  versioning: {
    latest?: string;
    release?: string;
    versions: string[];
    lastUpdated?: string;
  };
}

export interface GradleLockEntry {
  groupId: string;
  artifactId: string;
  version: string;
  configurations: string[];
  line: string;
}

export interface GradleLockDocument {
  formatVersion: string;
  entries: GradleLockEntry[];
}

export type MavenLockInput =
  | { format: 'gradle.lockfile'; data: string | GradleLockDocument }
  | string;

const MAVEN_QUALIFIER_ALIASES: Readonly<Record<string, string>> = {
  ga: '',
  final: '',
  release: '',
  cr: 'rc',
  sp: 'sp',
  alpha: 'alpha',
  a: 'alpha',
  beta: 'beta',
  b: 'beta',
  milestone: 'milestone',
  m: 'milestone',
  rc: 'rc',
  snapshot: 'snapshot',
};

const MAVEN_QUALIFIER_ORDER: Readonly<Record<string, number>> = {
  alpha: 0,
  beta: 1,
  milestone: 2,
  rc: 3,
  snapshot: 4,
  '': 5,
  sp: 6,
};

type MavenItem =
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'list'; items: MavenItem[] };

function isDefaultPackaging(value: string | undefined): boolean {
  return value === undefined || value === '' || value.toLowerCase() === 'jar';
}

function mavenQualifiers(input: {
  packaging?: string | undefined;
  classifier?: string | undefined;
}): Record<string, string> {
  const qualifiers: Record<string, string> = {};
  if (!isDefaultPackaging(input.packaging))
    qualifiers.type = input.packaging!.toLowerCase();
  if (input.classifier !== undefined && input.classifier !== '')
    qualifiers.classifier = input.classifier;
  return qualifiers;
}

function mavenCoordinateString(
  groupId: string,
  artifactId: string,
  version?: string,
  packaging?: string,
  classifier?: string,
): string {
  const base = `${groupId}:${artifactId}`;
  if (version === undefined) return base;
  if (
    (packaging === undefined || isDefaultPackaging(packaging)) &&
    (classifier === undefined || classifier === '')
  )
    return `${base}:${version}`;
  const type = packaging === undefined ? 'jar' : packaging;
  if (classifier === undefined || classifier === '')
    return `${base}:${type}:${version}`;
  return `${base}:${type}:${classifier}:${version}`;
}

function mavenIdentity(exactPurl: string, endpoint?: string): PackageIdentity {
  const parsed = parsePurl(exactPurl);
  if (parsed.namespace === undefined)
    throw new ProviderError(
      'INVALID_PURL',
      'Maven PURLs require a groupId namespace',
    );
  const identity: PackageIdentity = {
    canonicalPurl: formatPurl({ ...parsed, version: undefined }),
    purlType: 'maven',
    namespace: parsed.namespace,
    name: parsed.name,
    qualifiers: { ...parsed.qualifiers },
    nativeCoordinates: [
      {
        ecosystem: 'maven',
        coordinate: mavenCoordinateString(
          parsed.namespace,
          parsed.name,
          parsed.version,
          parsed.qualifiers.type,
          parsed.qualifiers.classifier,
        ),
        ...(parsed.version === undefined ? {} : { version: parsed.version }),
      },
    ],
    aliases: [],
    sourceRefs: endpoint === undefined ? [] : [sourceRef('maven', endpoint)],
    publisherRefs: [],
    externalRefs: [],
  };
  if (parsed.version !== undefined) {
    identity.version = parsed.version;
    identity.exactPurl = formatPurl(parsed);
  }
  return identity;
}

function tokenizeMavenVersion(value: string): MavenItem[] {
  const characters = value.toLowerCase().replace(/([a-z]+)(\d)/g, '$1.$2');
  const buffer: string[] = [];
  let isDigit: boolean | undefined;
  const flush = () => {
    if (buffer.length === 0) return;
    const token = buffer.join('');
    buffer.length = 0;
    if (/^\d+$/.test(token)) items.push({ kind: 'int', value: Number(token) });
    else items.push({ kind: 'string', value: normalizeMavenQualifier(token) });
  };
  const items: MavenItem[] = [];
  for (const character of characters) {
    if (character === '.' || character === '-' || character === '_') {
      flush();
      isDigit = undefined;
      continue;
    }
    const digit = character >= '0' && character <= '9';
    if (isDigit !== undefined && digit !== isDigit) flush();
    isDigit = digit;
    buffer.push(character);
  }
  flush();
  return items;
}

function normalizeMavenQualifier(value: string): string {
  return MAVEN_QUALIFIER_ALIASES[value] ?? value;
}

function qualifierRank(value: string): number {
  return MAVEN_QUALIFIER_ORDER[value] ?? 7;
}

/** Compare a token to a missing (null) slot using Maven ComparableVersion rules. */
function compareMavenItemToNull(item: MavenItem): number {
  if (item.kind === 'int') return item.value === 0 ? 0 : 1;
  if (item.kind === 'string')
    return Math.sign(qualifierRank(item.value) - qualifierRank(''));
  return compareMavenTokenLists(item.items, []);
}

function compareMavenItems(left: MavenItem, right: MavenItem): number {
  if (left.kind === 'list' || right.kind === 'list') {
    const leftItems = left.kind === 'list' ? left.items : [left];
    const rightItems = right.kind === 'list' ? right.items : [right];
    return compareMavenTokenLists(leftItems, rightItems);
  }
  if (left.kind === 'int' && right.kind === 'int')
    return Math.sign(left.value - right.value);
  // Integer items sort above string qualifiers (1.0.0 > 1.0-alpha).
  if (left.kind === 'int') return 1;
  if (right.kind === 'int') return -1;
  const leftRank = qualifierRank(left.value);
  const rightRank = qualifierRank(right.value);
  if (leftRank !== rightRank) return Math.sign(leftRank - rightRank);
  if (leftRank === 7) return compareCodePoints(left.value, right.value);
  return 0;
}

function compareMavenTokenLists(
  left: readonly MavenItem[],
  right: readonly MavenItem[],
): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined && b === undefined) return 0;
    if (a === undefined) {
      const order = compareMavenItemToNull(b!);
      return order === 0 ? 0 : -order;
    }
    if (b === undefined) {
      const order = compareMavenItemToNull(a);
      return order === 0 ? 0 : order;
    }
    const order = compareMavenItems(a, b);
    if (order !== 0) return order;
  }
  return 0;
}

export function parseMavenVersion(value: string): ParsedVersion {
  const original = value.trim();
  if (original.length === 0 || original.length > 256)
    throw new ProviderError(
      'INVALID_NATIVE_VERSION',
      `Invalid Maven version: ${value}`,
    );
  if (/[\s<>]/.test(original))
    throw new ProviderError(
      'INVALID_NATIVE_VERSION',
      `Invalid Maven version: ${value}`,
    );
  const tokens = tokenizeMavenVersion(original);
  const release: number[] = [];
  const prerelease: (number | string)[] = [];
  let sawString = false;
  for (const token of tokens) {
    if (token.kind === 'int' && !sawString) release.push(token.value);
    else if (token.kind === 'int') prerelease.push(token.value);
    else if (token.kind === 'string') {
      sawString = true;
      prerelease.push(token.value);
    }
  }
  if (release.length === 0) release.push(0);
  return {
    original,
    normalized: original,
    release,
    prerelease,
    build: [],
  };
}

function mavenVers(ast: RangeAst): string | undefined {
  if (ast.type === 'any') return '*';
  if (ast.type === 'comparison') return `${ast.operator}${ast.version}`;
  if (ast.type === 'or') return undefined;
  const parts = ast.items.map(mavenVers);
  return parts.some((part) => part === undefined) ? undefined : parts.join('|');
}

function parseMavenInterval(interval: string, codec: MavenCodec): RangeAst {
  const trimmed = interval.trim();
  if (!/^[[(].*[\])]$/.test(trimmed))
    throw new ProviderError(
      'INVALID_NATIVE_RANGE',
      `Invalid Maven version range: ${interval}`,
    );
  const lowerInclusive = trimmed.startsWith('[');
  const upperInclusive = trimmed.endsWith(']');
  const body = trimmed.slice(1, -1);
  const comma = body.indexOf(',');
  if (comma < 0) {
    const version = body.trim();
    if (!version)
      throw new ProviderError(
        'INVALID_NATIVE_RANGE',
        `Invalid Maven version range: ${interval}`,
      );
    return {
      type: 'comparison',
      operator: '=',
      version: codec.parseNativeVersion(version).normalized,
    };
  }
  const lower = body.slice(0, comma).trim();
  const upper = body.slice(comma + 1).trim();
  const items: RangeAst[] = [];
  if (lower)
    items.push({
      type: 'comparison',
      operator: lowerInclusive ? '>=' : '>',
      version: codec.parseNativeVersion(lower).normalized,
    });
  if (upper)
    items.push({
      type: 'comparison',
      operator: upperInclusive ? '<=' : '<',
      version: codec.parseNativeVersion(upper).normalized,
    });
  if (items.length === 0) return { type: 'any' };
  if (items.length === 1) return items[0]!;
  return { type: 'and', items };
}

/**
 * Split a Maven range expression into top-level alternatives.
 * Commas inside `[...]` / `(...)` bound pairs separate lower/upper bounds;
 * commas *between* bound pairs separate OR alternatives.
 */
function splitMavenRangeAlternatives(value: string): string[] {
  const alternatives: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '[' || character === '(') depth += 1;
    else if (character === ']' || character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      alternatives.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  alternatives.push(value.slice(start).trim());
  return alternatives.filter((part) => part.length > 0);
}

function mavenScopeKind(scope: string | undefined): {
  kind: Requirement['kind'];
  optional: boolean;
  loss?: SemanticLoss;
} {
  const normalized = (scope ?? 'compile').toLowerCase();
  if (normalized === 'test') return { kind: 'development', optional: false };
  if (normalized === 'provided')
    return {
      kind: 'runtime',
      optional: true,
      loss: semanticLoss(
        'maven',
        'MAVEN_PROVIDED_SCOPE_NATIVE',
        '/scope',
        'Maven provided scope is supplied by the runtime container and is not packaged',
      ),
    };
  if (normalized === 'system')
    return {
      kind: 'runtime',
      optional: true,
      loss: semanticLoss(
        'maven',
        'MAVEN_SYSTEM_SCOPE_NATIVE',
        '/scope',
        'Maven system-scope dependencies require an external systemPath and are not registry-resolvable',
        undefined,
        'error',
      ),
    };
  if (normalized === 'import')
    return {
      kind: 'runtime',
      optional: false,
      loss: semanticLoss(
        'maven',
        'MAVEN_IMPORT_SCOPE_BOM_NATIVE',
        '/scope',
        'Maven import scope BOM imports are retained in nativeSemantics and are not package edges',
        undefined,
        'error',
      ),
    };
  // compile, runtime, and unknown scopes map to runtime requirements.
  return { kind: 'runtime', optional: false };
}

export function parseGradleLockfile(input: string): GradleLockDocument {
  const entries: GradleLockEntry[] = [];
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line === 'empty=')
      continue;
    const equals = line.indexOf('=');
    if (equals <= 0)
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `Invalid gradle.lockfile line: ${rawLine}`,
      );
    const coordinate = line.slice(0, equals).trim();
    const configurations = line
      .slice(equals + 1)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    // group:name:version — primary Gradle dependency-locking form
    const match = /^([A-Za-z0-9._-]+):([A-Za-z0-9._-]+):([^:=\s]+)$/.exec(
      coordinate,
    );
    if (!match)
      throw new ProviderError(
        'INVALID_LOCKFILE',
        `Invalid gradle.lockfile coordinate: ${coordinate}`,
      );
    entries.push({
      groupId: match[1]!,
      artifactId: match[2]!,
      version: match[3]!,
      configurations,
      line: rawLine,
    });
  }
  if (entries.length === 0)
    throw new ProviderError(
      'INVALID_LOCKFILE',
      'gradle.lockfile contains no locked dependencies',
    );
  entries.sort((left, right) =>
    compareCodePoints(
      `${left.groupId}:${left.artifactId}:${left.version}`,
      `${right.groupId}:${right.artifactId}:${right.version}`,
    ),
  );
  return { formatVersion: 'gradle-lockfile-v1', entries };
}

export function mavenRepositoryPath(
  groupId: string,
  artifactId: string,
  version?: string,
  packaging = 'jar',
  classifier?: string,
): string {
  const groupPath = mavenGroupPath(groupId);
  const artifact = mavenComponent(artifactId, 'artifactId');
  if (version === undefined)
    return `${groupPath}/${artifact}/maven-metadata.xml`;
  const encodedVersion = mavenComponent(version, 'version');
  const encodedPackaging = mavenComponent(packaging, 'packaging');
  const classifierSuffix =
    classifier === undefined || classifier === ''
      ? ''
      : `-${mavenComponent(classifier, 'classifier')}`;
  return `${groupPath}/${artifact}/${encodedVersion}/${artifact}-${encodedVersion}${classifierSuffix}.${encodedPackaging}`;
}

function mavenComponent(value: string, label: string): string {
  return encodeUrlPathComponent(value, `Maven ${label}`);
}

function mavenGroupPath(groupId: string): string {
  return groupId
    .split('.')
    .map((part) => mavenComponent(part, 'groupId'))
    .join('/');
}

export function parseMavenMetadataXml(xml: string): MavenMetadataDocument {
  const groupId = /<groupId>([^<]+)<\/groupId>/.exec(xml)?.[1]?.trim();
  const artifactId = /<artifactId>([^<]+)<\/artifactId>/.exec(xml)?.[1]?.trim();
  if (!groupId || !artifactId)
    throw new ProviderError(
      'INVALID_PROVIDER_METADATA',
      'maven-metadata.xml is missing groupId or artifactId',
    );
  const versionsBlock = /<versions>([\s\S]*?)<\/versions>/.exec(xml)?.[1] ?? '';
  const versions = [
    ...versionsBlock.matchAll(/<version>([^<]+)<\/version>/g),
  ].map((match) => match[1]!.trim());
  if (versions.length === 0)
    throw new ProviderError(
      'INVALID_PROVIDER_METADATA',
      'maven-metadata.xml contains no versions',
    );
  const latest = /<latest>([^<]+)<\/latest>/.exec(xml)?.[1]?.trim();
  const release = /<release>([^<]+)<\/release>/.exec(xml)?.[1]?.trim();
  const lastUpdated = /<lastUpdated>([^<]+)<\/lastUpdated>/
    .exec(xml)?.[1]
    ?.trim();
  return {
    groupId,
    artifactId,
    versioning: {
      versions,
      ...(latest === undefined ? {} : { latest }),
      ...(release === undefined ? {} : { release }),
      ...(lastUpdated === undefined ? {} : { lastUpdated }),
    },
  };
}

export class MavenCodec
  implements EcosystemCodec<MavenCatalogEntry, MavenLockInput>
{
  readonly purlType = 'maven' as const;

  parseNativeCoordinate(value: string): NativeCoordinate {
    // Validate full GAV (including packaging/classifier) without flattening them
    // into NativeCoordinate — those live on PURLs as qualifiers via parseGav.
    const gav = this.parseGav(value);
    return {
      ecosystem: 'maven',
      namespace: gav.groupId,
      name: gav.artifactId,
      original: value,
      ...(gav.version === undefined ? {} : { version: gav.version }),
    };
  }

  /** Parse GAV with optional packaging/classifier into structured parts. */
  parseGav(value: string): {
    groupId: string;
    artifactId: string;
    version?: string;
    packaging?: string;
    classifier?: string;
  } {
    const trimmed = value.trim();
    const atIndex = trimmed.lastIndexOf('@');
    const body = atIndex < 0 ? trimmed : trimmed.slice(0, atIndex);
    const atVersion = atIndex < 0 ? undefined : trimmed.slice(atIndex + 1);
    const parts = body.split(':').map((part) => part.trim());
    if (parts.length < 2 || parts.some((part) => part.length === 0))
      throw new ProviderError(
        'INVALID_NATIVE_COORDINATE',
        `Invalid Maven coordinate: ${value}`,
      );
    const groupId = parts[0]!;
    const artifactId = parts[1]!;
    if (parts.length === 2)
      return {
        groupId,
        artifactId,
        ...(atVersion === undefined ? {} : { version: atVersion }),
      };
    if (parts.length === 3) {
      const version = atVersion ?? parts[2]!;
      return { groupId, artifactId, version };
    }
    if (parts.length === 4) {
      const version = atVersion ?? parts[3]!;
      return { groupId, artifactId, packaging: parts[2]!, version };
    }
    if (parts.length === 5) {
      const version = atVersion ?? parts[4]!;
      return {
        groupId,
        artifactId,
        packaging: parts[2]!,
        classifier: parts[3]!,
        version,
      };
    }
    throw new ProviderError(
      'INVALID_NATIVE_COORDINATE',
      `Invalid Maven coordinate: ${value}`,
    );
  }

  canonicalizePurl(value: string): string {
    const parsed = parsePurl(value);
    if (parsed.type !== 'maven')
      throw new ProviderError('INVALID_PURL', 'Expected a Maven PURL');
    if (parsed.namespace === undefined || parsed.namespace.length === 0)
      throw new ProviderError(
        'INVALID_PURL',
        'Maven PURLs require a groupId namespace',
      );
    const packaging = parsed.qualifiers.type;
    const classifier = parsed.qualifiers.classifier;
    mavenGroupPath(parsed.namespace);
    mavenComponent(parsed.name, 'artifactId');
    if (parsed.version !== undefined) mavenComponent(parsed.version, 'version');
    if (packaging !== undefined) mavenComponent(packaging, 'packaging');
    if (classifier !== undefined) mavenComponent(classifier, 'classifier');
    const qualifiers = mavenQualifiers({ packaging, classifier });
    // Reject silent flattening: unknown qualifiers are preserved, not dropped.
    for (const [key, entry] of Object.entries(parsed.qualifiers)) {
      if (key === 'type' || key === 'classifier') continue;
      qualifiers[key] = entry;
    }
    return formatPurl({
      type: 'maven',
      namespace: parsed.namespace,
      name: parsed.name,
      qualifiers,
      ...(parsed.version === undefined
        ? {}
        : { version: this.parseNativeVersion(parsed.version).normalized }),
      ...(parsed.subpath === undefined ? {} : { subpath: parsed.subpath }),
    });
  }

  parseNativeVersion(value: string): ParsedVersion {
    return parseMavenVersion(value);
  }

  compareNativeVersions(left: string, right: string): number {
    return compareMavenTokenLists(
      tokenizeMavenVersion(left.trim()),
      tokenizeMavenVersion(right.trim()),
    );
  }

  parseNativeRange(value: string): ParsedRange {
    if (value.length > 4096)
      throw new ProviderError(
        'INVALID_NATIVE_RANGE',
        'Native range exceeds 4096 characters',
      );
    const original = value;
    const trimmed = value.trim();
    const losses: SemanticLoss[] = [];
    let ast: RangeAst;

    if (trimmed === '' || trimmed === '*') {
      ast = { type: 'any' };
    } else if (/^[[(]/.test(trimmed)) {
      const alternatives = splitMavenRangeAlternatives(trimmed);
      if (alternatives.length === 0)
        throw new ProviderError(
          'INVALID_NATIVE_RANGE',
          `Invalid Maven version range: ${value}`,
        );
      const parsed = alternatives.map((alternative) =>
        parseMavenInterval(alternative, this),
      );
      ast = parsed.length === 1 ? parsed[0]! : { type: 'or', items: parsed };
      // Disjunctions are kept in the native AST; VERS cannot faithfully encode them.
      if (parsed.length > 1)
        losses.push(
          semanticLoss(
            'maven',
            'MAVEN_RANGE_DISJUNCTION_NOT_EXACTLY_REPRESENTABLE',
            '/range',
            'Maven multi-interval ranges use OR semantics that are retained only in the native AST',
          ),
        );
    } else {
      // Bare version is a soft recommendation in Maven, not a hard exact pin.
      ast = {
        type: 'comparison',
        operator: '=',
        version: this.parseNativeVersion(trimmed).normalized,
      };
      losses.push(
        semanticLoss(
          'maven',
          'MAVEN_SOFT_REQUIREMENT',
          '/range',
          'Bare Maven dependency versions are soft recommendations, not hard constraints',
          'Represented as exact equality for PREX calculus with semantic loss',
        ),
      );
    }

    // Exact single intervals (and `*`) are faithfully VERS-mappable.
    // Soft bare versions and disjunctions carry semantic loss without vers.
    const finalVers = losses.length === 0 ? mavenVers(ast) : undefined;
    if (finalVers === undefined && losses.length === 0) {
      losses.push(
        semanticLoss(
          'maven',
          'MAVEN_RANGE_NOT_EXACTLY_REPRESENTABLE',
          '/range',
          'Maven version range is retained only in its native AST',
        ),
      );
    }

    return {
      scheme: 'maven',
      original,
      normalized: renderRange(ast),
      ast,
      ...(finalVers === undefined ? {} : { vers: `vers:maven/${finalVers}` }),
      reversible: finalVers !== undefined,
      semanticLoss: losses,
    };
  }

  toVers(value: string): VersionConstraint {
    return rangeToConstraint(this.parseNativeRange(value));
  }

  satisfies(version: string, range: string | ParsedRange): boolean {
    const parsedRange =
      typeof range === 'string' ? this.parseNativeRange(range) : range;
    return evaluateRange(version, parsedRange.ast, (left, right) =>
      this.compareNativeVersions(left, right),
    );
  }

  purlFor(
    groupId: string,
    artifactId: string,
    version?: string,
    packaging?: string,
    classifier?: string,
  ): string {
    return this.canonicalizePurl(
      formatPurl({
        type: 'maven',
        namespace: groupId,
        name: artifactId,
        qualifiers: mavenQualifiers({ packaging, classifier }),
        ...(version === undefined ? {} : { version }),
      }),
    );
  }

  async translateMetadata(
    metadata: MavenCatalogEntry,
    provenance: TranslationProvenance,
  ): Promise<TranslatedMetadata> {
    const packaging = metadata.packaging;
    const classifier = metadata.classifier;
    const exactPurl = this.purlFor(
      metadata.groupId,
      metadata.artifactId,
      metadata.version,
      packaging,
      classifier,
    );
    // Qualifiers must be passed: Maven puts `type` and `classifier` in the
    // PURL, so `identity.qualifiers` is non-empty for any non-jar packaging or
    // any classifier. Omitting them here would make the node ID the projection
    // of a different identity than the one it labels.
    const nodeId = await packageNodeId({
      exactPurl,
      qualifiers: parsePurl(exactPurl).qualifiers,
      nativeSemanticsVersion: 'maven-v1',
    });
    const requirements: Requirement[] = [];
    const losses: SemanticLoss[] = [];

    if (
      !isDefaultPackaging(packaging) ||
      (classifier !== undefined && classifier !== '')
    ) {
      losses.push(
        semanticLoss(
          'maven',
          'MAVEN_ARTIFACT_COORDINATE_QUALIFIERS',
          classifier ? '/classifier' : '/packaging',
          'Maven packaging type and classifier select a distinct artifact coordinate and must not be flattened',
          'Preserved as PURL qualifiers and nativeSemantics',
        ),
      );
    }

    for (const [index, dependency] of (metadata.dependencies ?? []).entries()) {
      const range = this.parseNativeRange(dependency.version ?? '*');
      const scope = mavenScopeKind(dependency.scope);
      const depPackaging = dependency.type;
      const depClassifier = dependency.classifier;
      const depPurl = this.purlFor(
        dependency.groupId,
        dependency.artifactId,
        undefined,
        depPackaging,
        depClassifier,
      );
      const qualifierLoss: SemanticLoss[] = [];
      if (
        !isDefaultPackaging(depPackaging) ||
        (depClassifier !== undefined && depClassifier !== '')
      ) {
        qualifierLoss.push(
          semanticLoss(
            'maven',
            'MAVEN_DEPENDENCY_QUALIFIERS_PRESERVED',
            `/dependencies/${index}`,
            'Dependency packaging/classifier are retained in PURL qualifiers and never silently dropped',
          ),
        );
      }
      if (dependency.exclusions && dependency.exclusions.length > 0) {
        qualifierLoss.push(
          semanticLoss(
            'maven',
            'MAVEN_EXCLUSIONS_NATIVE_ONLY',
            `/dependencies/${index}/exclusions`,
            'Maven dependency exclusions are retained in nativeSemantics for a native validator',
            undefined,
            'error',
          ),
        );
      }
      const packageExpression: Requirement['expression'] = {
        type: 'package',
        purl: depPurl,
        ...(range.vers === undefined ? {} : { vers: range.vers }),
      };
      requirements.push({
        id: `${nodeId}:${scope.kind}:${dependency.groupId}:${dependency.artifactId}:${index}`,
        dependerNodeId: nodeId,
        expression: packageExpression,
        kind: scope.kind,
        optional: dependency.optional === true || scope.optional,
        source: sourceRef('maven', provenance.endpoint),
        authority: 'native',
        raw: dependency as unknown as JsonValue,
        nativeSemantics: {
          version: 'maven-v1',
          data: {
            groupId: dependency.groupId,
            artifactId: dependency.artifactId,
            version: dependency.version ?? '*',
            scope: dependency.scope ?? 'compile',
            optional: dependency.optional === true,
            ...(depPackaging === undefined ? {} : { type: depPackaging }),
            ...(depClassifier === undefined
              ? {}
              : { classifier: depClassifier }),
            ...(dependency.exclusions === undefined
              ? {}
              : { exclusions: dependency.exclusions }),
          } as unknown as JsonValue,
        },
        semanticLoss: [
          ...range.semanticLoss,
          ...(scope.loss === undefined ? [] : [scope.loss]),
          ...qualifierLoss,
        ],
      });
    }

    const artifacts: ArtifactDescriptor[] = [];
    if (
      metadata.openpackerSha256 &&
      /^[0-9a-f]{64}$/.test(metadata.openpackerSha256) &&
      metadata.packageSize !== undefined
    ) {
      const type = packaging ?? 'jar';
      const classifierSuffix =
        classifier === undefined || classifier === '' ? '' : `-${classifier}`;
      artifacts.push({
        descriptorId: `${nodeId}:artifact`,
        digest: { algorithm: 'sha256', value: metadata.openpackerSha256 },
        size: metadata.packageSize,
        mediaType: 'application/java-archive',
        artifactType: 'application/vnd.openpacker.maven.artifact.v1+jar',
        fileName: `${metadata.artifactId}-${this.parseNativeVersion(metadata.version).normalized}${classifierSuffix}.${type}`,
        nativeRole: 'package-archive',
        locations:
          metadata.packageUrl === undefined
            ? []
            : [
                {
                  transport: 'https',
                  uri: metadata.packageUrl,
                  priority: 0,
                  rangeSupported: true,
                },
              ],
        referrers: [],
        externalRefs: [],
      });
    } else {
      losses.push(
        semanticLoss(
          'maven',
          'MAVEN_SHA256_NOT_SUPPLIED',
          '/openpackerSha256',
          'Maven Central metadata does not always publish SHA-256; digest is preserved when supplied by the fixture or .sha256 sidecar',
        ),
      );
    }

    const instance: PackageInstance = {
      nodeId,
      identity: mavenIdentity(exactPurl, provenance.endpoint),
      nativeVersion: metadata.version,
      normalizedVersion: this.parseNativeVersion(metadata.version).normalized,
      versionSortKey: this.parseNativeVersion(metadata.version).normalized,
      requirements: requirements.sort((left, right) =>
        compareCodePoints(left.id, right.id),
      ),
      capabilities: [],
      conflicts: [],
      cardinalityConstraints: [],
      artifacts,
      lifecycle: {
        status: 'published',
        eligible: true,
        warnings: [],
      },
      sourceSnapshots:
        provenance.snapshotDigest === undefined
          ? []
          : [provenance.snapshotDigest],
      metadataDigest: provenance.metadataDigest,
      nativeSemantics: {
        version: 'maven-v1',
        data: {
          groupId: metadata.groupId,
          artifactId: metadata.artifactId,
          packaging: packaging ?? 'jar',
          ...(classifier === undefined ? {} : { classifier }),
          dependencies: metadata.dependencies ?? [],
          ...(metadata.name === undefined ? {} : { name: metadata.name }),
          ...(metadata.description === undefined
            ? {}
            : { description: metadata.description }),
          ...(metadata.licenses === undefined
            ? {}
            : { licenses: metadata.licenses }),
          ...(metadata.scm === undefined ? {} : { scm: metadata.scm }),
          installScriptsExecuted: false,
        } as unknown as JsonValue,
      },
      semanticLoss: losses,
    };
    if (provenance.rawMetadataRef !== undefined)
      instance.rawMetadataRef = provenance.rawMetadataRef;
    return { instance, rawMetadata: metadata };
  }

  translateLockResult(
    input: MavenLockInput,
    provenance: TranslationProvenance,
  ): LockCapture {
    const document =
      typeof input === 'string'
        ? parseGradleLockfile(input)
        : typeof input.data === 'string'
          ? parseGradleLockfile(input.data)
          : input.data;
    // Lock import preserves resolved versions only — requested ranges are not reconstructed.
    const packages = document.entries
      .map((entry) => ({
        exactPurl: this.purlFor(entry.groupId, entry.artifactId, entry.version),
        nativeCoordinate: `${entry.groupId}:${entry.artifactId}:${entry.version}`,
        resolved: entry.version,
        dependencies: {},
        native: {
          configurations: entry.configurations,
          line: entry.line,
        },
      }))
      .sort((left, right) =>
        compareCodePoints(left.exactPurl, right.exactPurl),
      );
    return {
      format: 'gradle.lockfile',
      formatVersion: document.formatVersion,
      sourceDigest: formatDigest(provenance.metadataDigest),
      packages,
      semanticLoss: [
        semanticLoss(
          'maven',
          'GRADLE_LOCK_RESOLVED_ONLY',
          '/',
          'Gradle dependency locking records only resolved versions; requested ranges are not available for import',
          'exact pinned versions',
          'info',
        ),
      ],
    };
  }
}

/**
 * Offline-capable Maven repository provider.
 *
 * Speaks Maven Central-style layout over an injected {@link HttpTransport},
 * so tests supply fixtures via {@link import('@openpacker/adapter-core').FixtureHttpTransport}
 * without network access. Catalog version documents are JSON fixtures that
 * mirror a normalized POM/catalog entry.
 */
export class MavenRepositoryProvider implements CatalogProvider {
  readonly providerId = 'maven-repository';
  readonly capabilities: ProviderCapabilities = {
    operations: ['identify', 'enumerate', 'inspect', 'artifact', 'snapshot'],
    purlTypes: ['maven'],
    qualifierSupport: 'complete',
    targetSpecificSemantics: true,
    offlineReplay: true,
    extensions: {
      'openpacker.dev/maven-repository-layout': 'default',
      'openpacker.dev/catalog-entry': 'json-v1',
    },
  };
  readonly #records = new Map<string, ProviderRecord>();
  readonly #artifactSources = new Map<
    string,
    { uri: string; expectedSize?: number; expectedSha256?: string }
  >();

  constructor(
    private readonly transport: HttpTransport,
    private readonly clock: Clock,
    private readonly repositoryUrl = 'https://repo1.maven.org/maven2',
    private readonly codec = new MavenCodec(),
  ) {}

  async identify(query: string): Promise<readonly PackageIdentity[]> {
    const purl = query.startsWith('pkg:')
      ? this.codec.canonicalizePurl(query)
      : this.purlFromCoordinate(query);
    return [mavenIdentity(purl, this.repositoryUrl)];
  }

  invalidate(purl?: string): void {
    if (purl === undefined) {
      this.#records.clear();
      this.#artifactSources.clear();
      return;
    }
    const parsed = parsePurl(this.codec.canonicalizePurl(purl));
    const key = formatPurl({ ...parsed, version: undefined });
    for (const recordKey of this.#records.keys()) {
      if (recordKey === key || recordKey.startsWith(`${key}@`))
        this.#records.delete(recordKey);
    }
    if (parsed.version !== undefined)
      this.#artifactSources.delete(this.codec.canonicalizePurl(purl));
  }

  async enumerate(
    basePurl: string,
    signal?: AbortSignal,
  ): Promise<readonly string[]> {
    const record = await this.metadataRecord(basePurl, signal);
    const body = record.body as MavenMetadataDocument;
    return [...body.versioning.versions]
      .sort((left, right) => this.codec.compareNativeVersions(left, right))
      .map((version) =>
        this.codec.purlFor(body.groupId, body.artifactId, version),
      );
  }

  async inspect(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderInspection> {
    const canonical = this.codec.canonicalizePurl(exactPurl);
    const parsed = parsePurl(canonical);
    if (!parsed.version || parsed.namespace === undefined)
      throw new ProviderError(
        'VERSION_NOT_FOUND',
        'inspect requires an exact Maven PURL with groupId',
      );
    const packaging = parsed.qualifiers.type ?? 'jar';
    const classifier = parsed.qualifiers.classifier;
    const catalogUrl = this.catalogEntryUrl(
      parsed.namespace,
      parsed.name,
      parsed.version,
      packaging,
      classifier,
    );
    const record = await this.fetchJsonRecord<MavenCatalogEntry>(
      `${canonical}:catalog`,
      catalogUrl,
      signal,
    );
    const entry = record.body;
    if (
      entry.groupId !== parsed.namespace ||
      entry.artifactId !== parsed.name ||
      this.codec.compareNativeVersions(entry.version, parsed.version) !== 0
    )
      throw new ProviderError(
        'INVALID_PROVIDER_METADATA',
        `Catalog entry identity does not match ${canonical}`,
      );
    const metadataDigest = await canonicalDigest(entry as unknown as JsonValue);
    const translated = await this.codec.translateMetadata(entry, {
      providerId: this.providerId,
      endpoint: record.endpoint,
      retrievedAt: record.retrievedAt,
      evaluationTime: record.retrievedAt,
      ...(record.etag === undefined ? {} : { etag: record.etag }),
      metadataDigest,
      rawMetadataRef: {
        type: 'provider-metadata',
        locator: `urn:openpacker:maven:${entry.groupId}:${entry.artifactId}:${entry.version}`,
        digest: metadataDigest,
        mediaType: 'application/json',
      },
    });
    const packageUri =
      entry.packageUrl ??
      `${this.repositoryUrl.replace(/\/$/, '')}/${mavenRepositoryPath(
        entry.groupId,
        entry.artifactId,
        entry.version,
        entry.packaging ?? packaging,
        entry.classifier ?? classifier,
      )}`;
    this.#artifactSources.set(canonical, {
      uri: packageUri,
      ...(entry.packageSize === undefined
        ? {}
        : { expectedSize: entry.packageSize }),
      ...(entry.openpackerSha256 === undefined
        ? {}
        : { expectedSha256: entry.openpackerSha256 }),
    });
    if (translated.instance.artifacts[0]) {
      translated.instance.artifacts[0].locations = [
        {
          transport: 'https',
          uri: packageUri,
          priority: 0,
          rangeSupported: true,
        },
      ];
    }
    return { package: translated.instance, record, warnings: [] };
  }

  async fetchArtifactRecord(
    exactPurl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord> {
    const inspection = await this.inspect(exactPurl, signal);
    const canonical = this.codec.canonicalizePurl(exactPurl);
    const source = this.#artifactSources.get(canonical);
    if (!source)
      throw new ProviderError(
        'ARTIFACT_NOT_FOUND',
        `No Maven artifact source for ${exactPurl}`,
      );
    const response = await this.transport.request({
      url: source.uri,
      signal,
      maximumBytes: 128 * 1024 * 1024,
      headers: { accept: 'application/octet-stream' },
    });
    if (response.status < 200 || response.status >= 300)
      throw providerErrorForStatus(response.status);
    if (
      source.expectedSize !== undefined &&
      source.expectedSize !== response.body.byteLength
    )
      throw new ProviderError(
        'SIZE_MISMATCH',
        `Maven artifact size ${response.body.byteLength} does not match ${source.expectedSize}`,
      );
    const digest = await sha256(response.body);
    if (
      source.expectedSha256 !== undefined &&
      digest.value !== source.expectedSha256
    )
      throw new ProviderError(
        'DIGEST_MISMATCH',
        'Maven artifact digest mismatch',
      );
    const parsed = parsePurl(canonical);
    const packaging = parsed.qualifiers.type ?? 'jar';
    const classifierSuffix =
      parsed.qualifiers.classifier === undefined
        ? ''
        : `-${parsed.qualifiers.classifier}`;
    const artifact: ArtifactDescriptor = {
      descriptorId: `${inspection.package.nodeId}:artifact`,
      digest,
      size: response.body.byteLength,
      mediaType: 'application/java-archive',
      artifactType: 'application/vnd.openpacker.maven.artifact.v1+jar',
      fileName: `${parsed.name}-${parsed.version!}${classifierSuffix}.${packaging}`,
      nativeRole: 'package-archive',
      locations: [
        {
          transport: 'https',
          uri: source.uri,
          priority: 0,
          rangeSupported: true,
        },
      ],
      referrers: [],
      externalRefs: [],
    };
    return {
      key: exactPurl,
      endpoint: response.url,
      body: artifact,
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
    const records = await Promise.all(
      [...this.#records.values()]
        .sort((a, b) => compareCodePoints(a.key, b.key))
        .map(async (record) => ({
          key: record.key,
          ...(record.etag === undefined ? {} : { etag: record.etag }),
          digest: formatDigest(await sha256(record.rawBody)),
        })),
    );
    const recordsDigest = await canonicalDigest(records as JsonValue);
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
    const rootDigest = await canonicalDigest({
      providerId: this.providerId,
      providerType: 'maven-repository',
      endpointIdentity: this.repositoryUrl,
      retrievedAt,
      evaluationTime,
      revision,
      ...(etag === undefined ? {} : { etag }),
      records,
    } as JsonValue);
    return {
      snapshotId: formatDigest(rootDigest),
      providerId: this.providerId,
      providerType: 'maven-repository',
      endpointIdentity: this.repositoryUrl,
      retrievedAt,
      evaluationTime,
      revision,
      ...(etag === undefined ? {} : { etag }),
      rootDigest,
      recordsDigest,
      evidenceRefs: [],
    };
  }

  private purlFromCoordinate(value: string): string {
    const gav = this.codec.parseGav(value);
    return this.codec.purlFor(
      gav.groupId,
      gav.artifactId,
      gav.version,
      gav.packaging,
      gav.classifier,
    );
  }

  private catalogEntryUrl(
    groupId: string,
    artifactId: string,
    version: string,
    packaging: string,
    classifier?: string,
  ): string {
    const base = this.repositoryUrl.replace(/\/$/, '');
    // OpenPacker catalog entries are JSON sidecars beside the Maven path.
    return `${base}/${mavenRepositoryPath(groupId, artifactId, version, `${packaging}.catalog.json`, classifier)}`;
  }

  private async metadataRecord(
    purl: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord<MavenMetadataDocument>> {
    const parsed = parsePurl(this.codec.canonicalizePurl(purl));
    if (parsed.namespace === undefined)
      throw new ProviderError(
        'INVALID_PURL',
        'Maven PURLs require a groupId namespace',
      );
    const key = formatPurl({ ...parsed, version: undefined });
    const existing = this.#records.get(key) as
      | ProviderRecord<MavenMetadataDocument>
      | undefined;
    const url = `${this.repositoryUrl.replace(/\/$/, '')}/${mavenRepositoryPath(
      parsed.namespace,
      parsed.name,
    )}`;
    const response = await this.transport.request({
      url,
      signal,
      maximumBytes: 2 * 1024 * 1024,
      headers: {
        accept: 'application/xml,text/xml,*/*',
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
      throw providerErrorForStatus(response.status);
    const body = parseMavenMetadataXml(text(response));
    if (body.groupId !== parsed.namespace || body.artifactId !== parsed.name)
      throw new ProviderError(
        'INVALID_PROVIDER_METADATA',
        `maven-metadata.xml identity does not match ${key}`,
      );
    const record: ProviderRecord<MavenMetadataDocument> = {
      key,
      endpoint: response.url,
      ...(header(response, 'etag') === undefined
        ? {}
        : { etag: header(response, 'etag') }),
      body,
      rawBody: response.body,
      retrievedAt: this.clock.now(),
    };
    this.#records.set(key, record);
    return record;
  }

  private async fetchJsonRecord<T>(
    key: string,
    url: string,
    signal?: AbortSignal,
  ): Promise<ProviderRecord<T>> {
    const existing = this.#records.get(key) as ProviderRecord<T> | undefined;
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
      return existing;
    }
    if (response.status < 200 || response.status >= 300)
      throw providerErrorForStatus(response.status);
    const body = json<T>(response);
    const record: ProviderRecord<T> = {
      key,
      endpoint: response.url,
      ...(header(response, 'etag') === undefined
        ? {}
        : { etag: header(response, 'etag') }),
      body,
      rawBody: response.body,
      retrievedAt: this.clock.now(),
    };
    this.#records.set(key, record);
    return record;
  }
}

export { MavenProjectFormat } from './project.js';

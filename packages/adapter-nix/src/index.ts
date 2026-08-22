import { canonicalDigest } from '@openpacker/canonical';
import type {
  JsonValue,
  PackageInstance,
  SemanticLoss,
  VersionConstraint,
} from '@openpacker/contracts';
import {
  ProviderError,
  compareCodePoints,
  formatPurl,
  packageNodeId,
  parsePurl,
  semanticLoss,
  sourceRef,
  type EcosystemCodec,
  type LockCapture,
  type NativeCoordinate,
  type ParsedRange,
  type ParsedVersion,
  type TranslatedMetadata,
  type TranslationProvenance,
} from '@openpacker/adapter-core';

/**
 * Nix store-path hashes are 32 characters of Nim base32 (`nixbase32`), which
 * omits `e`, `o`, `u`, and `t` to avoid accidental words.
 */
const STORE_HASH = /^[0-9abcdfghijklmnpqrsvwxyz]{32}$/u;
const STORE_PATH =
  /^(?:\/nix\/store\/)?([0-9abcdfghijklmnpqrsvwxyz]{32})-(.+?)(?:\.drv)?$/u;

export const NIX_PURL_TYPE = 'nix';

/** A store path decomposed into the parts PREX needs. */
export interface NixStorePath {
  hash: string;
  name: string;
  version?: string | undefined;
  isDerivation: boolean;
}

const loss = (
  code: string,
  sourcePath: string,
  originalMeaning: string,
  representedMeaning: string,
  severity: SemanticLoss['severity'] = 'info',
): SemanticLoss =>
  semanticLoss(
    NIX_PURL_TYPE,
    code,
    sourcePath,
    originalMeaning,
    representedMeaning,
    severity,
  );

/**
 * Split a Nix derivation name the way `parseDrvName` does: the version begins
 * at the first `-` followed by a character that is not a letter. Matching
 * Nix's `isalpha` rather than lowercase-only matters for the many nixpkgs
 * names of the form `python3.11-PyYAML-6.0`.
 */
export function splitDerivationName(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '-') continue;
    const next = value[index + 1];
    if (next === undefined) break;
    if (!/[A-Za-z]/u.test(next)) {
      return { name: value.slice(0, index), version: value.slice(index + 1) };
    }
  }
  return { name: value };
}

export function parseStorePath(value: string): NixStorePath {
  const match = STORE_PATH.exec(value.trim());
  if (!match?.[1] || !match[2])
    throw new ProviderError('INVALID_PURL', `Not a Nix store path: ${value}`);
  const { name, version } = splitDerivationName(match[2]);
  return {
    hash: match[1],
    name,
    ...(!(version === undefined) && { version }),
    isDerivation: value.trim().endsWith('.drv'),
  };
}

export class NixCodec implements EcosystemCodec {
  readonly purlType = NIX_PURL_TYPE;

  parseNativeCoordinate(value: string): NativeCoordinate {
    const parsed = parseStorePath(value);
    return {
      ecosystem: NIX_PURL_TYPE,
      name: parsed.name,
      // A store path has no namespace: the store is flat.
      ...(!(parsed.version === undefined) && { version: parsed.version }),
      original: value,
    };
  }

  /**
   * Canonicalize a `pkg:nix` PURL. `output` defaults to `out` because a store
   * path always realises exactly one output, and a selector that omits it
   * would otherwise be ambiguous once a package exposes several.
   */
  canonicalizePurl(value: string) {
    const parsed = parsePurl(value);
    if (parsed.type !== NIX_PURL_TYPE)
      throw new ProviderError(
        'INVALID_PURL',
        `Expected a ${NIX_PURL_TYPE} PURL: ${value}`,
      );
    if (parsed.namespace !== undefined)
      throw new ProviderError(
        'INVALID_PURL',
        'nix PURLs have no namespace: the store is flat',
      );
    const qualifiers: Record<string, string> = { ...parsed.qualifiers };
    if (qualifiers.output === undefined) qualifiers.output = 'out';
    for (const key of ['outhash', 'plan'] as const) {
      const hash = qualifiers[key];
      if (hash !== undefined && !STORE_HASH.test(hash))
        throw new ProviderError(
          'INVALID_PURL',
          `nix ${key} qualifier must be a 32-character store hash`,
        );
    }
    return formatPurl({
      type: NIX_PURL_TYPE,
      name: parsed.name,
      ...(!(parsed.version === undefined) && { version: parsed.version }),
      qualifiers,
    });
  }

  /**
   * Nix versions are arbitrary strings ordered component-wise, where a numeric
   * component compares numerically and a non-numeric one lexically. This
   * mirrors `compareVersions` in Nix rather than semver.
   */
  parseNativeVersion(value: string): ParsedVersion {
    const original = value.trim();
    if (!original)
      throw new ProviderError('INVALID_PURL', 'nix version must not be empty');
    const components = splitVersionComponents(original);
    const release: number[] = [];
    for (const component of components) {
      if (!/^\d+$/u.test(component)) break;
      release.push(Number(component));
    }
    return {
      original,
      normalized: original,
      release,
      prerelease: components.slice(release.length),
      build: [],
    };
  }

  compareNativeVersions(left: string, right: string): number {
    const leftParts = splitVersionComponents(left.trim());
    const rightParts = splitVersionComponents(right.trim());
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
      const ordering = compareComponent(leftParts[index], rightParts[index]);
      if (ordering !== 0) return ordering;
    }
    return 0;
  }

  /**
   * Nix has no dependency range syntax: a derivation names exact inputs. A
   * captured requirement is therefore always an exact version, and anything
   * else is recorded as loss rather than guessed at.
   */
  parseNativeRange(value: string): ParsedRange {
    const original = value.trim();
    // Only a bare version or an explicit `=` is exact. Anything carrying a
    // comparison operator came from somewhere other than a derivation, and
    // collapsing it to an exact pin changes which versions match.
    const operator = /^(>=|<=|[><~^!]=?|=)/u.exec(original)?.[1];
    const exact =
      operator === undefined
        ? original
        : original.slice(operator.length).trim();
    const isExact = operator === undefined || operator === '=';
    return {
      scheme: NIX_PURL_TYPE,
      original,
      normalized: `=${exact}`,
      ast: { type: 'comparison', operator: '=', version: exact },
      vers: `vers:${NIX_PURL_TYPE}/=${exact}`,
      reversible: isExact,
      semanticLoss: isExact
        ? []
        : [
            loss(
              'NIX_RANGE_NOT_REPRESENTED',
              '/range',
              `the native constraint ${original} is not an exact version`,
              `represented as the exact version ${exact}`,
              'warning',
            ),
          ],
    };
  }

  toVers(value: string): VersionConstraint {
    const range = this.parseNativeRange(value);
    return {
      ...(!(range.vers === undefined) && { vers: range.vers }),
      scheme: NIX_PURL_TYPE,
      original: range.original,
      normalized: range.normalized,
      // SAFETY: The surrounding boundary establishes the asserted domain contract.
      ast: range.ast as VersionConstraint['ast'],
      reversible: range.reversible,
      semanticLoss: [...range.semanticLoss],
    };
  }

  satisfies(version: string, range: string | ParsedRange): boolean {
    const parsed =
      typeof range === 'string' ? this.parseNativeRange(range) : range;
    if (parsed.ast.type !== 'comparison') return false;
    return this.compareNativeVersions(version, parsed.ast.version) === 0;
  }

  /**
   * Translate one `nix path-info --json` entry into a `PackageInstance`.
   * References become runtime references on the output artifact; the deriver
   * becomes the `plan` qualifier tying sibling outputs together.
   */
  async translateMetadata(
    metadata: unknown,
    provenance: TranslationProvenance,
  ) {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const record = metadata as NixPathInfo;
    if (typeof record?.path !== 'string')
      throw new ProviderError(
        'INVALID_PROVIDER_METADATA',
        'nix path-info entry needs a path',
      );
    const store = parseStorePath(record.path);
    const output = record.output ?? 'out';
    const plan =
      record.deriver === undefined
        ? undefined
        : parseStorePath(record.deriver).hash;

    const qualifiers: Record<string, string> = {
      outhash: store.hash,
      output,
      ...(!(plan === undefined) && { plan }),
    };
    const losses: SemanticLoss[] = [
      loss(
        'NIX_STORE_PATH_HASH_OPAQUE',
        '/identity/qualifiers/outhash',
        'Nix truncated base32 input-address hash',
        'opaque exact-PURL qualifier; not a PREX digest',
      ),
      loss(
        'NIX_EXPRESSION_NOT_EVALUATED',
        '/',
        'the Nix expression that produced this path was not evaluated by PREX',
        'the realised store entry as captured',
      ),
    ];
    // A store name without a version is still unique by its hash; using the
    // hash as the version keeps identity exact instead of inventing 0.0.0.
    const version = store.version ?? store.hash;
    if (store.version === undefined)
      losses.push(
        loss(
          'NIX_UNVERSIONED_NAME',
          '/identity/version',
          'the store name carries no parseable version',
          'the store-path hash is used as the exact version',
        ),
      );

    const exactPurl = this.canonicalizePurl(
      formatPurl({
        type: NIX_PURL_TYPE,
        name: store.name,
        version,
        qualifiers,
      }),
    );
    const canonicalPurl = formatPurl({
      type: NIX_PURL_TYPE,
      name: store.name,
      qualifiers: {},
    });

    const narDigest = parseNarHash(record.narHash);
    if (record.narHash !== undefined && narDigest === undefined)
      losses.push(
        loss(
          'CONTENT_ADDRESS_UNSUPPORTED',
          '/narHash',
          `the store entry declares narHash ${record.narHash}`,
          'the hash algorithm is not representable as a PREX sha256 digest',
          'error',
        ),
      );

    const references = (record.references ?? [])
      .filter((reference) => reference !== record.path)
      .map((reference) => ({
        // Keep the original path: a store path is the locator, and
        // reconstructing one from the split name would drop the version.
        storePath: reference,
        ...parseStorePath(reference),
      }))
      .sort((left, right) => compareCodePoints(left.hash, right.hash));

    // References are recorded as the store paths they are. Resolving them to
    // node identities needs the rest of the closure, so that is the closure
    // assembler's job — inventing an identity here would fabricate one.
    const artifacts = narDigest
      ? [
          {
            descriptorId: `${store.hash}-nar`,
            digest: narDigest,
            size: record.narSize ?? 0,
            mediaType: 'application/x-nix-nar',
            artifactType: 'nix-output',
            nativeRole: 'nix-output-nar',
            locations: [],
            referrers: [],
            externalRefs: references.map((reference) => ({
              type: 'nix-reference',
              locator: reference.storePath,
            })),
          },
        ]
      : [];

    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const instance: PackageInstance = {
      nodeId: await packageNodeId({
        exactPurl,
        qualifiers,
        nativeSemanticsVersion: 'nix-store-v1',
      }),
      identity: {
        canonicalPurl,
        exactPurl,
        purlType: NIX_PURL_TYPE,
        name: store.name,
        version,
        qualifiers,
        nativeCoordinates: [
          {
            ecosystem: NIX_PURL_TYPE,
            coordinate: record.path,
            version,
          },
        ],
        aliases: [],
        sourceRefs: [sourceRef(NIX_PURL_TYPE, provenance.endpoint)],
        publisherRefs: [],
        externalRefs: [],
      },
      nativeVersion: version,
      normalizedVersion: version,
      versionSortKey: versionSortKey(version),
      // A store entry's references are its runtime closure; PREX records them
      // as requirements on the exact sibling paths, which is what Nix means.
      requirements: references.map((reference, index) => ({
        id: `${store.hash}-ref-${index}`,
        expression: {
          type: 'package' as const,
          purl: formatPurl({
            type: NIX_PURL_TYPE,
            name: reference.name,
            qualifiers: {},
          }),
          qualifiers: { outhash: reference.hash },
        },
        kind: 'runtime' as const,
        optional: false,
        source: sourceRef(NIX_PURL_TYPE, provenance.endpoint),
        authority: 'derivation-capture',
        semanticLoss: [],
      })),
      capabilities: [],
      conflicts: [],
      cardinalityConstraints: [],
      artifacts,
      outputs: [
        {
          name: output,
          default: output === 'out',
          artifactDescriptorIds: artifacts.map((item) => item.descriptorId),
        },
      ],
      lifecycle: { status: 'published', eligible: true, warnings: [] },
      sourceSnapshots: provenance.snapshotDigest
        ? [provenance.snapshotDigest]
        : [],
      metadataDigest: provenance.metadataDigest,
      nativeSemantics: {
        version: 'nix-store-v1',
        // SAFETY: The surrounding boundary establishes the asserted domain contract.
        data: JSON.parse(
          JSON.stringify({
            storePath: record.path,
            ...(!(record.deriver === undefined) && { deriver: record.deriver }),
            ...(!(record.narHash === undefined) && { narHash: record.narHash }),
          }),
        ) as JsonValue,
      },
      semanticLoss: losses,
    } as PackageInstance;

    return { instance, rawMetadata: metadata };
  }

  /**
   * A closure listing (`nix path-info --json --recursive`) is the closest Nix
   * equivalent of a lockfile: an exact, already-resolved set.
   */
  translateLockResult(
    lock: unknown,
    _provenance: TranslationProvenance,
  ): LockCapture {
    // SAFETY: The surrounding boundary establishes the asserted domain contract.
    const entries = Array.isArray(lock) ? (lock as NixPathInfo[]) : [];
    if (entries.length === 0)
      throw new ProviderError(
        'INVALID_LOCKFILE',
        'nix closure capture needs at least one store path',
      );
    return {
      format: 'nix-path-info',
      formatVersion: '1',
      packages: entries.map((entry) => {
        const store = parseStorePath(entry.path);
        const output = entry.output ?? 'out';
        const version = store.version ?? store.hash;
        const narDigest = parseNarHash(entry.narHash);
        return {
          exactPurl: this.canonicalizePurl(
            formatPurl({
              type: NIX_PURL_TYPE,
              name: store.name,
              version,
              qualifiers: {
                outhash: store.hash,
                output,
              },
            }),
          ),
          nativeCoordinate: entry.path,
          ...(!(narDigest === undefined) && {
            artifactDigest: `sha256:${narDigest.value}`,
          }),
          dependencies: Object.fromEntries(
            (entry.references ?? [])
              .filter((reference) => reference !== entry.path)
              .map((reference) => {
                const parsed = parseStorePath(reference);
                return [parsed.name, parsed.hash];
              }),
          ),
          // SAFETY: The surrounding boundary establishes the asserted domain contract.
          native: entry as unknown,
        };
      }),
      semanticLoss: [
        loss(
          'NIX_EXPRESSION_NOT_EVALUATED',
          '/',
          'the Nix expressions behind this closure were not evaluated',
          'the realised closure as captured from a store',
        ),
      ],
    };
  }
}

/** `nix path-info --json` entry shape, restricted to the fields PREX reads. */
export interface NixPathInfo {
  path: string;
  output?: string;
  deriver?: string;
  narHash?: string;
  narSize?: number;
  references?: readonly string[];
}

function splitVersionComponents(value: string): string[] {
  // Nix splits on `.` and `-`, and additionally between digit and non-digit.
  return value
    .split(/[.-]/u)
    .flatMap((part) => part.match(/\d+|\D+/gu) ?? [])
    .filter((part) => part.length > 0);
}

function compareComponent(left?: string, right?: string): number {
  if (left === undefined && right === undefined) return 0;
  // A missing component sorts before a present one, except that a
  // pre-release-looking component sorts before nothing at all.
  if (left === undefined) return isPreRelease(right!) ? 1 : -1;
  if (right === undefined) return isPreRelease(left) ? -1 : 1;
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) {
    const difference = Number(left) - Number(right);
    return difference === 0 ? 0 : difference < 0 ? -1 : 1;
  }
  if (leftNumeric) return 1;
  if (rightNumeric) return -1;
  return compareCodePoints(left, right);
}

/**
 * Nix's `compareVersions` special-cases exactly one component: `pre` sorts
 * before a missing component. Everything else, including `rc` and `alpha`,
 * follows the ordinary rule that a string component sorts before nothing.
 */
function isPreRelease(component: string): boolean {
  return component === 'pre';
}

function versionSortKey(version: string): string {
  return splitVersionComponents(version)
    .map((component) =>
      /^\d+$/u.test(component) ? component.padStart(12, '0') : component,
    )
    .join('.');
}

const NIXBASE32 = '0123456789abcdfghijklmnpqrsvwxyz';

/**
 * Decode Nix's base32, which reads least-significant character first and is
 * what `nix path-info` and narinfo actually emit for a sha256.
 */
export function decodeNixBase32(value: string): Uint8Array | undefined {
  const length = Math.floor((value.length * 5) / 8);
  const output = new Uint8Array(length);
  for (let index = 0; index < value.length; index += 1) {
    const digit = NIXBASE32.indexOf(value[value.length - index - 1]!);
    if (digit < 0) return undefined;
    const bit = index * 5;
    const byte = bit >> 3;
    const offset = bit & 7;
    output[byte]! |= (digit << offset) & 0xff;
    const carry = digit >> (8 - offset);
    if (carry !== 0) {
      if (byte + 1 >= length) return undefined;
      output[byte + 1]! |= carry;
    }
  }
  return output;
}

const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Representable spellings of a sha256: hex, SRI base64, and Nix base32.
 * Anything else — a different algorithm — is not coerced; callers record
 * `CONTENT_ADDRESS_UNSUPPORTED` instead.
 */
export function parseNarHash(
  value: string | undefined,
): { algorithm: 'sha256'; value: string } | undefined {
  if (value === undefined) return undefined;
  const body = value.startsWith('sha256:')
    ? value.slice(7)
    : value.startsWith('sha256-')
      ? value.slice(7)
      : undefined;
  if (body === undefined) return undefined;
  if (/^[0-9a-f]{64}$/u.test(body)) return { algorithm: 'sha256', value: body };
  if (/^[0-9abcdfghijklmnpqrsvwxyz]{52}$/u.test(body)) {
    const bytes = decodeNixBase32(body);
    return bytes && bytes.length >= 32
      ? { algorithm: 'sha256', value: hex(bytes.slice(0, 32)) }
      : undefined;
  }
  if (/^[A-Za-z0-9+/]{43}=$/u.test(body)) {
    const binary = atob(body);
    let output = '';
    for (let index = 0; index < binary.length; index += 1)
      output += binary.charCodeAt(index).toString(16).padStart(2, '0');
    return /^[0-9a-f]{64}$/u.test(output)
      ? { algorithm: 'sha256', value: output }
      : undefined;
  }
  return undefined;
}
export * from './provider.js';

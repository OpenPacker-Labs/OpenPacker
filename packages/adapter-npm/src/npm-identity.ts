import type { Digest, PackageIdentity } from '@openpacker/contracts';
import { formatPurl, parsePurl } from '@openpacker/adapter-core';

/** How an npm package is named, identified and digested; pure helpers. */

export const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

export const npmName = (namespace: string | undefined, name: string): string =>
  namespace === undefined ? name : `@${namespace.replace(/^@/, '')}/${name}`;
export const npmNamespace = (
  namespace: string | undefined,
): string | undefined =>
  namespace === undefined
    ? undefined
    : `@${namespace.replace(/^@/, '').toLowerCase()}`;

export function identityFromPurl(value: string): PackageIdentity {
  const parsed = parsePurl(value);
  const base = formatPurl({ ...parsed, version: undefined });
  const identity: PackageIdentity = {
    canonicalPurl: base,
    purlType: 'npm',
    name: parsed.name,
    qualifiers: { ...parsed.qualifiers },
    nativeCoordinates: [
      {
        ecosystem: 'npm',
        coordinate: npmName(parsed.namespace, parsed.name),
        ...(!(parsed.version === undefined) && { version: parsed.version }),
      },
    ],
    aliases: [],
    sourceRefs: [],
    publisherRefs: [],
    externalRefs: [],
  };
  if (parsed.namespace !== undefined) identity.namespace = parsed.namespace;
  if (parsed.version !== undefined) {
    identity.version = parsed.version;
    identity.exactPurl = formatPurl(parsed);
  }
  if (parsed.subpath !== undefined) identity.subpath = parsed.subpath;
  return identity;
}

export function sriSha256(value: string | undefined): Digest | undefined {
  const token = value
    ?.split(/\s+/)
    .find((entry) => entry.startsWith('sha256-'));
  if (!token) return undefined;
  try {
    const bytes = Uint8Array.from(atob(token.slice(7)), (character) =>
      character.charCodeAt(0),
    );
    if (bytes.byteLength !== 32) return undefined;
    return {
      algorithm: 'sha256',
      value: [...bytes]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    };
  } catch {
    return undefined;
  }
}

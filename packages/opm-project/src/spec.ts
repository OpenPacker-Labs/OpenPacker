import type { ParsedPackageSpec } from './types.js';
import { OpmError } from './types.js';

/** PURL type shape (package-url). Open set — adapters define which are known. */
const PURL_TYPE = /^[a-z0-9][a-z0-9.+-]*$/u;

/**
 * Parse package specs for `opm add`.
 * Accepts:
 * - pkg:type/name@version
 * - name@version with --ecosystem
 * - name with --ecosystem
 *
 * Does not hardcode the set of ecosystems: any well-formed PURL type is
 * accepted here; the adapter registry decides whether it is supported.
 */
export function parsePackageSpec(
  raw: string,
  options: { ecosystem?: string; source?: string; alias?: string } = {},
): ParsedPackageSpec {
  const trimmed = raw.trim();
  if (!trimmed) throw new OpmError('INVALID_SPEC', 'Package spec is empty');

  if (trimmed.startsWith('pkg:')) {
    return parsePurlSpec(trimmed, options);
  }

  const ecosystem = options.ecosystem;
  if (!ecosystem) {
    throw new OpmError(
      'AMBIGUOUS_SPEC',
      `Bare package name "${trimmed}" requires --ecosystem <purl-type> or a full pkg: PURL`,
    );
  }
  if (!PURL_TYPE.test(ecosystem)) {
    throw new OpmError('INVALID_SPEC', `Unknown ecosystem "${ecosystem}"`);
  }

  const at = splitNameVersion(trimmed);
  const purlName = encodePurlName(at.name, ecosystem);
  const purl = `pkg:${ecosystem}/${purlName}`;
  const alias =
    options.alias ??
    simpleAlias(at.name.includes('/') ? at.name.split('/').pop()! : at.name);

  const result: ParsedPackageSpec = {
    alias,
    purl,
    ecosystem,
  };
  if (at.version !== undefined) result.version = at.version;
  if (options.source !== undefined) result.source = options.source;
  return result;
}

function parsePurlSpec(
  purl: string,
  options: { ecosystem?: string; source?: string; alias?: string },
): ParsedPackageSpec {
  // Minimal PURL: pkg:type/name@version  (name may contain / and %40)
  const match = purl.match(
    /^pkg:([A-Za-z0-9.-]+)\/(.+?)(?:@([^?#]+))?(?:\?([^#]*))?(?:#.*)?$/,
  );
  if (!match) {
    throw new OpmError('INVALID_SPEC', `Invalid PURL: ${purl}`);
  }
  const ecosystem = match[1] ?? '';
  const namePart = match[2] ?? '';
  const version = match[3];
  if (options.ecosystem && options.ecosystem !== ecosystem) {
    throw new OpmError(
      'INVALID_SPEC',
      `PURL ecosystem "${ecosystem}" does not match --ecosystem ${options.ecosystem}`,
    );
  }
  const decodedName = decodeURIComponent(namePart);
  const baseName = decodedName.includes('/')
    ? decodedName.split('/').pop()!
    : decodedName;
  const alias = options.alias ?? simpleAlias(baseName.replace(/^@/, ''));
  const basePurl = version
    ? `pkg:${ecosystem}/${namePart}`
    : `pkg:${ecosystem}/${namePart}`;
  // Keep version in purl if present for exact; also expose version field
  const result: ParsedPackageSpec = {
    alias,
    purl: version ? `${basePurl}@${version}` : basePurl,
    ecosystem,
  };
  if (version !== undefined) result.version = version;
  if (options.source !== undefined) result.source = options.source;
  return result;
}

function splitNameVersion(spec: string): { name: string; version?: string } {
  // scoped npm: @scope/name@version
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/');
    if (slash === -1) return { name: spec };
    const rest = spec.slice(slash + 1);
    const at = rest.lastIndexOf('@');
    if (at <= 0) return { name: spec };
    return {
      name: spec.slice(0, slash + 1 + at),
      version: rest.slice(at + 1),
    };
  }
  const at = spec.lastIndexOf('@');
  if (at <= 0) return { name: spec };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

function encodePurlName(name: string, ecosystem: string): string {
  if (ecosystem === 'npm' && name.startsWith('@')) {
    // pkg:npm/%40scope/name
    const without = name.slice(1);
    const slash = without.indexOf('/');
    if (slash === -1) return `%40${encodeURIComponent(without)}`;
    const scope = without.slice(0, slash);
    const pkg = without.slice(slash + 1);
    return `%40${encodeURIComponent(scope)}/${encodeURIComponent(pkg)}`;
  }
  return name
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function simpleAlias(name: string): string {
  return (
    name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'pkg'
  );
}

export function ecosystemFromPurl(purl: string): string {
  const match = purl.match(/^pkg:([A-Za-z0-9.-]+)\//);
  if (!match?.[1]) {
    throw new OpmError('INVALID_SPEC', `Cannot read ecosystem from ${purl}`);
  }
  return match[1];
}

export function exactPurl(purl: string, version: string): string {
  if (/@[^/?#]+$/.test(purl) && !purl.includes('@', purl.indexOf('/'))) {
    // already has version after name — rough check
  }
  const match = purl.match(
    /^(pkg:[A-Za-z0-9.-]+\/.+?)(?:@([^?#]+))?(?:\?([^#]*))?(?:#.*)?$/,
  );
  if (!match) return `${purl}@${version}`;
  const base = match[1] ?? purl;
  const query = match[3] ? `?${match[3]}` : '';
  return `${base}@${version}${query}`;
}

export function stripPurlVersion(purl: string): string {
  const match = purl.match(
    /^(pkg:[A-Za-z0-9.-]+\/.+?)(?:@([^?#]+))?(?:\?([^#]*))?(?:#.*)?$/,
  );
  if (!match) return purl;
  const base = match[1] ?? purl;
  const query = match[3] ? `?${match[3]}` : '';
  return `${base}${query}`;
}

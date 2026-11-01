import {
  echoed,
  formatPurl,
  parsePurl,
  type ParsedPurl,
} from '@openpacker/adapter-core';
import type { ParsedPackageSpec } from './types.js';
import { OpmError } from './types.js';

/** PURL type shape (package-url). Open set — adapters define which are known. */
const PURL_TYPE = /^[a-z0-9][a-z0-9.+-]*$/u;

/**
 * Parse package specs for `opm add`.
 * Accepts:
 * - pkg:type/name@version
 * - packslip:project@version (`packslip:jdx/hk`, `packslip:github.com/jdx/hk@2.5.0`)
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
  if (trimmed.startsWith('packslip:')) {
    return parsePackslipSpec(trimmed, options);
  }

  // `string-width-cjs@npm:string-width@^4.2.0`: npm's alias, installed under
  // the first name. Only npm spells it, so the ecosystem is npm.
  const aliasAt = trimmed.indexOf('@npm:', 1);
  if (aliasAt > 0) return parseAliasSpec(trimmed, aliasAt, options);

  const ecosystem = options.ecosystem;
  if (!ecosystem) {
    throw new OpmError(
      'AMBIGUOUS_SPEC',
      `Bare package name "${echoed(trimmed)}" requires --ecosystem <purl-type> or a full pkg: PURL`,
    );
  }
  if (!PURL_TYPE.test(ecosystem)) {
    throw new OpmError(
      'INVALID_SPEC',
      `Unknown ecosystem "${echoed(ecosystem)}"`,
    );
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

/**
 * A project's own name for a package that npm installs under another name:
 * `installName@npm:target[@spec]`. The target is the registry package, the
 * spec is what is asked of it (a version, a range, a dist-tag, or nothing for
 * any version), and the install name is the directory it is installed in.
 */
function parseAliasSpec(
  trimmed: string,
  aliasAt: number,
  options: { ecosystem?: string; source?: string; alias?: string },
): ParsedPackageSpec {
  if (options.ecosystem !== undefined && options.ecosystem !== 'npm')
    throw new OpmError(
      'INVALID_SPEC',
      `"${trimmed}" is an npm: alias, and --ecosystem is ${options.ecosystem}`,
    );
  const installName = trimmed.slice(0, aliasAt);
  const body = trimmed.slice(aliasAt + '@npm:'.length);
  const at = splitNameVersion(body);
  if (at.name === '' || at.name.startsWith('npm:'))
    throw new OpmError(
      'INVALID_SPEC',
      `"${trimmed}" does not name a registry package after npm:`,
    );
  if (!/^(?:@[^/\s@]+\/)?[^@/\s:]+$/u.test(at.name))
    throw new OpmError(
      'INVALID_SPEC',
      `"${at.name}" is not a package name (in ${trimmed})`,
    );
  const result: ParsedPackageSpec = {
    alias:
      options.alias ??
      simpleAlias(
        installName.includes('/') ? installName.split('/').pop()! : installName,
      ),
    purl: `pkg:npm/${encodePurlName(at.name, 'npm')}`,
    ecosystem: 'npm',
    installName,
  };
  if (at.version !== undefined && at.version !== '')
    result.version = at.version;
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
    throw new OpmError('INVALID_SPEC', `Invalid PURL: ${echoed(purl)}`);
  }
  const ecosystem = match[1] ?? '';
  const namePart = match[2] ?? '';
  const version = match[3];
  if (options.ecosystem && options.ecosystem !== ecosystem) {
    throw new OpmError(
      'INVALID_SPEC',
      `PURL ecosystem "${echoed(ecosystem)}" does not match --ecosystem ${echoed(options.ecosystem)}`,
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

/** A project name: a host, then path segments, none of them empty or exotic. */
const PROJECT_SEGMENT = /^[A-Za-z0-9._~-]+$/u;

/**
 * `packslip:` is shorthand for the PURL of a project whose releases are signed
 * with packslip. The project is the name its vendor publishes under, so it is
 * written the way the vendor writes it: `github.com/jdx/hk`, or a domain such
 * as `mise.jdx.dev`. `jdx/hk` alone means GitHub, the same convention the
 * packslip tools use, and is expanded here so the manifest and the lock always
 * carry the full name that a trust setting is keyed by.
 */
function parsePackslipSpec(
  spec: string,
  options: { ecosystem?: string; source?: string; alias?: string },
): ParsedPackageSpec {
  if (options.ecosystem !== undefined && options.ecosystem !== 'packslip')
    throw new OpmError(
      'INVALID_SPEC',
      `A packslip: spec is for the packslip ecosystem, not --ecosystem ${options.ecosystem}`,
    );
  const body = spec.slice('packslip:'.length);
  const { name, version } = splitNameVersion(body);
  const segments = name.split('/');
  if (
    name === '' ||
    segments.some(
      (segment) =>
        !PROJECT_SEGMENT.test(segment) || segment === '.' || segment === '..',
    ) ||
    (version !== undefined && version === '')
  )
    throw new OpmError(
      'INVALID_SPEC',
      `"${spec}" does not name a packslip project (expected packslip:<host>/<path>[@version], such as packslip:github.com/jdx/hk)`,
    );
  // `owner/repo` is GitHub shorthand: a first segment with no dot is not a host,
  // and then there must be exactly an owner and a repository. Anything else
  // (`a/b/c`, a lone `mise`) names no project, and is refused here rather than
  // as a GitHub project that cannot exist.
  const shorthand = !segments[0]?.includes('.');
  if (shorthand && segments.length !== 2)
    throw new OpmError(
      'INVALID_SPEC',
      `"${spec}" does not name a packslip project: write packslip:<owner>/<repo> for GitHub, or packslip:<host>/<path> such as packslip:github.com/jdx/hk`,
    );
  const qualified = shorthand ? ['github.com', ...segments] : segments;
  const purl = `pkg:packslip/${qualified.map((part) => encodeURIComponent(part)).join('/')}`;
  const last =
    qualified.length > 1 ? qualified.at(-1) : qualified[0]?.split('.')[0];
  const result: ParsedPackageSpec = {
    alias: options.alias ?? simpleAlias(last ?? 'tool'),
    purl: version === undefined ? purl : `${purl}@${version}`,
    ecosystem: 'packslip',
  };
  if (version !== undefined) result.version = version;
  if (options.source !== undefined) result.source = options.source;
  return result;
}

function splitNameVersion(spec: string) {
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

/** Local opm alias for a native package name (`@scope/pkg` → `pkg`). */
export function aliasFromNativeName(name: string): string {
  const last = name.includes('/') ? name.split('/').pop()! : name;
  return simpleAlias(last.replace(/^@/, ''));
}

export function ecosystemFromPurl(purl: string): string {
  const match = purl.match(/^pkg:([A-Za-z0-9.-]+)\//);
  if (!match?.[1]) {
    throw new OpmError(
      'INVALID_SPEC',
      `Cannot read ecosystem from ${echoed(purl)}`,
    );
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

/**
 * `purl`'s package at `version`, the version encoded as one PURL component.
 *
 * What a manifest writes for a version is text, not PURL syntax: joined after
 * `@`, a `/`, `@`, `?` or `#` in it reads back as another namespace and name, a
 * qualifier or a subpath. So the PURL is built from `purl`'s own type,
 * namespace, name and qualifiers with `version` as its version (no subpath: a
 * request names a package, not a path inside one, as `exactPurl` never kept
 * one either), and read back. The version is the only text the manifest line
 * supplies, so it is the one thing compared: a character of it that escaped
 * the version component would take it out of the version read back, which
 * then differs. A line no PURL can carry (empty, too long, a lone surrogate)
 * is refused too, so no version line can name another package.
 */
export function purlAtVersion(purl: string, version: string): string {
  const own = parsePurl(purl);
  let target: string | undefined;
  let read: ParsedPurl | undefined;
  try {
    target = formatPurl({
      type: own.type,
      ...(own.namespace !== undefined && { namespace: own.namespace }),
      name: own.name,
      version,
      qualifiers: own.qualifiers,
    });
    read = parsePurl(target);
  } catch {
    read = undefined;
  }
  if (target === undefined || read === undefined || read.version !== version)
    throw new OpmError(
      'INVALID_MANIFEST',
      `${JSON.stringify(version)} cannot be written as a version of ${stripPurlVersion(purl)}`,
    );
  return target;
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

/**
 * The name an ecosystem spells a package with, recovered from its PURL.
 *
 * PURL percent-encodes the parts that would otherwise be structural, so `@` in
 * an npm scope arrives as `%40`. Decoding per segment rather than over the
 * whole string keeps a literal `/` inside a segment from becoming a separator.
 * A version or qualifiers on the PURL are not part of the name.
 */
export function purlPackageName(purl: string): string {
  const withoutScheme = purl.replace(/^pkg:[A-Za-z0-9.+-]+\//u, '');
  const withoutQualifiers = withoutScheme.split(/[?#]/u)[0] ?? withoutScheme;
  const slash = withoutQualifiers.lastIndexOf('/');
  const at = withoutQualifiers.indexOf('@', slash + 1);
  const body = at === -1 ? withoutQualifiers : withoutQualifiers.slice(0, at);
  return body
    .split('/')
    .map((segment) => decodeURIComponent(segment))
    .join('/');
}

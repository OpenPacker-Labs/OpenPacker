import { createHash } from 'node:crypto';
import {
  ProviderError,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from '@openpacker/adapter-core';

/**
 * A stand-in npm registry that behaves like registry.npmjs.org where it
 * matters to opm: two document shapes behind one URL (the abbreviated
 * `install-v1` document, which has no publish times, no `scripts` and no
 * `libc`, and the full document, which has all three), a per-version document,
 * and tarballs. Nothing here touches the network.
 */

export const NPM_ORIGIN = 'https://registry.npmjs.org';

/** Stand-in tarball bytes; nothing that uses this fixture extracts them. */
export const TARBALL = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4]);
const TARBALL_SRI = `sha512-${createHash('sha512').update(TARBALL).digest('base64')}`;

export interface FixtureVersion {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  engines?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  /** Only the full and per-version documents carry this, as on npmjs.org. */
  libc?: string[];
  scripts?: Record<string, string>;
  hasInstallScript?: boolean;
  deprecated?: string;
}

export interface FixturePackage {
  name: string;
  versions: Record<string, FixtureVersion>;
  /** Publish time per version; defaults to a date long before any test clock. */
  time?: Record<string, string>;
  /** Last change to the packument; defaults to the same old date. */
  modified?: string;
}

export const OLD = '2026-01-01T00:00:00.000Z';

const ABBREVIATED_KEYS = [
  'dependencies',
  'optionalDependencies',
  'devDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'engines',
  'os',
  'cpu',
  'hasInstallScript',
  'deprecated',
] as const;

function tarballUrl(name: string, version: string): string {
  const base = name.includes('/') ? name.split('/')[1]! : name;
  return `${NPM_ORIGIN}/${name}/-/${base}-${version}.tgz`;
}

function distFor(name: string, version: string) {
  return {
    tarball: tarballUrl(name, version),
    integrity: TARBALL_SRI,
    size: TARBALL.byteLength,
  };
}

function fullVersion(name: string, version: string, value: FixtureVersion) {
  return { name, version, ...value, dist: distFor(name, version) };
}

function abbreviatedVersion(
  name: string,
  version: string,
  value: FixtureVersion,
) {
  const kept: Record<string, unknown> = {};
  for (const key of ABBREVIATED_KEYS)
    if (value[key] !== undefined) kept[key] = value[key];
  return { name, version, ...kept, dist: distFor(name, version) };
}

const json = (value: unknown): HttpResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: new TextEncoder().encode(JSON.stringify(value)),
  url: '',
});

export interface RecordedRequest {
  url: string;
  accept: string | undefined;
}

export class NpmRegistryFixture implements HttpTransport {
  readonly requests: RecordedRequest[] = [];
  readonly #packages = new Map<string, FixturePackage>();

  constructor(packages: readonly FixturePackage[]) {
    for (const item of packages) this.#packages.set(item.name, item);
  }

  /** How many times a packument (either shape) was requested for `name`. */
  packumentRequests(name: string): number {
    const path = `${NPM_ORIGIN}/${encodeURIComponent(name)}`;
    return this.requests.filter((request) => request.url === path).length;
  }

  /** Requests for the full document, i.e. not the abbreviated one. */
  fullPackumentRequests(): RecordedRequest[] {
    return this.requests.filter(
      (request) =>
        !request.url.endsWith('.tgz') &&
        !request.accept?.includes('vnd.npm.install-v1'),
    );
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    const accept = request.headers?.accept;
    this.requests.push({ url: request.url, accept });
    if (request.url.endsWith('.tgz'))
      return {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: TARBALL,
        url: request.url,
      };
    const path = request.url.slice(NPM_ORIGIN.length + 1);
    const versionSplit = path.lastIndexOf('/');
    // `/name` is a packument; `/name/1.2.3` and `/@scope%2fname/1.2.3` are a
    // version document. A scoped name's slash is %2f-encoded in a packument URL.
    const [encodedName, version] =
      versionSplit === -1
        ? [path, undefined]
        : [path.slice(0, versionSplit), path.slice(versionSplit + 1)];
    const name = decodeURIComponent(encodedName!);
    const found = this.#packages.get(name);
    if (!found)
      throw new ProviderError('PACKAGE_NOT_FOUND', `No fixture for ${name}`);
    const withUrl = (response: HttpResponse): HttpResponse => ({
      ...response,
      url: request.url,
    });
    if (version !== undefined) {
      const value = found.versions[version];
      if (!value)
        throw new ProviderError('VERSION_NOT_FOUND', `No ${name}@${version}`);
      return withUrl(json(fullVersion(name, version, value)));
    }
    const abbreviated = accept?.includes('vnd.npm.install-v1') === true;
    const versions = Object.fromEntries(
      Object.entries(found.versions).map(([key, value]) => [
        key,
        abbreviated
          ? abbreviatedVersion(name, key, value)
          : fullVersion(name, key, value),
      ]),
    );
    const newest = Object.keys(found.versions).at(-1)!;
    const modified = found.modified ?? OLD;
    const document = {
      name,
      'dist-tags': { latest: newest },
      versions,
      modified,
      ...(!abbreviated && {
        time: {
          created: OLD,
          modified,
          ...Object.fromEntries(
            Object.keys(found.versions).map((key) => [
              key,
              found.time?.[key] ?? OLD,
            ]),
          ),
        },
      }),
    };
    return withUrl(json(document));
  }
}

/** `{name, versions}` shorthand for a package whose versions have no extras. */
export function plain(
  name: string,
  versions: Record<string, FixtureVersion['dependencies']>,
): FixturePackage {
  return {
    name,
    versions: Object.fromEntries(
      Object.entries(versions).map(([version, dependencies]) => [
        version,
        dependencies === undefined ? {} : { dependencies },
      ]),
    ),
  };
}

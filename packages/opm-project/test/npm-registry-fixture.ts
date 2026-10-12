import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import {
  ProviderError,
  ResponseTooLargeError,
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

/** A real (if tiny) npm tarball: gzip of a ustar archive of package/package.json. */
export function tarball(name: string, version: string): Uint8Array {
  const body = Buffer.from(JSON.stringify({ name, version }));
  const header = Buffer.alloc(512);
  header.write('package/package.json', 0, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  header.write('00000000000\0', 136, 'ascii');
  header.write('        ', 148, 'ascii');
  header.write('0', 156, 'ascii');
  header.write('ustar\0' + '00', 257, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  const padded = Buffer.concat([
    body,
    Buffer.alloc((512 - (body.length % 512)) % 512),
  ]);
  return new Uint8Array(
    gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)])),
  );
}

const tarballs = new Map<string, Uint8Array>();
function tarballOf(name: string, version: string): Uint8Array {
  const key = `${name}@${version}`;
  let bytes = tarballs.get(key);
  if (bytes === undefined) {
    bytes = tarball(name, version);
    tarballs.set(key, bytes);
  }
  return bytes;
}

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
  /** Makes the packument as heavy as a real one with many versions. */
  padding?: Padding;
  /** The full document served as exactly this text, whatever it is. */
  fullBody?: string;
}

/**
 * What `typescript` (8.7 MB, 260,520 values) and `next` (25.6 MB, 846,076) have
 * that a fixture does not: weight. The packument is served with a member the
 * walk never reads, so its size and value count are what a real one's are.
 */
export interface Padding {
  /** Serialized size of the packument, exactly. */
  bytes?: number;
  /** At least this many values (empty arrays) in the packument. */
  values?: number;
  /** Which document is heavy; the abbreviated one is read first and always. */
  only?: 'abbreviated' | 'full';
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
  const bytes = tarballOf(name, version);
  return {
    tarball: tarballUrl(name, version),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    size: bytes.byteLength,
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

const encoder = new TextEncoder();

function padded(
  document: Record<string, unknown>,
  padding: Padding,
): HttpResponse {
  const empties =
    padding.values === undefined
      ? undefined
      : Array.from({ length: padding.values }, () => []);
  const make = (fill: number) =>
    encoder.encode(
      JSON.stringify({
        ...document,
        ...(empties && { 'x-values': empties }),
        ...(padding.bytes !== undefined && { 'x-padding': 'x'.repeat(fill) }),
      }),
    );
  const body =
    padding.bytes === undefined
      ? make(0)
      : make(padding.bytes - make(0).length);
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body,
    url: '',
  };
}

export interface RecordedRequest {
  url: string;
  accept: string | undefined;
}

export class NpmRegistryFixture implements HttpTransport {
  readonly requests: RecordedRequest[] = [];
  readonly #packages = new Map<string, FixturePackage>();

  readonly #serveFull: boolean;

  constructor(
    packages: readonly FixturePackage[],
    options: { serveFull?: boolean } = {},
  ) {
    this.#serveFull = options.serveFull ?? true;
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

  /** Like a real transport, refuses a body past the bound the request set. */
  async request(request: HttpRequest): Promise<HttpResponse> {
    const response = await this.answer(request);
    if (
      request.maximumBytes !== undefined &&
      response.body.byteLength > request.maximumBytes
    )
      throw new ResponseTooLargeError(
        request.maximumBytes,
        response.body.byteLength,
        'delivered',
        response.status,
      );
    return response;
  }

  private async answer(request: HttpRequest): Promise<HttpResponse> {
    const accept = request.headers?.accept;
    this.requests.push({ url: request.url, accept });
    if (request.url.endsWith('.tgz')) {
      // /name/-/base-1.2.3.tgz, with a scoped name's scope in the path.
      const match = /^(.+)\/-\/[^/]+-(\d[^/]*)\.tgz$/u.exec(
        decodeURIComponent(request.url.slice(NPM_ORIGIN.length + 1)),
      );
      return {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: tarballOf(match![1]!, match![2]!),
        url: request.url,
      };
    }
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
    if (!abbreviated && !this.#serveFull)
      throw new ProviderError(
        'UPSTREAM_ERROR',
        'full documents are not served',
      );
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
    if (!abbreviated && found.fullBody !== undefined)
      return withUrl({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: encoder.encode(found.fullBody),
        url: '',
      });
    const heavy =
      found.padding !== undefined &&
      (found.padding.only ?? (abbreviated ? 'abbreviated' : 'full')) ===
        (abbreviated ? 'abbreviated' : 'full');
    return withUrl(heavy ? padded(document, found.padding!) : json(document));
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

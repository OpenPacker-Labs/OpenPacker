import { createHash } from 'node:crypto';
import type { JsonValue } from '@openpacker/contracts';
import { packTarGzip, packZip } from '@openpacker/project-io';
import { signBundle, type TestKey } from './sign.js';

/** The shape of a packslip fetch, stated here so the testkit needs no dependency on packslip. */
export interface FetchRequest {
  readonly maxBytes: number;
  readonly accept?: string;
}

export interface FetchResponse {
  readonly status: number;
  readonly bytes: Uint8Array;
  readonly url: string;
}

/** A scripted network: URL to response, with every request recorded. */
export class FakeWeb {
  readonly requests: string[] = [];
  readonly #routes = new Map<string, FetchResponse | (() => FetchResponse)>();

  set(url: string, body: Uint8Array | string, status = 200): this {
    this.#routes.set(url, {
      status,
      bytes: typeof body === 'string' ? Buffer.from(body) : body,
      url,
    });
    return this;
  }

  setJson(url: string, value: JsonValue, status = 200): this {
    return this.set(url, JSON.stringify(value), status);
  }

  setMissing(url: string): this {
    return this.set(url, '', 404);
  }

  remove(url: string): this {
    this.#routes.delete(url);
    return this;
  }

  async get(url: string, request: FetchRequest): Promise<FetchResponse> {
    this.requests.push(url);
    const route = this.#routes.get(url);
    if (route === undefined)
      return { status: 404, bytes: new Uint8Array(), url };
    const response = typeof route === 'function' ? route() : route;
    if (response.bytes.byteLength > request.maxBytes)
      throw new Error(`${url} is over the ${request.maxBytes} byte limit`);
    return response;
  }
}

export interface FixtureFile {
  readonly path: string;
  readonly contents: string;
  readonly executable?: boolean;
}

export interface ArtifactSpec {
  readonly os?: string;
  readonly arch?: string;
  readonly libc?: string;
  readonly variant?: string;
  readonly format?: 'tar.gz' | 'zip';
  readonly files?: readonly FixtureFile[];
  /** Executables: paths from the archive root, or {path, name}. */
  readonly bin?: readonly (string | { path: string; name: string })[];
  readonly requires?: JsonValue;
  readonly provenance?: readonly string[];
  readonly name?: string;
}

export interface BuildOptions {
  readonly project: string;
  readonly version: string;
  readonly key: TestKey;
  readonly artifacts?: readonly ArtifactSpec[];
  readonly resources?: readonly JsonValue[];
  /** Extra release files published beside the archives, such as completions. */
  readonly assets?: Readonly<Record<string, string>>;
  readonly baseUrl?: string;
  readonly tag?: string;
  readonly publishedAt?: string;
  readonly identity?: Record<string, JsonValue>;
  readonly source?: JsonValue;
  readonly attestedBy?: string;
}

export interface BuiltRelease {
  readonly statement: JsonValue;
  readonly bundle: Uint8Array;
  readonly archives: ReadonlyMap<string, Uint8Array>;
  readonly urls: ReadonlyMap<string, string>;
  readonly tag: string;
  readonly bundleSha256: string;
}

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

export const DEFAULT_FILES = (name: string): FixtureFile[] => [
  {
    path: `${name}/bin/${name}`,
    contents: `#!/bin/sh\necho ${name}\n`,
    executable: true,
  },
  { path: `${name}/README`, contents: `${name}\n` },
];

/**
 * A complete key-signed release: real archives, a statement whose digests are
 * those archives', and a bundle signed over it. This is the offline stand-in
 * for a vendor's CI run.
 */
export function buildRelease(options: BuildOptions): BuiltRelease {
  const project = options.project;
  const tool = project.split('/').pop() ?? 'tool';
  const tag = options.tag ?? `v${options.version}`;
  const baseUrl =
    options.baseUrl ?? `https://dl.example.com/${tool}/${options.version}`;
  const specs = options.artifacts ?? [
    { os: 'linux', arch: 'x86_64', libc: 'gnu' },
  ];
  const archives = new Map<string, Uint8Array>();
  const urls = new Map<string, string>();
  const subjects: JsonValue[] = [];
  const artifacts: JsonValue[] = specs.map((spec, index) => {
    const format = spec.format ?? 'tar.gz';
    const name =
      spec.name ??
      [
        tool,
        options.version,
        spec.os ?? 'any',
        spec.arch ?? 'any',
        spec.variant,
        `${index}`,
      ]
        .filter((part) => part !== undefined)
        .join('-') + (format === 'zip' ? '.zip' : '.tar.gz');
    const files = spec.files ?? DEFAULT_FILES(tool);
    const entries = files.map((file) => ({
      path: file.path,
      contents: Buffer.from(file.contents),
      ...(file.executable === true && { executable: true }),
    }));
    const bytes = format === 'zip' ? packZip(entries) : packTarGzip(entries);
    archives.set(name, bytes);
    urls.set(name, `${baseUrl}/${name}`);
    subjects.push({
      name,
      digest: {
        sha256: sha256(bytes),
        sha512: createHash('sha512').update(bytes).digest('hex'),
      },
    });
    return {
      name,
      ...(spec.os !== undefined && { os: spec.os }),
      ...(spec.arch !== undefined && { arch: spec.arch }),
      ...(spec.libc !== undefined && { libc: spec.libc }),
      ...(spec.variant !== undefined && { variant: spec.variant }),
      size: bytes.byteLength,
      url: `${baseUrl}/${name}`,
      format,
      bin: [...(spec.bin ?? [`${tool}/bin/${tool}`])],
      ...(spec.requires !== undefined && { requires: spec.requires }),
      ...(spec.provenance !== undefined && {
        provenance: [...spec.provenance],
      }),
    };
  });
  for (const [name, contents] of Object.entries(options.assets ?? {})) {
    const bytes = Buffer.from(contents);
    archives.set(name, bytes);
    urls.set(name, `${baseUrl}/${name}`);
    subjects.push({ name, digest: { sha256: sha256(bytes) } });
  }
  const statement: JsonValue = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: subjects,
    predicateType: 'https://packslip.dev/release/v1',
    predicate: {
      project,
      version: options.version,
      published_at: options.publishedAt ?? '2026-09-01T00:00:00Z',
      ...(options.source !== undefined && { source: options.source }),
      artifacts,
      ...(options.resources !== undefined && {
        resources: [...options.resources],
      }),
      identity: {
        scheme: 'sigstore-key',
        key_id: options.key.keyId,
        ...options.identity,
      },
      ...(options.attestedBy !== undefined && {
        attested_by: options.attestedBy,
      }),
    },
  };
  const bundle = signBundle(statement, options.key);
  return {
    statement,
    bundle,
    archives,
    urls,
    tag,
    bundleSha256: sha256(bundle),
  };
}

/** Publish a built release to a fake web at `bundleUrl` and its asset URLs. */
export function publish(
  web: FakeWeb,
  release: BuiltRelease,
  bundleUrl: string,
): void {
  web.set(bundleUrl, release.bundle);
  for (const [name, bytes] of release.archives) {
    const url = release.urls.get(name);
    if (url !== undefined) web.set(url, bytes);
  }
}

export interface ListEntry {
  readonly version: string;
  readonly tag?: string;
  readonly url: string;
  readonly release: BuiltRelease;
  readonly yanked?: string | true;
  readonly security?: boolean;
  /** Pin a digest other than the bundle's own, to model a swapped bundle. */
  readonly pinnedSha256?: string;
}

export interface ListOptions {
  readonly project: string;
  readonly key: TestKey;
  readonly sequence: number;
  readonly entries: readonly ListEntry[];
  readonly latest?: string;
  readonly generatedAt?: string;
  readonly expiresAt?: string;
}

/** A signed `releases/v1` list pinning each entry's bundle by digest. */
export function buildList(options: ListOptions): Uint8Array {
  const statement: JsonValue = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: options.entries.map((entry) => ({
      name: entry.url,
      digest: { sha256: entry.pinnedSha256 ?? entry.release.bundleSha256 },
    })),
    predicateType: 'https://packslip.dev/releases/v1',
    predicate: {
      project: options.project,
      generated_at: options.generatedAt ?? '2026-09-01T00:00:00Z',
      expires_at: options.expiresAt ?? '2027-09-01T00:00:00Z',
      sequence: options.sequence,
      ...(options.latest !== undefined && { latest: options.latest }),
      identity: { scheme: 'sigstore-key', key_id: options.key.keyId },
      releases: options.entries.map((entry) => ({
        version: entry.version,
        ...(entry.tag !== undefined && { tag: entry.tag }),
        published_at: '2026-09-01T00:00:00Z',
        packslip: entry.url,
        ...(entry.yanked !== undefined && {
          status: 'yanked',
          ...(typeof entry.yanked === 'string' && {
            status_reason: entry.yanked,
          }),
        }),
        ...(entry.security === true && { security: true }),
      })),
    },
  };
  return signBundle(statement, options.key);
}

export interface GithubRepo {
  readonly repo: string;
  readonly releases: readonly {
    readonly tag: string;
    readonly draft?: boolean;
    readonly assets?: readonly string[];
    readonly release?: BuiltRelease;
  }[];
  readonly latestTag?: string;
  readonly list?: Uint8Array;
}

/**
 * Emulate the three GitHub origins discovery touches. Each release's bundle is
 * served where `releases/download/<tag>/packslip.sigstore.json` would be.
 */
export function githubWorld(web: FakeWeb, repo: GithubRepo): void {
  const api = `https://api.github.com/repos/${repo.repo}`;
  web.setJson(
    `${api}/releases?per_page=100&page=1`,
    repo.releases.map((release) => ({
      tag_name: release.tag,
      draft: release.draft ?? false,
      prerelease: false,
      assets: (release.assets ?? ['packslip.sigstore.json']).map((name) => ({
        name,
      })),
    })),
  );
  if (repo.latestTag === undefined) web.setMissing(`${api}/releases/latest`);
  else web.setJson(`${api}/releases/latest`, { tag_name: repo.latestTag });
  const rawList = `https://raw.githubusercontent.com/${repo.repo}/HEAD/.well-known/packslip.json`;
  if (repo.list === undefined) web.setMissing(rawList);
  else web.set(rawList, repo.list);
  for (const release of repo.releases)
    if (release.release !== undefined)
      publish(
        web,
        release.release,
        `https://github.com/${repo.repo}/releases/download/${encodeURIComponent(release.tag)}/packslip.sigstore.json`,
      );
}

/**
 * The same scripted network as a standard `fetch`, for code that is handed one
 * (an adapter context, the opm CLI). Unknown URLs answer 404, and a body over
 * the size a caller allowed is a failure, as it is for a real bounded client.
 */
export function fakeFetch(web: FakeWeb): typeof fetch {
  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : input).href;
    const response = await web.get(url, { maxBytes: Number.MAX_SAFE_INTEGER });
    // A copy into a plain ArrayBuffer-backed view, which is what Response accepts.
    return new Response(Uint8Array.from(response.bytes), {
      status: response.status,
    });
  };
}

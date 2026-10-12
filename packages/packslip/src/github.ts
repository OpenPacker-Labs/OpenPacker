import type { JsonValue } from '@openpacker/contracts';
import type { Candidate } from './candidates.js';
import { PackslipError } from './errors.js';
import type { Fetcher } from './fetch.js';
import { ObjectReader } from './json.js';
import { bundleFileName, githubListPath, type Project } from './project.js';
import { versionFromTag } from './tags.js';

/** The three GitHub origins discovery touches; tests point them at a local server. */
export interface GithubEndpoints {
  /** REST API: the releases endpoint. */
  readonly api: string;
  /** Where release assets are downloaded from. */
  readonly web: string;
  /** Where a repository's default-branch files are served raw. */
  readonly raw: string;
}

export const GITHUB_ENDPOINTS: GithubEndpoints = {
  api: 'https://api.github.com',
  web: 'https://github.com',
  raw: 'https://raw.githubusercontent.com',
};

export interface GithubRelease {
  readonly tag: string;
  readonly draft: boolean;
  /** GitHub's prerelease flag is unsigned; the signed version decides. */
  readonly prerelease: boolean;
  readonly assets: readonly string[];
}

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

function repository(project: Project): string {
  if (project.forge !== 'github' || project.repository === undefined)
    throw new PackslipError(
      'INVALID_INPUT',
      `${project.name} is not a GitHub project`,
    );
  return project.repository;
}

function unavailable(what: string, status: number, url: string): PackslipError {
  return new PackslipError(
    'UNAVAILABLE',
    `GitHub answered ${status} for ${what} (${url})`,
  );
}

function parseJson(bytes: Uint8Array, what: string): JsonValue {
  try {
    // SAFETY: JSON.parse yields only JSON values; every field is decoded through ObjectReader.
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as JsonValue;
  } catch {
    throw new PackslipError(
      'UNAVAILABLE',
      `GitHub returned unreadable JSON for ${what}`,
    );
  }
}

function decodeRelease(reader: ObjectReader): GithubRelease {
  const assetValues = reader.optionalArray('assets') ?? [];
  const assets = assetValues.map((_, index) =>
    reader.element('assets', index, assetValues).string('name'),
  );
  return {
    tag: reader.string('tag_name'),
    draft: reader.optionalBoolean('draft') ?? false,
    prerelease: reader.optionalBoolean('prerelease') ?? false,
    assets,
  };
}

/**
 * List a repository's releases through the REST endpoint. GitHub redirects a
 * renamed repository's old name to the new one, so a request under an old name
 * still reaches its releases. The result is a hint: order, the prerelease flag
 * and "latest" are all unsigned, and nothing here is trusted until a bundle
 * verifies.
 */
export async function listGithubReleases(
  fetcher: Fetcher,
  project: Project,
  endpoints: GithubEndpoints = GITHUB_ENDPOINTS,
): Promise<GithubRelease[]> {
  const repo = repository(project);
  const releases: GithubRelease[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${endpoints.api}/repos/${repo}/releases?per_page=${PAGE_SIZE}&page=${page}`;
    const response = await fetcher.get(url, {
      maxBytes: MAX_JSON_BYTES,
      accept: 'application/vnd.github+json',
    });
    if (response.status === 404)
      throw new PackslipError(
        'NO_RELEASE',
        `GitHub has no releases for ${repo}`,
      );
    if (response.status !== 200)
      throw unavailable('the releases list', response.status, url);
    const body = parseJson(response.bytes, 'the releases list');
    if (!Array.isArray(body))
      throw new PackslipError(
        'UNAVAILABLE',
        'GitHub returned a releases list that is not an array',
      );
    for (const [index, item] of body.entries())
      releases.push(
        decodeRelease(
          new ObjectReader(item, `releases[${index}]`, 'UNAVAILABLE'),
        ),
      );
    if (body.length < PAGE_SIZE) break;
  }
  return releases;
}

/** The tag of GitHub's latest-release pointer, or `undefined` when there is none. */
export async function githubLatestTag(
  fetcher: Fetcher,
  project: Project,
  endpoints: GithubEndpoints = GITHUB_ENDPOINTS,
): Promise<string | undefined> {
  const repo = repository(project);
  const url = `${endpoints.api}/repos/${repo}/releases/latest`;
  const response = await fetcher.get(url, {
    maxBytes: MAX_JSON_BYTES,
    accept: 'application/vnd.github+json',
  });
  // "No latest release" is an answer; any other failure is an error.
  if (response.status === 404) return undefined;
  if (response.status !== 200)
    throw unavailable('the latest release', response.status, url);
  return new ObjectReader(
    parseJson(response.bytes, 'the latest release'),
    'latest',
    'UNAVAILABLE',
  ).string('tag_name');
}

/**
 * A repository's optional signed list on its default branch. `undefined` when
 * the repository has none; whether that is acceptable depends on whether a list
 * was accepted before.
 */
export async function fetchGithubList(
  fetcher: Fetcher,
  project: Project,
  endpoints: GithubEndpoints = GITHUB_ENDPOINTS,
): Promise<Uint8Array | undefined> {
  const repo = repository(project);
  const url = `${endpoints.raw}/${repo}/HEAD/${githubListPath(project)}`;
  const response = await fetcher.get(url, { maxBytes: 4 * 1024 * 1024 });
  if (response.status === 404) return undefined;
  if (response.status !== 200)
    throw unavailable('the signed release list', response.status, url);
  return response.bytes;
}

/** Where a release asset is downloaded from, built rather than read from an API reply. */
export function githubAssetUrl(
  project: Project,
  tag: string,
  name: string,
  endpoints: GithubEndpoints = GITHUB_ENDPOINTS,
): string {
  return `${endpoints.web}/${repository(project)}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

export function githubBundleUrl(
  project: Project,
  tag: string,
  endpoints: GithubEndpoints = GITHUB_ENDPOINTS,
): string {
  return githubAssetUrl(project, tag, bundleFileName(project), endpoints);
}

/**
 * Candidates from a releases listing: non-draft releases carrying this
 * project's bundle, each version derived from its tag. A tag that names no
 * version is left out; only a signed list can map it. The signed version inside
 * the bundle must agree with the one derived here, or the release is refused.
 */
export function githubCandidates(
  project: Project,
  releases: readonly GithubRelease[],
  endpoints: GithubEndpoints = GITHUB_ENDPOINTS,
): Candidate[] {
  const wanted = bundleFileName(project);
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const release of releases) {
    if (release.draft || !release.assets.includes(wanted)) continue;
    const version = versionFromTag(project, release.tag);
    if (version === undefined || seen.has(version)) continue;
    seen.add(version);
    candidates.push({
      version,
      tag: release.tag,
      bundleUrl: githubBundleUrl(project, release.tag, endpoints),
      yanked: false,
      security: false,
    });
  }
  return candidates;
}

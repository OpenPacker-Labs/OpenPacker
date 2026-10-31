import type { Candidate } from './candidates.js';
import { PackslipError } from './errors.js';
import type { Fetcher } from './fetch.js';
import {
  GITHUB_ENDPOINTS,
  fetchGithubList,
  githubBundleUrl,
  githubCandidates,
  githubLatestTag,
  listGithubReleases,
  type GithubEndpoints,
} from './github.js';
import { parseSignedPayload } from './payload.js';
import { listUrl, type Project } from './project.js';
import { assertListFresh, assertListSequence } from './release-list.js';
import { versionFromTag } from './tags.js';
import type { ReleaseList } from './types.js';
import { shown } from './shown.js';

/** What a consumer remembers about a project's signed list between installs. */
export interface ListMemory {
  /** The highest sequence accepted; a lower one is a rollback. */
  readonly sequence?: number;
  /** Whether a signed list was ever accepted: a missing one is then an error. */
  readonly used?: boolean;
}

export interface DiscoverInput {
  readonly project: Project;
  readonly fetcher: Fetcher;
  readonly now: Date;
  /**
   * Verify the bytes of a signed release-list bundle against the signer the
   * consumer expects and return the decoded list. The caller owns the trust
   * policy; this module only decides what a verified list means.
   */
  readonly verifyList: (bundle: Uint8Array) => ReleaseList;
  readonly memory?: ListMemory;
  readonly endpoints?: GithubEndpoints;
}

export interface Discovery {
  readonly candidates: readonly Candidate[];
  /** The vendor's signed recommendation, when an accepted list gives one. */
  readonly signedLatest?: string;
  /** GitHub's unsigned latest-release pointer, as a version. */
  readonly githubLatest?: string;
  /** The accepted list, for the consumer to remember. */
  readonly list?: {
    readonly sequence: number;
    readonly expiresAt: string;
  };
}

const MAX_LIST_BYTES = 4 * 1024 * 1024;

function listFromBundle(input: DiscoverInput, bundle: Uint8Array): ReleaseList {
  const list = input.verifyList(bundle);
  if (list.project !== input.project.name)
    throw new PackslipError(
      'PROJECT_MISMATCH',
      `The signed release list is for ${shown(list.project)}, not ${input.project.name}`,
    );
  assertListFresh(list, input.now);
  assertListSequence(list, input.memory?.sequence);
  return list;
}

function subjectDigest(list: ReleaseList, url: string): string | undefined {
  return list.subjects.find((subject) => subject.name === url)?.sha256;
}

/** Candidates a signed list describes on its own, for a project with no forge. */
function listCandidates(list: ReleaseList): Candidate[] {
  return list.releases.map((entry) => {
    const bundleSha256 = subjectDigest(list, entry.packslip);
    return {
      version: entry.version,
      ...(entry.tag !== undefined && { tag: entry.tag }),
      bundleUrl: entry.packslip,
      ...(bundleSha256 !== undefined && { bundleSha256 }),
      yanked: entry.yanked,
      ...(entry.statusReason !== undefined && {
        yankReason: entry.statusReason,
      }),
      security: entry.security,
    };
  });
}

/**
 * Lay a signed list over what GitHub's endpoint found. For a listed version
 * the entry's tag, status and security flag apply, and only the bundle whose
 * digest the list pins is accepted; versions the list omits stay discoverable
 * through the endpoint. A list entry can also expose a release whose tag names
 * no version.
 */
function overlay(
  project: Project,
  base: readonly Candidate[],
  list: ReleaseList,
  endpoints: GithubEndpoints,
): Candidate[] {
  const byVersion = new Map(
    base.map((candidate) => [candidate.version, candidate]),
  );
  for (const entry of list.releases) {
    const existing = byVersion.get(entry.version);
    const bundleSha256 = subjectDigest(list, entry.packslip);
    const tag = entry.tag ?? existing?.tag;
    byVersion.set(entry.version, {
      version: entry.version,
      ...(tag !== undefined && { tag }),
      bundleUrl:
        existing?.bundleUrl ??
        (entry.tag === undefined
          ? entry.packslip
          : githubBundleUrl(project, entry.tag, endpoints)),
      ...(bundleSha256 !== undefined && { bundleSha256 }),
      yanked: entry.yanked,
      ...(entry.statusReason !== undefined && {
        yankReason: entry.statusReason,
      }),
      security: entry.security,
    });
  }
  return [...byVersion.values()];
}

/**
 * Find the releases a project has.
 *
 * A GitHub project is read from the repository's releases endpoint, optionally
 * overlaid by a signed list on its default branch. Any other project lives on a
 * domain its vendor controls and must publish a signed list at the well-known
 * URL: with none, the project is refused rather than guessed at.
 */
export async function discover(input: DiscoverInput): Promise<Discovery> {
  const { project, fetcher } = input;
  const endpoints = input.endpoints ?? GITHUB_ENDPOINTS;

  if (project.forge === 'github') {
    const releases = await listGithubReleases(fetcher, project, endpoints);
    const base = githubCandidates(project, releases, endpoints);
    const bytes = await fetchGithubList(fetcher, project, endpoints);
    let candidates: Candidate[] = [...base];
    let list: ReleaseList | undefined;
    if (bytes === undefined) {
      // Falling back to the endpoint alone would silently undo signed withdrawals.
      if (input.memory?.used === true)
        throw new PackslipError(
          'LIST_MISSING',
          `${project.name} published a signed release list before and it is now missing`,
        );
    } else {
      list = listFromBundle(input, bytes);
      candidates = overlay(project, base, list, endpoints);
    }
    const latestTag = await githubLatestTag(fetcher, project, endpoints);
    const githubLatest =
      latestTag === undefined
        ? undefined
        : (candidates.find((candidate) => candidate.tag === latestTag)
            ?.version ?? versionFromTag(project, latestTag));
    return {
      candidates,
      ...(list?.latest !== undefined && { signedLatest: list.latest }),
      ...(githubLatest !== undefined && { githubLatest }),
      ...(list !== undefined && {
        list: { sequence: list.sequence, expiresAt: list.expiresAt },
      }),
    };
  }

  if (project.forge === 'gitlab')
    throw new PackslipError(
      'UNAVAILABLE',
      `${project.name} is a GitLab project; the specification defines no discovery endpoint for GitLab, so releases must come from a signed release list`,
    );

  const url = listUrl(project);
  const response = await fetcher.get(url, { maxBytes: MAX_LIST_BYTES });
  if (response.status === 404)
    throw new PackslipError(
      'NO_RELEASE',
      `${project.name} publishes no signed release list at ${url}; opm will not guess download URLs`,
    );
  if (response.status !== 200)
    throw new PackslipError(
      'UNAVAILABLE',
      `${url} answered ${response.status}`,
    );
  const list = listFromBundle(input, response.bytes);
  return {
    candidates: listCandidates(list),
    ...(list.latest !== undefined && { signedLatest: list.latest }),
    list: { sequence: list.sequence, expiresAt: list.expiresAt },
  };
}

/**
 * Decode a verified list payload; the verifier callback uses this. It is held
 * to what a signed document may cost (`parseSignedPayload`).
 */
export function parseListPayload(payload: string) {
  return parseSignedPayload(payload);
}

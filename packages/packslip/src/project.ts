import { PackslipError } from './errors.js';
import { shown } from './shown.js';

/** Where a project's name says it lives, and so who may sign for it. */
export type Forge = 'github' | 'gitlab' | 'other';

/**
 * A packslip project name: the host, and optionally a path, of the thing a
 * release describes (`github.com/jdx/mise`, `mise.jdx.dev`). The name is the
 * location and, on a forge, says which repository may sign — but a forge name
 * can change hands, so the repository ID, not this name, is the identity pin.
 */
export interface Project {
  readonly name: string;
  readonly host: string;
  readonly segments: readonly string[];
  readonly forge: Forge;
  /** `owner/repo` on GitHub, the whole path on GitLab; absent elsewhere. */
  readonly repository?: string;
  /** The tool within a GitHub monorepo (`oxlint` in `oxc-project/oxc/oxlint`). */
  readonly subpath?: string;
}

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITLAB_ISSUER = 'https://gitlab.com';

const HOST =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;
/**
 * Path segments end up in URLs and file names. Anything outside this set is
 * refused rather than escaped: a forge accepts no other characters in an
 * owner or repository name, and a vendor domain has no need of them.
 */
const SEGMENT = /^[A-Za-z0-9._~+-]+$/u;

function invalid(name: string, why: string): PackslipError {
  return new PackslipError(
    'INVALID_INPUT',
    `Invalid project name "${shown(name)}": ${why}`,
  );
}

export function parseProject(name: string): Project {
  if (name === '') throw invalid(name, 'it is empty');
  if (name.includes('://'))
    throw invalid(name, 'it must not have a URL scheme');
  if (name.endsWith('/')) throw invalid(name, 'it must not end with a slash');
  const parts = name.split('/');
  const host = parts[0] ?? '';
  const segments = parts.slice(1);
  if (!HOST.test(host))
    throw invalid(name, 'the host must be lowercase and contain a dot');
  for (const segment of segments) {
    if (segment === '') throw invalid(name, 'it has an empty path segment');
    if (segment === '.' || segment === '..')
      throw invalid(name, `it has a "${shown(segment)}" path segment`);
    if (!SEGMENT.test(segment))
      throw invalid(
        name,
        `"${shown(segment)}" has characters a project name cannot carry`,
      );
  }
  if (host === 'github.com') {
    const [owner, repo, ...rest] = segments;
    if (owner === undefined || repo === undefined)
      throw invalid(name, 'a GitHub project is github.com/<owner>/<repo>');
    return {
      name,
      host,
      segments,
      forge: 'github',
      repository: `${owner}/${repo}`,
      ...(rest.length > 0 && { subpath: rest.join('/') }),
    };
  }
  if (host === 'gitlab.com') {
    if (segments.length < 2)
      throw invalid(name, 'a GitLab project is gitlab.com/<group>/<project>');
    return {
      name,
      host,
      segments,
      forge: 'gitlab',
      repository: segments.join('/'),
    };
  }
  return { name, host, segments, forge: 'other' };
}

/**
 * Accepts what a person types: `owner/repo` means GitHub, anything with a
 * dotted first segment is already a project name. A scheme is not stripped —
 * pasting a URL where a name belongs is a mistake worth surfacing.
 */
export function parseProjectInput(text: string): Project {
  const first = text.split('/')[0] ?? '';
  if (!first.includes('.') && !text.includes('://') && text.includes('/'))
    return parseProject(`github.com/${text}`);
  return parseProject(text);
}

export function forgeIssuer(forge: Forge): string | undefined {
  if (forge === 'github') return GITHUB_ISSUER;
  if (forge === 'gitlab') return GITLAB_ISSUER;
  return undefined;
}

/** The web URL of the repository a forge project names. */
export function repositoryUrl(project: Project): string | undefined {
  if (project.repository === undefined) return undefined;
  return `https://${project.host}/${project.repository}`;
}

/**
 * The bundle a release asset carries for this project. When several tools of
 * one repository share a release, each ships its own `packslip.<subpath>`
 * bundle; consumers still choose by the signed statement, not this name.
 */
export function bundleFileName(project: Project): string {
  return project.subpath === undefined
    ? 'packslip.sigstore.json'
    : `packslip.${project.subpath.replaceAll('/', '-')}.sigstore.json`;
}

/**
 * Where a project hosted on its own domain publishes its signed release list,
 * or where another publisher keeps a list it maintains for `project`.
 */
export function listUrl(project: Project, publisherHost?: string): string {
  const path = project.segments.join('/');
  if (publisherHost !== undefined && publisherHost !== project.host)
    return `https://${publisherHost}/.well-known/packslip/${project.name}.json`;
  return path === ''
    ? `https://${project.host}/.well-known/packslip.json`
    : `https://${project.host}/.well-known/packslip/${path}.json`;
}

/**
 * The repository-relative path of a GitHub supplementary list on the default
 * branch, served from `raw.githubusercontent.com`.
 */
export function githubListPath(project: Project): string {
  return project.subpath === undefined
    ? '.well-known/packslip.json'
    : `.well-known/packslip/${project.subpath}.json`;
}

export function githubListUrl(project: Project): string | undefined {
  if (project.forge !== 'github' || project.repository === undefined)
    return undefined;
  return `https://raw.githubusercontent.com/${project.repository}/HEAD/${githubListPath(project)}`;
}

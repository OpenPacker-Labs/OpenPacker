import type { Project } from './project.js';
import { isSemver } from './version.js';

const SEPARATORS = ['/', '-', '_', '@'];

/**
 * Prefixes a tag may carry for this project, longest first: the tool's full
 * subpath, the last segment of that subpath, or the repository name.
 */
function allowedPrefixes(project: Project): string[] {
  const prefixes = new Set<string>();
  if (project.subpath !== undefined) {
    prefixes.add(project.subpath);
    const last = project.subpath.split('/').pop();
    if (last !== undefined) prefixes.add(last);
  }
  const repoName = project.repository?.split('/').pop();
  if (repoName !== undefined) prefixes.add(repoName);
  return [...prefixes].sort((left, right) => right.length - left.length);
}

function stripLeadingZeros(component: string): string {
  const stripped = component.replace(/^0+(?=\d)/u, '');
  return stripped === '' ? '0' : stripped;
}

/**
 * The spelling rules for a version a vendor wrote another way: a missing
 * patch is `0` (`4.1` is `4.1.0`) and leading zeros go (`25.07.1` is
 * `25.7.1`). A single component is not a version — `v4` is the moving major
 * tag many projects keep, and reading it as `4.0.0` would collide with the
 * real `v4.0.0` release.
 */
function spell(text: string): string | undefined {
  const match =
    /^(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/u.exec(
      text,
    );
  if (match === null) return undefined;
  const [, major, minor, patch, prerelease, build] = match;
  if (major === undefined || minor === undefined) return undefined;
  const core = [major, minor, patch ?? '0'].map(stripLeadingZeros).join('.');
  const spelled =
    core +
    (prerelease === undefined ? '' : `-${prerelease}`) +
    (build === undefined ? '' : `+${build}`);
  return isSemver(spelled) ? spelled : undefined;
}

/**
 * The version a forge tag names, or `undefined` when it names none (`nightly`,
 * `release-1.2.3`). Deriving it lets a consumer list a project's releases from
 * tags alone; the signed packslip inside the release stays the authority and
 * a release whose signed version disagrees is refused.
 */
export function versionFromTag(
  project: Project,
  tag: string,
): string | undefined {
  let rest = tag;
  for (const prefix of allowedPrefixes(project)) {
    const separator = SEPARATORS.find((candidate) =>
      rest.startsWith(`${prefix}${candidate}`),
    );
    if (separator !== undefined) {
      rest = rest.slice(prefix.length + separator.length);
      break;
    }
  }
  if (rest.startsWith('v')) rest = rest.slice(1);
  return spell(rest);
}

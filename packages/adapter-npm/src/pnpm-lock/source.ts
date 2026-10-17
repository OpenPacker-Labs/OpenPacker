/**
 * The syntactic forms a pnpm lock uses for where a package comes from: a
 * version, a path, a URL, an integrity digest. Recognising a form is all this
 * does. Nothing here fetches, resolves a name or decides whether a source is
 * allowed; the policy that reads the model does that.
 */

import { OverlongHostError, parseUntrustedUrl } from '@openpacker/canonical';
import { unsafeNameProblem } from '../layout-plan.js';

/** Where a `name@version` says the package comes from. */
export type SourceKind = 'registry' | 'file' | 'tarball' | 'git' | 'runtime';

/** Semantic Versioning 2.0.0, as semver.org gives it. */
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/u;

export function isSemver(value: string): boolean {
  return SEMVER.test(value);
}

/**
 * What is wrong with `name` as a package name, or undefined. A name that is an
 * address is reported without being repeated: it is the front of a key whose
 * `@` ended it, so the user information would be quoted and its `@` would not.
 */
export function packageNameProblem(name: string): string | undefined {
  return name.includes('://')
    ? 'an address is not an npm package name'
    : unsafeNameProblem(name);
}

const GIT_COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** A full commit hash, SHA-1 or SHA-256 object format. */
export function isGitCommit(value: string): boolean {
  return GIT_COMMIT.test(value);
}

/** Characters that have no business in a path or URL a lock records. */
function hasControlCharacter(value: string): boolean {
  for (let at = 0; at < value.length; at += 1) {
    const code = value.charCodeAt(at);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * What is wrong with a path a lock records relative to the project, or
 * undefined. `..` is allowed (a link may leave the workspace; the model reports
 * where it lands); a path that is absolute, uses a backslash or holds a control
 * character is not something pnpm writes.
 */
export function relativePathProblem(path: string): string | undefined {
  if (path === '') return 'is empty';
  if (hasControlCharacter(path)) return 'holds a control character';
  if (path.includes('\\')) return 'uses a backslash';
  if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:/u.test(path))
    return 'is absolute, and a lock records paths relative to the project';
  return undefined;
}

/**
 * What is wrong with a path that must stay inside the project (an importer id,
 * a publish directory, a patch file), or undefined. Stricter than
 * `relativePathProblem`: no `..`, no empty or `.` segment unless the path is
 * exactly `.` and `allowDot` says so.
 */
export function insidePathProblem(
  path: string,
  allowDot: boolean,
): string | undefined {
  const problem = relativePathProblem(path);
  if (problem !== undefined) return problem;
  if (path === '.') return allowDot ? undefined : 'is the project itself';
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.'))
    return 'is not a normalized path (empty or "." segment)';
  if (segments.includes('..')) return 'leaves the project';
  return undefined;
}

/**
 * What is wrong with a URL or SCP-style git address a lock records, or
 * undefined. A password or token in the address is a secret in the lock (and in
 * every log line that quotes it): an http(s) tarball may name no user at all, a
 * git address only the conventional `git` (or, over ssh, any user without a
 * password).
 */
export function urlProblem(
  value: string,
  scheme: 'http' | 'git',
): string | undefined {
  if (value === '' || hasControlCharacter(value) || /\s/u.test(value))
    return 'is empty or holds whitespace or a control character';
  const marker = value.indexOf('://');
  if (marker === -1) {
    if (
      scheme === 'git' &&
      /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/u.test(value)
    )
      return value.startsWith('git@')
        ? undefined
        : 'names a user other than "git"';
    return 'is not a URL';
  }
  const afterScheme = value.slice(marker + 3);
  const authorityEnd = afterScheme.search(/[/?#]/u);
  const authority =
    authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  if (authority === '') return 'has no host';
  const at = authority.lastIndexOf('@');
  if (at === -1) return undefined;
  const user = authority.slice(0, at);
  if (user.includes(':')) return 'carries a password in the address';
  const overSsh = value.slice(0, marker).toLowerCase() === 'ssh';
  if (scheme === 'http' || (user !== 'git' && !overSsh))
    return 'carries a user name or credentials in the address';
  return undefined;
}

/** A tarball URL: `http` or `https`, a host, no credentials. */
export function tarballUrlProblem(value: string): string | undefined {
  if (!/^https?:\/\//iu.test(value)) return 'is not an http or https URL';
  const problem = urlProblem(value, 'http');
  if (problem !== undefined) return problem;
  try {
    // The text is the lock's, so it is read through the guard (ADR 0044).
    parseUntrustedUrl(value);
  } catch (error) {
    return error instanceof OverlongHostError
      ? 'names a host longer than 253 characters'
      : 'is not a URL';
  }
  return undefined;
}

/**
 * The form of a version in a `name@version` key: which source it names, or a
 * problem. `file:` and `runtime:` carry a path or a version; `git+` carries an
 * address and the commit it was pinned to, as pnpm's `createGitHostedPkgId`
 * writes it: `git+<repo>#<commit>`, then `&path:<subdirectory>` if any.
 */
export function classifyVersion(
  version: string,
): { kind: SourceKind } | { problem: string } {
  if (isSemver(version)) return { kind: 'registry' };
  if (version.startsWith('runtime:'))
    return isSemver(version.slice(8))
      ? { kind: 'runtime' }
      : { problem: 'names a runtime without an exact version' };
  if (version.startsWith('file:')) {
    const problem = relativePathProblem(version.slice(5));
    return problem === undefined
      ? { kind: 'file' }
      : { problem: `file: path ${problem}` };
  }
  if (version.startsWith('git+')) {
    const hash = version.indexOf('#');
    if (hash === -1)
      return { problem: 'names a git repository without a commit' };
    const repo = version.slice(4, hash);
    const commit = version.slice(hash + 1).split('&path:', 1)[0] ?? '';
    const problem = urlProblem(repo, 'git');
    if (problem !== undefined) return { problem: `git address ${problem}` };
    if (!GIT_COMMIT.test(commit))
      return { problem: 'names a git commit that is not a full hash' };
    return { kind: 'git' };
  }
  if (/^https?:\/\//iu.test(version)) {
    const problem = tarballUrlProblem(version);
    return problem === undefined
      ? { kind: 'tarball' }
      : { problem: `tarball URL ${problem}` };
  }
  return {
    problem:
      'is not a version, a file:, a git+ address, an http(s) URL or a runtime:',
  };
}

const DIGEST_BYTES: Readonly<Record<string, number>> = {
  sha1: 20,
  sha256: 32,
  sha384: 48,
  sha512: 64,
};

/**
 * What is wrong with an `integrity` value, or undefined: one Subresource
 * Integrity token, `<algorithm>-<base64>`, whose canonical base64 decodes to the
 * algorithm's digest length. The algorithms are the ones the install proves
 * bytes with (ADR 0046): sha512, sha384, sha256 and sha1.
 */
export function integrityProblem(value: string): string | undefined {
  const dash = value.indexOf('-');
  const algorithm = dash === -1 ? value : value.slice(0, dash);
  const expected = Object.hasOwn(DIGEST_BYTES, algorithm)
    ? DIGEST_BYTES[algorithm]
    : undefined;
  if (expected === undefined)
    return `is not a sha1, sha256, sha384 or sha512 digest`;
  const encoded = value.slice(dash + 1);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded))
    return 'is not base64 (one digest, no options)';
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== expected || bytes.toString('base64') !== encoded)
    return `is not a canonical base64 ${algorithm} digest of ${expected} bytes`;
  return undefined;
}

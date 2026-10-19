/**
 * What the right-hand side of a dependency entry asks npm to do.
 *
 * Anything that is not a version range and not a recognizable source is a
 * dist-tag, as npm reads it.
 */

import { parseNpmRange } from './npm-range.js';

export type NpmDependencySpecKind =
  | 'range'
  | 'tag'
  | 'alias'
  | 'git'
  | 'url'
  | 'file'
  | 'workspace';

const GIT_SPEC =
  /^(?:git(?:\+[a-z]+)?:|github:|gitlab:|bitbucket:|gist:|git@)/iu;
const GITHUB_SHORTHAND = /^[\w.-]+\/[\w.-]+(?:#.+)?$/u;

/** Read a dependency specifier the way npm does. */
export function classifyDependencySpec(spec: string): NpmDependencySpecKind {
  const value = spec.trim();
  if (value.startsWith('npm:')) return 'alias';
  if (value.startsWith('workspace:')) return 'workspace';
  if (
    /^(?:file|link|portal):/iu.test(value) ||
    /^(?:\.{1,2}\/|\/|~\/)/u.test(value)
  )
    return 'file';
  if (GIT_SPEC.test(value) || GITHUB_SHORTHAND.test(value)) return 'git';
  if (/^https?:\/\//iu.test(value)) return 'url';
  try {
    parseNpmRange(value);
    return 'range';
  } catch {
    return 'tag';
  }
}

/**
 * Whether npm reads `tag` as a dist-tag name at all: npm-package-arg@14.0.0
 * (`lib/npa.js` 468-469) refuses one that `encodeURIComponent` would change
 * ("Invalid tag name ... Tags may not have any characters that
 * encodeURIComponent encodes").
 */
export function isNpmTagName(tag: string): boolean {
  return tag !== '' && encodeURIComponent(tag) === tag;
}

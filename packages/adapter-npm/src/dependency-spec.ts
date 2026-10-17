/**
 * What the right-hand side of a dependency entry asks npm to do, and how a
 * message names one.
 *
 * Anything that is not a version range and not a recognizable source is a
 * dist-tag, as npm reads it.
 */

import { safeEcho } from '@openpacker/canonical';
import { NPM_NAME_LIMIT } from './packument-limits.js';
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
 * How a dependency is named in a message.
 *
 * A dependency's name and range come from a registry's document, and a message
 * about them goes to a terminal and into a report. `safeEcho` drops an escape
 * sequence, a line break and every other control character, and cuts what is
 * long, saying how long it was. Text that has none of those is returned as it
 * is, so an ordinary dependency reads as it always did.
 */

/** A range is short, though npm sets no limit; a git URL with a ref is not. */
const RANGE_LIMIT = 200;
/** A package's name, `@`, and a version. */
const OWNER_LIMIT = NPM_NAME_LIMIT + 1 + 64;
/** What an error said of the entry, which may itself repeat a name. */
const REASON_LIMIT = 512;

/** A dependency name, as a message says it. */
export function echoedName(name: string): string {
  return safeEcho(name, NPM_NAME_LIMIT);
}

/**
 * An install would walk into a dependency that is not a registry range, with
 * why an `npm:` alias is not one npm would install when that is the reason
 * (`parseNpmAlias`'s problem, which repeats the specifier it read).
 */
export function unsupportedSpec(
  owner: string,
  name: string,
  range: string,
  specKind: string,
  problem?: string,
): string {
  return (
    `${safeEcho(owner, OWNER_LIMIT)} depends on ${echoedName(name)} as ` +
    `"${safeEcho(range, RANGE_LIMIT)}", a ${specKind} specifier ` +
    `that is not a registry version range` +
    (problem === undefined ? '' : ` (${safeEcho(problem, REASON_LIMIT)})`)
  );
}

/** What is recorded of a specifier that is not a range, and is not walked. */
export function specifierNotARange(specKind: string, range: string): string {
  return `The ${specKind} specifier "${safeEcho(range, RANGE_LIMIT)}" is not a registry version range`;
}

/** What is recorded of an entry that could not be read, and is not walked. */
export function entryNotRepresentable(
  field: string,
  name: string,
  range: string,
  reason: string,
): string {
  return (
    `The ${field} entry "${echoedName(name)}": "${safeEcho(range, RANGE_LIMIT)}" ` +
    `cannot be represented: ${safeEcho(reason, REASON_LIMIT)}`
  );
}

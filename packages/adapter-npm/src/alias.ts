/**
 * `npm:` aliases, read the way `npm-package-arg` reads them.
 *
 * `"string-width-cjs": "npm:string-width@^4.2.0"` installs the registry package
 * `string-width` in a directory called `string-width-cjs`. The directory (the
 * dependency key) is the install name; the package is the target, and its own
 * `package.json` keeps saying `string-width`. Everything the registry,
 * the policy and the solver need to know is about the target, so an alias is
 * read once, here, into the target's name and what was asked of it.
 */

import { classifyDependencySpec, isNpmTagName } from './dependency-spec.js';
import { safeEcho } from '@openpacker/canonical';

/** What an `npm:` specifier asks the registry for. */
export interface NpmAlias {
  /** The registry package that is installed: `string-width`, `@scope/name`. */
  target: string;
  /**
   * What was asked of it, in npm's grammar: a version or range, or a dist-tag.
   * `*` when the specifier names no version (`npm:name`), as npm reads it.
   */
  spec: string;
  /** `tag` when `spec` names a dist-tag, which the registry has to resolve. */
  kind: 'range' | 'tag';
}

export interface NpmAliasProblem {
  problem: string;
}

/** Whether a dependency value is spelled as an alias at all. */
export function isNpmAlias(value: string): boolean {
  return value.trim().startsWith('npm:');
}

/**
 * Read an alias, or say why it is not one npm would install.
 *
 * npm refuses an alias of an alias, an alias with no name, and an alias of
 * anything but a registry package ("aliases only work for registry deps"). So
 * does this; the caller decides whether that is an error or a note.
 */
export function parseNpmAlias(value: string): NpmAlias | NpmAliasProblem {
  const text = value.trim();
  if (!text.startsWith('npm:')) return { problem: 'it is not an npm: alias' };
  const body = text.slice('npm:'.length);
  if (body === '') return { problem: 'an alias must name a package' };
  if (body.startsWith('npm:'))
    return { problem: 'an alias of an alias is not supported' };
  // The name ends at the first `@` that is not the scope's own.
  const separator = body.indexOf('@', body.startsWith('@') ? 1 : 0);
  const name = separator === -1 ? body : body.slice(0, separator);
  const spec = separator === -1 ? '' : body.slice(separator + 1).trim();
  if (name === '') return { problem: 'an alias must name a package' };
  if (!/^(?:@[^/\s@:]+\/)?[^@/\s:]+$/u.test(name))
    return {
      problem: `${JSON.stringify(name)} is not a registry package name`,
    };
  if (spec === '') return { target: name, spec: '*', kind: 'range' };
  const kind = classifyDependencySpec(spec);
  if (kind === 'range') return { target: name, spec, kind: 'range' };
  if (kind === 'tag')
    return isNpmTagName(spec)
      ? { target: name, spec, kind: 'tag' }
      : { problem: `"${spec}" is not a dist-tag name npm reads` };
  return {
    problem:
      kind === 'alias'
        ? 'an alias of an alias is not supported'
        : `aliases only work for registry packages, and ${JSON.stringify(safeEcho(spec))} is a ${kind} specifier`,
  };
}

/** The specifier an alias is written as, from its parts. */
export function formatNpmAlias(target: string, spec: string | undefined) {
  return `npm:${target}@${spec === undefined || spec === '' ? '*' : spec}`;
}

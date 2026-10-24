/**
 * What a directory in `node_modules` may be called.
 *
 * A name comes from a registry (a package's own, or the key an alias is written
 * under), becomes a path under a recursive delete, and has to name one
 * directory on the filesystems it is written to.
 */

import { redactText } from '@openpacker/adapter-core';

/**
 * `text` as JSON, with every character a terminal would not show written out
 * (`\u{200b}`). JSON leaves the controls from DEL up, the format characters and
 * U+2028 as they are, and what writes an error removes them, so a name with a
 * zero-width character in it would read as the plain name beside it and the
 * message ("member" is not a safe directory name) would look untrue.
 */
export function quoted(text: string): string {
  // An address in it is shown as every address is shown, which is plain text.
  return JSON.stringify(redactText(text)).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u{${character.codePointAt(0)?.toString(16) ?? ''}}`,
  );
}

/**
 * Why a registry-supplied name is not a safe directory name, or undefined.
 *
 * A name becomes a path under a recursive delete, and a leading dot would let a
 * package replace `.bin`, so this is stricter than the registry's own rules.
 */
export function unsafeNameProblem(name: string): string | undefined {
  const segments = name.split('/');
  const scoped = name.startsWith('@');
  if (segments.length !== (scoped ? 2 : 1))
    return `${quoted(name)} is not an npm package name`;
  for (const [index, segment] of segments.entries()) {
    const body = scoped && index === 0 ? segment.slice(1) : segment;
    if (
      body === '' ||
      body.startsWith('.') ||
      body.toLowerCase() === 'node_modules' ||
      !/^[A-Za-z0-9._~+-]+$/u.test(body)
    )
      return `${quoted(name)} is not a safe directory name for node_modules`;
  }
  return undefined;
}

/**
 * What the case check says of something that takes a directory: a package by
 * `name@version`, or, with a `label`, anything else (a member link).
 */
export interface Occupant {
  name: string;
  version: string;
  label?: string;
}

const labelOf = (occupant: Occupant): string =>
  occupant.label ?? `${occupant.name}@${occupant.version}`;

/** What the case check needs to know of a placed package. */
interface Placed {
  installName: string;
  entry: Occupant | undefined;
}

/**
 * The directory beside which `name` would be written whose name differs from it
 * only by case. Two such names are one directory on a case-insensitive
 * filesystem (the default on macOS and Windows), and the second write would
 * replace the first without a word.
 */
export function caseVariant<T extends Placed>(
  parent: { children: ReadonlyMap<string, T> },
  name: string,
): T | undefined {
  const folded = name.toLowerCase();
  for (const [other, child] of parent.children)
    if (other !== name && other.toLowerCase() === folded) return child;
  return undefined;
}

export function caseCollision(
  entry: Occupant,
  name: string,
  variant: Placed,
): string {
  return `${labelOf(entry)} would be installed as ${name}, which differs only by case from ${variant.installName} (${labelOf(variant.entry!)}) in the same directory; they are one directory on a case-insensitive filesystem`;
}

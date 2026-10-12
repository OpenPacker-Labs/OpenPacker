import { safeEcho } from '@openpacker/canonical';
import { NPM_NAME_LIMIT } from './packument-limits.js';

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

/** An install would walk into a dependency that is not a registry range. */
export function unsupportedSpec(
  owner: string,
  name: string,
  range: string,
  specKind: string,
): string {
  return (
    `${safeEcho(owner, OWNER_LIMIT)} depends on ${echoedName(name)} as ` +
    `"${safeEcho(range, RANGE_LIMIT)}", a ${specKind} specifier ` +
    `that is not a registry version range`
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
